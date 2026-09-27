# 스플렌더 대결 (Splendor Duel) 웹판 — 개발 명세

Static web app (no build step, no server of our own). Two phones on different networks play through three free public MQTT brokers (WSS). Hosted on GitHub Pages; also runs from `file://` and from `tools/serve.js` on a PC.

UI language: Korean. Code comments: Korean or English, short. This file describes what the code does; when they disagree, fix one of them.

## 1. Files

```
index.html                 single page; classic <script defer> tags (NO ES modules, so file:// works); SVG sprite (tokens, pips, icons)
css/style.css
js/vendor/mqtt.min.js      vendored browser build of mqtt.js 5.16.0 (global `mqtt`)
js/cards.js                window.SDCards  = { CARDS, ROYALS }            (data only)
js/engine.js               window.SDEngine = {...}                        (pure rules, no DOM)
js/bot.js                  window.SDBot    = {...}                        (AI for practice mode)
js/net.js                  window.SDNet    = {...}                        (MQTT room sync, no game rules)
js/app.js                  screens, routing, local/online/bot modes, sync glue, rendering, input
assets/icon.svg, icon-192.png, icon-512.png, apple-touch-icon.png; manifest.webmanifest
tools/serve.js             zero-dependency static server for PC play (PORT/HOST env, --tunnel, --open; refuses dot-paths and node_modules)
tools/tunnel.js            internet link: cloudflared quick tunnel (from ./.tunnel, a sibling game folder's .tunnel, or PATH) → localhost.run over ssh
start.bat                  node tools\serve.js --tunnel --open
tests/*.test.js            default suite (npm test): engine, fuzz, bot, net-offline (fake broker), ui-helpers
tests/net/*.test.js        live public-broker tests (npm run test:net; needs internet)
package.json               "test": node --test "tests/*.test.js"; "test:net": node --test "tests/net/*.test.js"; devDependency mqtt
.claude/launch.json        dev-tool preview config (not part of the game; never needs uploading)
README.md                  Korean: how to play, how to put it on GitHub Pages
```

Every `js/*.js` file other than app.js must also work in Node: end with
`if (typeof module !== 'undefined' && module.exports) module.exports = X; else window.X = X;`
(engine.js requires `./cards.js` in Node and reads `window.SDCards` in the browser; bot.js likewise requires `./engine.js`).
app.js, when loaded without a DOM (`require('./js/app.js')`), returns only its pure helper object `H` (see §5) and stops.

## 2. Components & constants

- Gem colors (order used everywhere): `COLORS = ['white','blue','green','red','black']`
- Token types: `TOKENS = ['white','blue','green','red','black','pearl','gold']`
- Token supply: 4 of each gem color, 2 pearls, 3 gold = 25. Privilege scrolls: 3.
- Pyramid: level 3 → 3 slots, level 2 → 4 slots, level 1 → 5 slots.
- Board: 5×5, cell index `i = r*5 + c` (row 0 = top edge, the side facing the privilege supply). Tokens are always placed onto empty cells in SPIRAL order (center, down, left, up, … clockwise, from the rulebook art):
  `SPIRAL = [12,17,16,11,6,7,8,13,18,23,22,21,20,15,10,5,0,1,2,3,4,9,14,19,24]`
- Full rules reference with edge cases: `docs/RULES.md`. When this spec and RULES.md disagree, RULES.md wins.

### Card data (`js/cards.js`)

```js
CARDS: [{ id:'1-01', level:1, bonus:'white'|'blue'|'green'|'red'|'black'|'joker'|null,
          bonusCount:0|1|2, points:int, crowns:int,
          ability:null|'extra_turn'|'bonus_token'|'steal'|'privilege',
          cost:{white,blue,green,red,black,pearl} /* all 6 keys present, 0 if none */ }, ...]   // 67 cards
ROYALS: [{ id:'R1', points:int, ability:null|'extra_turn'|'steal'|'privilege' }, ...]          // 4 cards
```

## 3. Engine (`SDEngine`) — pure functions, JSON-serialisable state

Never mutates its inputs (clone first). All randomness comes from a seeded PRNG (mulberry32) whose state is stored in `state.rng`, so a game is reproducible from its seed + actions.

```js
SDEngine.newGame({ names:[string,string], first:0|1, seed:uint32 }) -> state
SDEngine.apply(state, action) -> { ok:true, state, events:[...] } | { ok:false, error:'한국어 설명' }
SDEngine.legalActions(state) -> action[]         // every legal action for state.turn.player (used by bot + fuzz tests)
SDEngine.stats(state, p) -> { points, crowns, colorPoints:{white..black}, bonuses:{white..black}, tokenCount, tokens, privileges }
SDEngine.cardById(id), SDEngine.royalById(id)
// helpers for the UI:
SDEngine.validateTake(state, cells) -> { ok, error?, privilegeToOpponent? }
SDEngine.takeExtensions(state, cells) -> cellIndices that could be added to the current selection and stay valid
SDEngine.effectiveCost(state, p, cardId) -> {white..black,pearl}   // after bonuses
SDEngine.defaultPayment(state, p, cardId) -> payment | null          // gems first, gold only for shortfall; null if unaffordable
SDEngine.validatePayment(state, p, cardId, payment) -> { ok, error? }
SDEngine.jokerOptions(state, p) -> colors the player can assign a joker to ([] = cannot buy a joker)
SDEngine.mainActionPossible(state) -> boolean
SDEngine.CONSTANTS: { COLORS, TOKENS, SPIRAL, PYRAMID_SIZES:{1:5,2:4,3:3}, MAX_TOKENS:10, MAX_RESERVED:3, PRIVILEGES:3,
                      ROYAL_CROWNS:[3,6], WIN_POINTS:20, WIN_CROWNS:10, WIN_COLOR_POINTS:10, LOG_MAX:60, TOKEN_NAMES_KO }
```

### State

```js
{
  v: 1,
  rng: uint32,
  board: [25 × (null | tokenType)],
  bag: { white..gold: int },                      // unordered; drawing = pick uniformly at random per token
  decks: { 1:[cardId...], 2:[...], 3:[...] },     // top of deck = last element
  pyramid: { 1:[5 × cardId|null], 2:[4 × ...], 3:[3 × ...] },
  royals: [royalId...],                           // still available
  privilegeSupply: int,
  players: [ { name, tokens:{white..gold}, cards:[cardId...], jokerColor:{cardId:color}, reserved:[{id, fromDeck:bool}],
               royals:[royalId...], privileges:int } × 2 ],
  turn: { player:0|1, number:int, replenished:bool, mainDone:bool, extraTurn:bool },
  pending: [ decision... ],                       // head = what the active player must resolve now
  over: null | { winner:0|1, reason:'points'|'crowns'|'color'|'resign', color? },
  log: [ event... ]                               // last LOG_MAX (60) events
}
```

### Actions (all by `state.turn.player`)

Optional actions — only before the main action (`turn.mainDone === false`, `pending` empty), and in this fixed order (rulebook p.4 + Dized FAQ):
- `{type:'usePrivilege', cell}` — only while `turn.replenished === false`; may repeat once per scroll held. Spend 1 privilege (back to supply), take the gem/pearl (never gold) at `cell`. No penalty, no line rule.
- `{type:'replenish'}` — bag must be non-empty; sets `turn.replenished = true` (so no more privileges this turn). Draw bag tokens uniformly at random (seeded rng) onto empty cells in SPIRAL order until the bag is empty; then the opponent gains 1 privilege.
- If no main action is possible, the player must replenish before the main action (UI says so; `legalActions` then offers only `replenish`, or `pass` if the bag is empty too).

Main action (exactly one per turn, then `mainDone = true`):
- `{type:'take', cells:[1..3 indices]}` — gems/pearls only (no gold), all in one straight line (row, column, diagonal) and contiguous. 3 of the same color, or both pearls → opponent gains 1 privilege.
- `{type:'reserve', source:{from:'pyramid', level, slot} | {from:'deck', level}, goldCell}` — needs < 3 reserved, a gold at `goldCell` (taken, no line rule) and a card at the source. Pyramid slot is refilled from its deck (stays empty if the deck is empty).
- `{type:'buy', source:{from:'pyramid', level, slot} | {from:'reserved', index}, payment:{white..gold}, jokerColor?}` — payment must exactly cover `effectiveCost` (gold stands in for any missing gem or pearl, no overpaying). Spent tokens go to the bag. Pyramid slot refilled. Joker cards need `jokerColor` ∈ `jokerOptions`.
- `{type:'pass'}` — only legal when no main action is possible and the bag is empty.

Pending decisions (only the head is actionable):
- `{kind:'bonusToken', color}` → `{type:'bonusToken', cell}`   (auto-skipped when no such token on the board)
- `{kind:'steal'}` → `{type:'steal', token}`                   (gem or pearl the opponent holds; auto-skipped when none)
- `{kind:'royal'}` → `{type:'royal', id}`
- `{kind:'discard', count}` → `{type:'discard', tokens:{...}}` (exactly `count` tokens back to the bag)

Also always legal for either player in online play: `{type:'resign', player}`.

### Turn resolution

After the main action, in this order (player aid, rulebook p.12):
1. the bought card's ability (privilege and extra turn are automatic; bonus token / steal become pending decisions and are skipped automatically when impossible; the L3 joker+extra-turn card: joker color is chosen in the buy action, then the extra turn);
2. royal cards — when the player's crowns reach 3, and again at 6, they take one available royal (pending `royal`) and its ability resolves at once (a royal steal becomes a pending `steal`);
3. token limit — more than 10 tokens (gems + pearls + gold) → pending `discard` of the excess, back to the bag;
4. victory check — 20+ points (cards + royals), or 10+ crowns, or 10+ points on cards of one bonus color (a joker counts as its assigned color; no-bonus cards and royals count for no color) → `over`;
5. next turn — the same player again if an extra turn was earned (a single flag, not a counter), otherwise the opponent. `turn` resets (`replenished`, `mainDone`, `extraTurn` false; `number` +1).

Privilege gain rule (every source: take-penalty, replenish, ability, royal): from the supply; if the supply is empty, from the opponent; if the player already has all 3, nothing.

Joker rules: may only be bought when the player owns a card with a bonus; it gives exactly 1 bonus of the chosen color (even on a double-bonus card); its points count toward that color. Bonuses reduce gem costs to a minimum of 0; pearl costs are never reduced. A player may choose to pay with gold even when holding the matching gem.

Setup: shuffle each level deck, deal pyramid (3×L3, 4×L2, 5×L1), shuffle all 25 tokens onto the board in SPIRAL order (bag starts empty), 4 royals face up, supply 3 privileges, first player as given, the other player takes 1 privilege from the supply.

### Events (in `apply` result and `state.log`)

`{t:'privilege'|'replenish'|'take'|'reserve'|'buy'|'bonusToken'|'steal'|'gainPrivilege'|'royal'|'discard'|'extraTurn'|'win'|'resign'|'pass'|'turn', p, turnNo, ...details}` — every event carries the `turnNo` it happened in; `turn` is `{t:'turn', p:nextPlayer, number, extra}`. Details carry cells/tokens/card ids so the UI can highlight what just happened and write a Korean log line (`describe()` in app.js).

## 4. Online sync (`SDNet`, `js/net.js`)

Transport: MQTT over WSS to all three public brokers of §6 at once. net.js knows nothing about game rules; it syncs one JSON "room document" per room.

### Topics (prefix `sdkr1/<ROOM>/`)

| topic | retain | QoS | payload |
|---|---|---|---|
| `doc` | yes | 1 | the whole room document |
| `presence/<deviceId>` | yes | 1 | `{online, name, seat, at, seen:{seq,nonce}|null}`; the MQTT will (LWT) is the same with `online:false` |
| `emote` | no | 0 | `{from:deviceId, emote (≤64 chars), at, id}` — sent to every connected broker, de-duplicated by `id` for 60 s |

### Room document

```js
{ app:'sdkr1', room, seq:int, nonce:string, by:deviceId, at:ms,
  parent: {seq, nonce} | null,          // the doc this one was committed on top of
  anc: ['seq:nonce', ...],              // parent first, up to 12 ancestors (lineage checks)
  seats: [ {deviceId, name} | null, {deviceId, name} | null ],
  game: engineState | null,
  prevLoser: 0|1|null }                 // who starts the next game (app-level field)
```

`commit()` fills `app, room, seq, nonce, by, at, parent, anc`; the app supplies `seats, game, prevLoser`.

### Ordering, confirmation and conflicts

- `isNewer(a, b)`: higher `seq` wins; same seq → higher `nonce` string wins (deterministic tie-break). `acceptRemote(d, broker)` adopts a received doc when it is newer than the local one (`adoptRemote`), confirms it when it is the same, and republishes ours to that broker when the broker holds an older doc (self-healing).
- net.js tracks `confirmed` (latest doc known to be on a broker: PUBACK of our publish, or the broker echoing it) and `branch` (my own commits after `confirmed`, not yet confirmed — e.g. made offline or on a stale cache). Both are saved next to the doc (storage below), so a reload keeps them.
- Heal on connect (`onConnect` → `finishHeal`): subscribe, wait for SUBACK (else recreate the client after `healWait + healthTimeout`), announce presence, wait `healWait` (2 s) for the retained doc, then decide. If I have an unconfirmed branch and the broker's retained doc is not mine, not `confirmed`, and not older than `confirmed`, someone else moved on while I was away: the branch is dropped and the broker's doc is adopted **even if its seq is lower**. While a branch exists, the heal push (`flushAll`) waits until every connected broker has finished this check, so an offline commit never overwrites a newer history; then every ready broker whose last-seen doc is missing or older gets ours. (A fresh `commit()` goes straight to the brokers that are already ready; the app only commits while synced.)
- `lineage(r, l)` uses `anc`/`parent`: 1 = r descends from l, 0 = certainly not, -1 = unknown (history longer than 12). When an adopted doc drops branch entries, or does not descend from my last commit (a lost same-seq tie, a takeover beating an old phone), `onDoc(winner, {source:'remote'})` fires first and then `onConflict({lost:[docs, oldest first], winner})`. After a reload, `lost` entries may be stubs `{seq, nonce, parent, anc, by, at}` without `game`.
- An adopted doc is also pushed to other ready brokers that have not seen it (relay between brokers).
- `commit(doc, {jump})`: `seq = current.seq + jump`, `jump` integer 1..5 (default 1, clamped; non-integers count as 1). The app uses `{jump:2}` for resign and seat takeover so they beat an ordinary move committed at the same time. `commit` throws on a malformed doc (see validation).

### Delivery and sync state

- `room.delivery` → `null | {seq, nonce, state, since}` for my latest local commit; `onDelivery(delivery)` fires on every change (including `pending` at commit time, and at join when a reload restored an unconfirmed commit).
  - `pending` — no broker has acked or echoed it; `relayed` — a broker PUBACKed or echoed it; `delivered` — a device in the other seat reports it in presence `seen` (or `seen` is a newer doc descending from it), or the other seat committed on top of it; `superseded` — replaced by a doc that does not descend from it. States only move forward, except into/out of `superseded` (a late PUBACK from a slow broker does not undo `superseded`).
  - Presence carries `seen` = my current doc and is re-announced `announceDebounce` (300 ms) after every doc change, which is what makes `delivered` possible. Presence from my own seat or from seatless viewers never counts.
- `room.synced` (also `status.synced`): false after `join`, after each resume run, and whenever no broker is connected; true once any broker finishes its retained-doc check (`finishHeal`) or a ready broker passes a health check. The app only lets a player move while synced (§5).

### Connection upkeep (mobile-safe)

- Recovery always **recreates the client** (`recreateBroker`: drop listeners, `end(true)`, destroy the stream, new client with a fresh clientId). net.js never calls mqtt.js `reconnect()`, which in mqtt.js 5 opens a second socket while the first is still handshaking. Every handler ignores events from a replaced client (`b.client !== client`). mqtt.js's own `reconnectPeriod` auto-reconnect stays on.
- `room.resume()` and the window `online`/`pageshow` and document `visibilitychange`→visible events all go through `scheduleResume`: a burst runs once, `resumeDebounce` (300 ms) after the last event; within `resumeMinGap` (3 s) of the previous run it only re-announces presence. A run (`runResume`) sets `synced=false`, recreates brokers that have no client or are disconnected (but never touches a handshake in flight: `midAttempt`), and health-checks connected ones.
- Health check (`healthCheck`): publish my presence with QoS 1 and wait `healthTimeout` (4 s) for the PUBACK, else recreate. Also run on `commit()` when the page was hidden for more than `hiddenCheck` (10 s).
- Watchdog (`watchdog`, every `tick` = 5 s): recreate a client that is connected but stuck `disconnecting`, one whose state says connected while the client is not, or one that has been without a connection for > `watchdogStale` (20 s) while the browser is online and no handshake is in flight. The same tick re-announces presence every `presenceEvery` (25 s) and re-evaluates peers.
- Known gap: a silently dead network (no close event) is noticed only by MQTT keepalive (20 s) or a health check, so `status` can read connected+synced for ~20–30 s; a move made then stays `pending` and is published after reconnect.

Timing defaults (`DEFAULT_TIMING`, overridable via `join({timing})`): healWait 2000, presenceEvery 25000, peerStale 70000, tick 5000, repushGap 3000, connectTimeout 8000, reconnectPeriod 2000, keepalive 20 (s), resumeDebounce 300, resumeMinGap 3000, healthTimeout 4000, watchdogStale 20000, hiddenCheck 10000, announceDebounce 300. (`fallbackAfter` is accepted and ignored.)

### Presence and peers

Announced (retained QoS 1) after each SUBACK, every 25 s, after doc changes, on `setPresence`, on resume and as the health-check probe. `leave()` publishes `online:false` before disconnecting; a crash leaves it to the LWT. If an old connection's LWT marks *me* offline, I re-announce. Peers are merged across brokers by deviceId (latest `at` wins; online if fresh on any broker). A peer is online while `online:true` and its `at` is within `peerStale` (70 s), corrected by a clock-skew estimate taken from live (non-retained) presence. `onPeers` fires only when online/name/seat/seen change.

### API

```js
const room = SDNet.join({ room, deviceId, name, seat?,
  onDoc(doc, {source:'cache'|'local'|'remote'}), onPeers(peers), onStatus(status), onEmote({from, emote, at}),
  onDelivery(delivery), onConflict({lost, winner}),
  timing?, brokers?, mqtt?, storage? /* tests: _window, _document */ })
room.room, room.deviceId
room.doc            // latest accepted doc (or null)
room.peers          // { [deviceId]: {online, name, seat, at, seen, self} }  (includes my own entry, self:true)
room.status         // { connected, total:3, brokers:[{name:'emqx'|'coreflux'|'hivemq', url, state:'connecting'|'connected'|'offline'}], synced }
room.synced, room.delivery
room.commit(doc, {jump}?) -> filled doc      // throws if malformed or after leave()
room.emote(str)
room.setPresence({name, seat})
room.resume()       // safe to call any time
room.leave() -> Promise
room._crash(), room._brokers(), room._stats()   // tests only
SDNet.newRoomCode() // 6 chars from 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
SDNet.normalizeRoom(code), SDNet.isRoomCode(code), SDNet.BROKERS, SDNet._internal (pure helpers for tests)
```

Callbacks never run before `join()` returns: the cached doc is delivered in a microtask with `source:'cache'`. `onStatus`/`onPeers` fire only on change.

### Storage

`localStorage['sd.room.<ROOM>']` = latest doc; `localStorage['sd.room.<ROOM>.meta']` = `{tip, c: confirmed 'seq:nonce'|null, b: branch stubs}`. A cached doc without matching meta is treated as confirmed.

### Validation and threat model

The brokers are public: no accounts, no ACLs, TLS only to the broker. Topic names are predictable, and anyone can subscribe to `sdkr1/#` and list every active room, so the room code is an address, not a password. The invite link (`?room=CODE`) contains nothing else.

What net.js checks (`validDoc`, `parsePresence`, `parseEmote`, `acceptRemote`): payload ≤ 200 KB and non-empty, valid JSON; doc `app`/`room` match, `seq` a safe integer 1..1e9, `nonce` 1..64 chars, `seats` a length-2 array of `null | {deviceId 1..64 chars, name string ≤24}`, `game` null or an object with a length-2 `players` array. A remote doc more than 500 seqs ahead of mine is ignored while my doc is younger than 24 h. Presence needs a boolean `online` (name cut to 40 chars, ids ≤64, no `/`); emotes ≤64 chars. Room codes are normalized to `[A-Z0-9]`, so no MQTT wildcards reach a topic.

A stranger **can**: read every room (names, device ids, the full game including cards reserved face down — hiding is UI-only); publish a well-shaped doc that replaces or corrupts the game or the seats (net.js does not check rules, and the app does not re-verify `game` with the engine); fake presence (look online, or claim a `seen` that makes a player's pill say 상대가 받았어요 falsely); send emotes; delete the retained doc with an empty publish (the next heal or commit restores it).
A stranger **cannot**: lock a room with a huge seq (1e9 cap, +500 rule), crash net.js with junk payloads, inject markup (app.js escapes every string with `esc()`), or make the app publish outside `sdkr1/<ROOM>/`. This is accepted for a private game between two people; real protection would need our own authenticated server.

Accepted limitation: if two phones hold different histories on brokers they do not share (a true partition across all three), the unconfirmed branch can reach one broker before another broker shows the other history; the result still converges by the ordering rule and the losing side gets `onConflict`.

## 5. App / UI (`js/app.js`, `index.html`, `css/style.css`)

### Screens

- **홈**: 내 이름, **온라인 방 만들기**, 또는 받은 코드로 참가 (코드 칸 + **참가**), **이어하기** list (the saved hot-seat/bot game plus up to 8 recent rooms from `sd.recent`, each with 대기 중 / 내 차례 / 상대 차례 / 끝난 판 and an × to remove), **한 기기로 둘이 하기**, **봇과 연습하기** (쉬움/보통, 나 먼저/봇 먼저/무작위), footer 규칙 보기 · 소리 켜짐/꺼짐.
- **Invite link** `?room=CODE`: with a saved name the app joins at once. Without one the home screen shows only the **초대받았어요!** card — name field (Enter joins) and **참가하기** right below it; create/code/resume/modes are folded under **다른 방법으로 시작하기**. Inside KakaoTalk's in-app browser a note offers **다른 브라우저로 열기** (`kakaotalk://web/openExternal`), because its storage is separate.
- **대기실**: big room code, invite link (the verified tunnel URL from `tools/serve.js` `/tunnel.json` when present, else `location.origin + pathname`), **링크 보내기** (Web Share, falling back to copy) and **복사**, both seats with online dots, "중계 서버 N곳 연결됨". A note warns when the page is on `file://`/localhost without a tunnel. If no room doc arrives within 8 s of connecting: **이 코드로 새 방 만들기**. The game starts by itself when the second seat is claimed (`claimSeat` commits the seat and `E.newGame`, first player = `prevLoser` or random).
- **Full room** (both seats taken, none mine): each seat shows 접속 중/오프라인; a seat whose name equals my name always offers **내 자리예요 · 이어받기** (even if it still looks online), other offline seats offer **○○ 자리 이어받기**; both go through a confirm sheet. **관전하기** watches read-only. `takeover()` commits the seat with my deviceId and `{jump:2}`; the old device sees its seat vanish, becomes a spectator and gets a toast.
- **게임** (below) → **결과**: winner, reason and detail, both players' finals, **다시 하기** (loser starts; online it commits a new game with `prevLoser`), **마지막 보드 보기**, **홈으로**.

### Game screen

Phone layout ("compact") = `(max-width: 599px), (orientation: landscape) and (max-height: 500px)` — `COMPACT_Q` in app.js and the CSS media queries must stay identical (a unit test checks). At 390×844 the whole pyramid and all 5 board rows are visible at scroll 0.

Portrait phone, top to bottom:
1. **Opponent strip** (`stripHTML`, pos `top`): one row with online dot, name, points/20, crowns, privileges, **예약 N**, tokens N/10, plus ☰ (menu) and ⏱ (log) buttons; a second row with 7 cells (per color a bonus chip, with color points once there are any, and a token chip; then pearl and gold). The whole strip is one button (`.st-hit`) that opens the **player sheet** (full panel, reserved cards at 64 px, bought cards by color).
2. **Last line**: one tappable line (≥40 px) with a 20 px card thumbnail describing the opponent's main action; tapping opens the log. The instruction banner (`bannerHTML`) is shown only in the alert case (no main action possible), at every width — the action bar is the one place that says what to do. On phones the top bar is hidden too.
3. **Pyramid**: rows L3/L2/L1, each with its deck pile first. The 4 **royal cards sit in the L3 row** as a 2×2 mini grid inside one button (pulsing ring while a royal must be picked).
4. **Board** 5×5 with the privilege supply and the bag beside it.
5. **My strip** (pos `me`): same two rows plus my 3 reserved slots (46 px cards) and a **카드 N** button.
6. **Action bar** (`barHTML`, fixed bottom): two text lines + buttons for the current step (take, 특권 N → 다 썼어요, 채우기 with confirm — buttons always icon + text, a disabled one explains itself when tapped —, pending decisions, gold pick for a reserve with a 26 px thumbnail of the target, forced replenish/pass). While the opponent moves it reads ○○님 차례예요 with 고민 중이에요… (or what they are resolving) as the second line. The online send-status pill sits in this bar (end of the first line; second line while waiting). **Coach row**: in this device's first game, my first three turns add a 처음 안내 row on top of the bar (hint + 규칙 보기 → opens the rules at that section; **안내 끄기** = never again; stored in `sd.coach`, also set done when the first game ends); the bar grows by that row (`body.coaching`).

Landscape phone (≤500 px tall): three columns (players | pyramid | board), 48 px action bar with ☰/⏱ fixed at its left, no page scroll. Tablet (600–899 px): single column with the full player panels. Desktop (≥900 px): top bar (menu, broker dot + room code, log, emote), a banner row that holds the last-action line (up to two sentences) or the alert, then players | pyramid with the royal row | board.

Interactions: tap board tokens to build a selection (valid extensions dashed, invalid taps explained by toast + shake); the two ends of a 3-line may be tapped first (the middle is then marked and 가져오기 stays disabled with 가운데 토큰도 골라야 해요); removing the middle keeps the last-tapped end. Confirm with **가져오기 (N)**. Tap a card → sheet with 구매 (payment rows with gold steppers, joker color chips with a 추천 pill from `H.jokerPick`) / 예약 (then pick the gold on the board). Tap a deck → 맨 위 카드 예약. steal/royal/discard open their sheet automatically; bonusToken is picked on the board. `revealBoard()` scrolls the board into view when a board pick starts (privilege, reserve gold, bonusToken). Opponent's cards reserved from a deck are shown face down (UI-only hiding; online the device still receives the full state).

Other sheets: menu (초대 링크 복사 with connected-broker count, 이모티콘 보내기, 규칙 보기, 소리, 기권하기 → confirm, 홈으로), 지난 기록 (log grouped by turn), 규칙 한눈에 보기 (12 sections with `#rule-N` anchors), 이모티콘 (6 emotes that float up on both screens), 카드 list.

### Online behaviour

- Only the seat whose turn it is can act (`canAct()` also requires `room.synced`). When it is my turn but not yet synced, the bar shows 방에 연결하는 중… / 다시 연결하는 중… 잠시 후 이어서 둘 수 있어요 with no buttons. Resign (either player, any time), takeover, seat claims and rematch are the other writers; resign and takeover use `{jump:2}`.
- `onConflict` → `H.conflictPlan`: my lost resign is re-applied on the winner with `{jump:2}`; a lost takeover toasts 자리 이어받기가 취소됐어요; a lost seat claim or a simultaneous rematch is silent; anything else toasts 상대가 먼저 둔 수가 있어서 내 수가 취소됐어요.
- Send-status pill (`H.deliveryPill` via `H.movePill`, driven only by `room.delivery`/`onDelivery`, and only for my own game moves — not for room creation, seat claims, new games or takeovers): 보내는 중… → 아직 못 보냈어요 · 다시 연결하는 중 after 8 s; 보냄 for 1.5 s after a broker acked; 상대에게 아직 전달되지 않았어요 (soft) if still not delivered after 10 s while the opponent is online (never while they are offline — the doc waits on the brokers); 상대가 받았어요 for 2.5 s once the other seat has it.
- Net bar (`renderNetbar`, the only place for connection/away text): 인터넷 연결이 끊겼어요… (browser offline), 중계 서버와 연결이 끊겼어요. 다시 연결하는 중이에요… (0 brokers after having connected or 7 s), 중계 서버에 연결하는 중이에요… (soft, first seconds), and ○○님이 잠시 자리를 비웠어요 (soft) after the opponent has been offline 30 s — only while my own connection is connected and synced (`H.awayAllowed`). While my connection is uncertain the opponent's dot shows a faded "연결 확인 중" grey (`dot.unk`) instead of 오프라인.
- Turn start: `document.title` "● 내 차례 · 스플렌더 대결", chime (if sound on) and vibration. The opponent's last actions are highlighted on the board/pyramid (`highlights()`).

### Local modes, storage, debug

Hot-seat (`local`: the bottom panel is always the player to move) and bot (`bot`, bot moves after 700 ms) games are saved to `sd.local` after every action and offered under 이어하기. Other keys: `sd.device` (deviceId), `sd.name`, `sd.sound`, `sd.recent`, `sd.botLevel`, `sd.coach`, `sd.move` (`{room, seq, nonce}` of my last game-move commit, so the pill survives a reload), `sd.room.<ROOM>` + `.meta` (net.js); `sessionStorage['sd.active']` resumes a local game on reload.

`?debug=1` exposes `window.__sd` = `{S, E, game, doc, act, view(), state(), autoplay({delay, level}), stop(), setGame(g)}`; `state()` includes delivery, synced, pill, compact and sel.

Pure helpers (`H`, returned by `require('./js/app.js')` in Node, tested in tests/ui-helpers.test.js): `gapMiddle, openMiddle, tapSelect, deliveryPill, movePill, playerTag, conflictPlan, turnOwners, myTurnIndex, coachHint, jokerPick, awayAllowed, COACH`.

### Bot (`js/bot.js`)

```js
SDBot.chooseAction(state, { level: 'easy' | 'normal', rng?: () => number }) -> action | null   // null when the game is over
```
Pure w.r.t. `state` (never mutates it); randomness from `rng` (default Math.random). Always returns an action that `SDEngine.apply` accepts (a safety fallback picks a legal one and counts `SDBot._debug.fallbacks`). `normal` skips its optional replenish look-ahead once a decision has used 60 ms. On the dev PC a normal decision costs ≈2 ms CPU; tests/bot.test.js checks CPU time (not wall-clock) against hard caps and a calibration loop run in the same process.

### Local server helpers (`tools/serve.js`)

When the page is served by `tools/serve.js`, `GET /tunnel.json` returns `{ status, url, verified, provider, error }` for the optional internet link (tools/tunnel.js); `GET /healthz` returns `ok`. The app fetches `/tunnel.json` when `location.protocol` is http(s) and, if `url` is set and verified, uses it as the base of invite links. On GitHub Pages or `file://` the request fails silently and the invite link is `location.origin + location.pathname + '?room=CODE'` (`file://`: the file URL).

## 6. Relay brokers (tested 2026-09-26 from Node and a real Chromium page)

| # | URL | notes |
|---|---|---|
| 1 | `wss://broker.emqx.io:8084/mqtt` (emqx) | passed everything, ~150 ms one-way, retained up to 256 KB, LWT ~0.2 s on tab close |
| 2 | `wss://iot.coreflux.cloud:443/mqtt` (coreflux) | passed everything, ~240 ms, retained up to 1 MB |
| 3 | `wss://broker.hivemq.com:8884/mqtt` (hivemq) | works but ~28 % connect timeouts in that test |

`join()` connects to **all three at once** (`makeBroker` for each URL) so two phones always share at least one broker; there is no fallback timer. Docs go to every connected, heal-checked broker; emotes to every connected broker; presence is per broker and merged. Client options: clientId `sd_` + 12 random hex, `clean:true`, `keepalive:20`, `reconnectPeriod:2000`, `connectTimeout:8000`, `resubscribe:false` (net.js subscribes itself on every connect), will = offline presence; QoS 1 for doc/presence, 0 for emotes.

Ports: only coreflux listens on **443**. On networks that allow nothing but 443 (some office/school Wi-Fi), a coreflux outage therefore disconnects that player; no other free public WSS broker on 443 was found. Live check (`npm run test:net`, 2026-09-27): A→B ≈ 0.3 s, `delivered` ≈ 0.5 s later, LWT ≈ 0.3 s.

Keep the doc well under 60 KB (incoming payloads over 200 KB are ignored; net.js warns when publishing more). Never publish zero-length payloads (some brokers, e.g. test.mosquitto.org, drop the connection); to clear presence publish `{}` (parsed as "removed").

Browser build: vendored copy of `mqtt@5.16.0/dist/mqtt.min.js` (defines `window.mqtt`), same file as `https://cdn.jsdelivr.net/npm/mqtt@5.16.0/dist/mqtt.min.js`.

## 7. Visual design

Concept: a jeweler's velvet tray. Deep plum velvet ground, brass fittings, ivory card faces, faceted gem tokens. One committed dark look (no light theme; `color-scheme: dark`); every color set explicitly.

Palette (CSS custom properties on `:root`):
- `--velvet #2B1E36` page ground, `--velvet-2 #3A2A48` panels, `--velvet-3 #4A3659` raised/hover, `--line #5C4870` hairlines, `--velvet-deep #221729`
- `--brass #D6AE5C` accent (active turn, primary buttons, selection rings), `--brass-deep #9C7A36`
- `--ivory #F4ECDD` card faces / main text on velvet, `--ivory-2 #E9DFCB`, `--ink #2A2230` text on ivory, `--muted #B9A8C6` secondary text
- gems: `--g-white #EEF0F4` (edge `--g-white-edge #9AA3B2`), `--g-blue #2F6BDA`, `--g-green #1E9E62`, `--g-red #D8403F`, `--g-black #2A2A31` (edge `--g-black-edge #6B6B78`), `--g-pearl #F3DCE4`, `--g-gold #E9B832`
- semantic: `--ok #5FBF8F`, `--warn #E9A23B`, `--bad #E0605E`
- sizes: `--cw` card width and `--cell` board cell, computed from the viewport per layout (phone, landscape, desktop); `--bar-h` action bar; `--safe-t/--safe-b` safe-area insets.

Type (Google Fonts, with fallbacks): display `Gowun Batang` (700) for the title, card point numerals, section headings; UI `IBM Plex Sans KR` (400/500/600); `font-variant-numeric: tabular-nums` for all counters. Fallback stack: `"Apple SD Gothic Neo", "Malgun Gothic", "Noto Sans KR", sans-serif`.

Tokens (`<symbol id="tk-*">` in index.html) are round discs with a radial highlight and a cut glyph so colors are distinguishable without color vision (`CUT` in app.js, shown in the rules): white = brilliant (diamond outline), blue = cushion (rounded square), green = emerald cut (octagon), red = oval, black = hexagon, pearl = ring with a sheen dot, **gold = faceted ingot** (a trapezoid bar, deliberately not a crown so it cannot be confused with the crown icon). Joker = rainbow ring (`tk-joker`). Cost pips (`pp-*`) repeat the cut shapes. Color names in the UI are bare nouns: 하양, 파랑, 초록, 빨강, 검정, 진주, 금.

Cards: ivory face, a band tinted with the bonus color along the top holding the points numeral (left) and the bonus gem(s) (right; two gems for double bonus; the joker ring, or the chosen color once bought; nothing for no-bonus grey cards), crowns and ability icon under the band, cost pips stacked at the bottom-left, level as 1–3 small dots at the bottom-right. Cards whose cost has 4 colors (`.n4`) use a 2×2 cost grid and omit the level dots (the row tells the level). Ability icons are inline SVG: extra turn = circular arrows, bonus token = small token in the card's color, steal = open hand, privilege = scroll. Card backs show the level as a Roman numeral + dots.

Highlight language: **affordable now** = thin 2 px brass ring around the card (`.afford`, no dot); **new card / reserve target** = thicker pulsing brass glow (`.hl`, 3 pulses); board selection = brass ring with a numbered badge; valid next cells = dashed brass ring (`.ext`), others dimmed; cells to pick for privilege/gold/bonus token = pulsing ring (`.target`); a token the opponent just took = orange dashed ghost (`.ghost`); freshly refilled cells = thin brass ring (`.newtok`).

Respect `prefers-reduced-motion` (animations collapsed, confetti off). Visible `:focus-visible` rings (brass). Tap targets ≥ 40 px (the royal mini grid is one 64×80 button). Safe-area paddings, `overscroll-behavior-y: none`, `touch-action: manipulation` on the game screen; the invite-link input uses 16 px text (no iOS zoom).
