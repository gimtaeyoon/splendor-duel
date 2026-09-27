'use strict';
// js/app.js 의 순수 도우미 (DOM 없음). Node 에서 require 하면 도우미만 돌려줘요.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const H = require('../js/app.js');
const E = require('../js/engine.js');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

function fullBoard() {
  // 가운데 줄에 금이 하나 있는 가득 찬 보드
  const g = E.newGame({ names: ['가', '나'], first: 0, seed: 7 });
  const b = ['white', 'blue', 'green', 'red', 'black', 'pearl', 'white', 'blue', 'green', 'red', 'black', 'gold', 'white', 'blue', 'green', 'red', 'black', 'pearl', 'white', 'blue', 'green', 'red', 'black', 'gold', 'gold'];
  g.board = b;
  return g;
}
const validate = (g) => (cells) => E.validateTake(g, cells);

test('gapMiddle: 한 줄에서 정확히 두 칸 떨어진 경우만', () => {
  assert.equal(H.gapMiddle([0, 2]), 1); // 가로
  assert.equal(H.gapMiddle([2, 0]), 1);
  assert.equal(H.gapMiddle([0, 10]), 5); // 세로
  assert.equal(H.gapMiddle([0, 12]), 6); // 대각선
  assert.equal(H.gapMiddle([4, 12]), 8); // 반대 대각선
  assert.equal(H.gapMiddle([3, 5]), null); // 줄바꿈을 넘는 가짜 가로
  assert.equal(H.gapMiddle([0, 3]), null);
  assert.equal(H.gapMiddle([0, 11]), null);
  assert.equal(H.gapMiddle([0, 1]), null);
  assert.equal(H.gapMiddle([0]), null);
});

test('tapSelect: 양 끝(0, 2) 먼저 → 가운데(1) 로 완성, 가져오기 검증은 엔진 그대로', () => {
  const g = fullBoard();
  let r = H.tapSelect(g.board, [], 0, validate(g));
  assert.deepEqual(r.sel, [0]);
  r = H.tapSelect(g.board, r.sel, 2, validate(g));
  assert.equal(r.error, undefined, '두 칸 떨어진 끝은 거절하지 않음');
  assert.deepEqual(r.sel, [0, 2]);
  assert.equal(H.openMiddle(g.board, r.sel), 1);
  assert.equal(E.validateTake(g, r.sel).ok, false, '아직 미완성 (가져오기 막힘)');
  r = H.tapSelect(g.board, r.sel, 1, validate(g));
  assert.deepEqual(r.sel, [0, 2, 1]);
  assert.equal(E.validateTake(g, r.sel).ok, true);
  const a = E.apply(g, { type: 'take', cells: r.sel });
  assert.equal(a.ok, true);
});

test('tapSelect: 가운데가 금·빈칸이면 두 칸 떨어진 끝도 거절', () => {
  const g = fullBoard();
  // 10(검정) - 11(금) - 12(하양)
  let r = H.tapSelect(g.board, [10], 12, validate(g));
  assert.ok(r.error);
  assert.deepEqual(r.sel, [10]);
  g.board[11] = null;
  r = H.tapSelect(g.board, [10], 12, validate(g));
  assert.ok(r.error);
});

test('tapSelect: 미완성 상태에서 가운데가 아닌 칸은 거절', () => {
  const g = fullBoard();
  const r = H.tapSelect(g.board, [0, 2], 7, validate(g));
  assert.ok(r.error);
  assert.deepEqual(r.sel, [0, 2]);
});

test('tapSelect: [0,1,2] 에서 가운데(1) 를 빼면 전부 지우지 않고 마지막에 누른 끝만 남김', () => {
  const g = fullBoard();
  let r = H.tapSelect(g.board, [0, 1, 2], 1, validate(g));
  assert.deepEqual(r.sel, [2]);
  r = H.tapSelect(g.board, [2, 1, 0], 1, validate(g));
  assert.deepEqual(r.sel, [0]);
  // 끝을 빼면 남은 두 칸은 그대로
  r = H.tapSelect(g.board, [0, 1, 2], 2, validate(g));
  assert.deepEqual(r.sel, [0, 1]);
  r = H.tapSelect(g.board, [0], 0, validate(g));
  assert.deepEqual(r.sel, []);
});

test('tapSelect: 3개 다음은 거절', () => {
  const g = fullBoard();
  const r = H.tapSelect(g.board, [0, 1, 2], 3, validate(g));
  assert.ok(r.error);
});

test('deliveryPill: 보내는 중 → 보냄 → 상대가 받았어요, 8초 넘게 못 보내면 경고', () => {
  const t0 = 1000000;
  assert.equal(H.deliveryPill(null, t0, true), null);
  let p = H.deliveryPill({ state: 'pending', since: t0 }, t0 + 100, true);
  assert.equal(p.text, '보내는 중…');
  assert.ok(p.next > 7000 && p.next <= 7900);
  p = H.deliveryPill({ state: 'pending', since: t0 }, t0 + 8200, false);
  assert.equal(p.text, '아직 못 보냈어요 · 다시 연결하는 중');
  assert.equal(p.cls, 'warn');
  p = H.deliveryPill({ state: 'relayed', since: t0 }, t0 + 300, true);
  assert.equal(p.text, '보냄');
  p = H.deliveryPill({ state: 'delivered', since: t0 }, t0 + 300, true);
  assert.equal(p.text, '상대가 받았어요');
  assert.equal(H.deliveryPill({ state: 'delivered', since: t0 }, t0 + 4000, true), null, '잠깐 뒤 사라짐');
});

test('deliveryPill: 옛 버그 — 연결만 돼 있으면 "보냄"으로 치던 것 (PUBACK/전달 없이) 은 없음', () => {
  const t0 = 5000;
  // 브로커 확인이 없으면 몇 초가 지나도 계속 '보내는 중'
  const p = H.deliveryPill({ state: 'pending', since: t0 }, t0 + 5000, true);
  assert.equal(p.text, '보내는 중…');
});

test('deliveryPill: relayed 인데 10초 넘게 상대가 못 받으면 (상대 접속 중일 때만) 부드러운 안내', () => {
  const t0 = 0;
  let p = H.deliveryPill({ state: 'relayed', since: t0 }, t0 + 5000, true);
  assert.equal(p.text, null);
  assert.ok(p.next > 0);
  p = H.deliveryPill({ state: 'relayed', since: t0 }, t0 + 10500, true);
  assert.equal(p.text, '상대에게 아직 전달되지 않았어요');
  assert.equal(p.cls, 'soft');
  // 상대가 꺼져 있으면 문서가 브로커에 남아 있으니 경고하지 않음
  assert.equal(H.deliveryPill({ state: 'relayed', since: t0 }, t0 + 60000, false), null);
  assert.equal(H.deliveryPill({ state: 'superseded', since: t0 }, t0 + 10, true), null);
});

function doc(seq, nonce, seats, game) { return { seq, nonce, seats, game }; }
const ME = 'dme', OPP = 'dopp';
const SEATS = [{ deviceId: ME, name: '나' }, { deviceId: OPP, name: '너' }];

test('conflictPlan: 내 기권이 상대 수에 밀리면 이긴 문서 위에 다시 기권', () => {
  const g = E.newGame({ names: ['나', '너'], first: 0, seed: 3 });
  const resigned = E.apply(g, { type: 'resign', player: 0 }).state;
  const moved = E.apply(g, E.legalActions(g).find((a) => a.type === 'take')).state;
  const plan = H.conflictPlan([doc(6, 'a', SEATS, resigned)], doc(6, 'b', SEATS, moved), { deviceId: ME, seat: 0, takeover: null });
  assert.deepEqual(plan, { kind: 'resign', player: 0 });
  // 이긴 쪽 게임이 이미 끝났으면 다시 하지 않음
  const over = E.apply(moved, { type: 'resign', player: 1 }).state;
  assert.equal(H.conflictPlan([doc(6, 'a', SEATS, resigned)], doc(7, 'b', SEATS, over), { deviceId: ME, seat: 0 }).kind, 'move');
});

test('conflictPlan: 이어받기가 밀려 아직 자리가 없으면 takeover 안내', () => {
  const g = E.newGame({ names: ['나', '너'], first: 0, seed: 3 });
  const mine = [{ deviceId: ME, name: '나' }, { deviceId: OPP, name: '너' }];
  const theirs = [{ deviceId: 'dold', name: '나' }, { deviceId: OPP, name: '너' }];
  const plan = H.conflictPlan([doc(9, 'x', mine, g)], doc(9, 'y', theirs, g), { deviceId: ME, seat: null, takeover: { seq: 9, nonce: 'x' } });
  assert.equal(plan.kind, 'takeover');
});

test('conflictPlan: 보통 수가 밀리면 move, 자리 잡기만 진 경우·새로고침 뒤 요약본', () => {
  const g = E.newGame({ names: ['나', '너'], first: 0, seed: 3 });
  const a = E.apply(g, E.legalActions(g).find((x) => x.type === 'take')).state;
  assert.equal(H.conflictPlan([doc(5, 'a', SEATS, a)], doc(5, 'b', SEATS, a), { deviceId: ME, seat: 0 }).kind, 'move');
  // 게임 전 자리 잡기 → 조용히 (빈자리가 있으면 다시 잡음)
  assert.equal(H.conflictPlan([doc(2, 'a', [SEATS[0], { deviceId: ME, name: '나' }], null)], doc(2, 'b', SEATS, g), { deviceId: 'dthird', seat: null }).kind, 'silent');
  // 둘이 동시에 새 판(다시 하기) → 조용히
  const g2 = E.newGame({ names: ['나', '너'], first: 1, seed: 9 });
  assert.equal(H.conflictPlan([doc(40, 'a', SEATS, g2)], doc(40, 'b', SEATS, g), { deviceId: ME, seat: 0 }).kind, 'silent');
  // game 이 없는 요약본 (새로고침 뒤) → 일반 안내
  assert.equal(H.conflictPlan([{ seq: 5, nonce: 'a' }], doc(5, 'b', SEATS, a), { deviceId: ME, seat: 0 }).kind, 'move');
});

test('awayAllowed: 내 연결이 끊겼거나 동기화 전이면 상대 탓 문구 금지', () => {
  assert.equal(H.awayAllowed({ connected: 0 }, true), false);
  assert.equal(H.awayAllowed({ connected: 2 }, false), false);
  assert.equal(H.awayAllowed({ connected: 1 }, true), true);
});

test('myTurnIndex / coachHint: 첫 게임의 처음 세 차례만, × 뒤에는 없음', () => {
  let g = E.newGame({ names: ['나', '봇'], first: 0, seed: 11 });
  assert.equal(H.myTurnIndex(g, 0), 1);
  let r = H.coachHint(null, 'id1', 1);
  assert.equal(r.hint.sec, 4);
  assert.deepEqual(r.store, { id: 'id1' });
  r = H.coachHint({ id: 'id1' }, 'id1', 2);
  assert.equal(r.hint.sec, 8);
  assert.equal(r.store, undefined);
  assert.equal(H.coachHint({ id: 'id1' }, 'id1', 3).hint.sec, 5);
  assert.deepEqual(H.coachHint({ id: 'id1' }, 'id1', 4), { hint: null, store: 'done' });
  assert.deepEqual(H.coachHint({ id: 'id1' }, 'other', 1), { hint: null, store: 'done' }, '두 번째 게임에는 안내 없음');
  assert.equal(H.coachHint('done', 'id1', 1).hint, null);
  // 차례가 넘어가면 번호가 늘어남
  for (let i = 0; i < 2; i++) {
    const a = E.legalActions(g).find((x) => x.type === 'take');
    g = E.apply(g, a).state;
    while (g.pending.length) g = E.apply(g, E.legalActions(g)[0]).state;
  }
  assert.equal(g.turn.player, 0);
  assert.equal(H.myTurnIndex(g, 0), 2);
  assert.equal(H.myTurnIndex(g, 1), 1);
});

test('jokerPick: 색 점수가 가장 높은 색을 추천', () => {
  assert.equal(H.jokerPick(['red', 'blue'], { red: 3, blue: 5 }, { red: 2, blue: 1 }), 'blue');
  assert.equal(H.jokerPick(['red', 'blue'], { red: 2, blue: 2 }, { red: 3, blue: 1 }), 'red');
  assert.equal(H.jokerPick(['red', 'blue'], { red: 0, blue: 0 }, { red: 3, blue: 1 }), null);
  assert.equal(H.jokerPick(['red'], { red: 5 }, { red: 1 }), null);
});

// ── 정적 검사: 예전 버그가 되살아나지 않게 ──
test('app.js 는 테스트 전용 room._brokers() 를 쓰지 않고 room.delivery/onDelivery 를 씀', () => {
  const s = read('js/app.js');
  assert.ok(!/_brokers\s*\(/.test(s), '_brokers() 사용 금지');
  assert.ok(/onDelivery/.test(s) && /onConflict/.test(s));
  assert.ok(!/afterLoad\s*\(/.test(s), 'resume() 이 안전해져서 load 기다리기 우회는 없음');
  assert.ok(/jump:\s*2/.test(s), '기권/이어받기는 jump 2');
});

test('app.js 행동 막대에는 상대 자리 비움 문구가 없음 (netbar 한 곳에서만)', () => {
  const s = read('js/app.js');
  const bar = s.slice(s.indexOf('function barHTML'), s.indexOf('function setCoach'));
  assert.ok(bar.length > 100);
  assert.ok(!/자리를 비웠/.test(bar));
  assert.ok(!/오프라인이에요/.test(bar));
  assert.equal((s.match(/자리를 비웠어요\. 돌아오면/g) || []).length, 1);
});

test('색 이름은 맨 명사 (하양/파랑/…)', () => {
  const s = read('js/app.js');
  assert.ok(/white: '하양'/.test(s));
  assert.ok(!/흰색/.test(s));
});

test('index.html: 금 토큰은 왕관 모양이 아님', () => {
  const s = read('index.html');
  const sym = (id) => { const i = s.indexOf(`<symbol id="${id}"`); return s.slice(i, s.indexOf('</symbol>', i)); };
  const gold = sym('tk-gold');
  const crown = sym('ic-crown');
  assert.ok(gold.length > 50 && crown.length > 50);
  // 옛 금 토큰의 왕관 경로 (뾰족한 세 봉우리)
  assert.ok(!gold.includes('M12 25.5h16l1.6-11-5.6 4.4-4-7.2-4 7.2-5.6-4.4z'));
  const crownPath = (crown.match(/d="([^"]+)"/) || [])[1];
  assert.ok(crownPath && !gold.includes(crownPath));
});

test('style.css: 살 수 있는 카드는 테두리(점 아님), 초대 링크 칸은 16px(iOS 확대 방지), 폰 제스처 막기', () => {
  const s = read('css/style.css');
  assert.ok(!/\.card\.afford::after/.test(s), '작은 점(::after) 없음');
  assert.ok(/\.card\.afford[^{]*\{[^}]*box-shadow:\s*0 0 0 2px var\(--brass\)/.test(s));
  assert.ok(/\.card\.n4 \.lvl\s*\{\s*display:\s*none/.test(s));
  const lr = s.match(/\.link-row \.input\s*\{([^}]*)\}/);
  assert.ok(lr && /font-size:\s*16px/.test(lr[1]) && /scale\(\.82\)/.test(lr[1]));
  assert.ok(/overscroll-behavior-y:\s*none/.test(s));
  assert.ok(/#scr-game\s*\{\s*touch-action:\s*manipulation/.test(s));
  assert.ok(/@media \(orientation: landscape\) and \(max-height: 500px\)/.test(s));
});

test('app.js 와 style.css 의 폰 배치 조건이 같음', () => {
  const js = read('js/app.js');
  const css = read('css/style.css');
  const q = (js.match(/COMPACT_Q = '([^']+)'/) || [])[1];
  assert.ok(q);
  for (const part of q.split(', ')) assert.ok(css.includes('@media ' + part), part);
});

// ── 이번 손질: 보내기 알약 · 이름 꼬리표 · 안내 막대 · 넓은 화면 배너 ──
test('movePill: 내가 둔 수(게임 행동) 커밋에만 알약, 방 만들기·자리 잡기·새 판 준비에는 없음', () => {
  const t0 = 1000;
  const move = { seq: 7, nonce: 'm7' };
  // 내 수와 같은 커밋 → deliveryPill 그대로
  assert.equal(H.movePill({ seq: 7, nonce: 'm7', state: 'pending', since: t0 }, move, t0 + 50, true).text, '보내는 중…');
  assert.equal(H.movePill({ seq: 7, nonce: 'm7', state: 'delivered', since: t0 }, move, t0 + 50, true).text, '상대가 받았어요');
  // 방 만들기 · 자리 잡기 · 다시 하기 커밋은 내 수가 아님 → 없음 (옛 버그: 게임 시작 때 '상대가 받았어요')
  assert.equal(H.movePill({ seq: 1, nonce: 'c1', state: 'delivered', since: t0 }, null, t0 + 50, true), null);
  assert.equal(H.movePill({ seq: 8, nonce: 'r8', state: 'pending', since: t0 }, move, t0 + 50, true), null, '내 수 뒤의 새 판 준비 커밋');
  // seq 가 같아도 nonce 가 다르면 다른 커밋
  assert.equal(H.movePill({ seq: 7, nonce: 'x', state: 'relayed', since: t0 }, move, t0 + 50, true), null);
  assert.equal(H.movePill(null, move, t0, true), null);
});

test('playerTag: 이름이 꼬리표와 같으면 ("나" 나) 꼬리표를 빼요', () => {
  assert.equal(H.playerTag('나', '나'), '');
  assert.equal(H.playerTag(' 나 ', '나'), '');
  assert.equal(H.playerTag('지은', '나'), '나');
  assert.equal(H.playerTag('봇', '봇 · 쉬움'), '봇 · 쉬움');
  assert.equal(H.playerTag('민수', ''), '');
});

test('app.js: 보내기 알약은 행동 막대 안에만 (떠 있는 알약·위쪽 막대 알약 없음), 내 수 커밋만 기억', () => {
  const js = read('js/app.js');
  const html = read('index.html');
  const css = read('css/style.css');
  assert.ok(!/g-send|sendfloat/.test(html), 'index.html 에 떠 있는 알약 칸 없음');
  assert.ok(!/sendfloat/.test(css));
  assert.ok(!/g-send/.test(js));
  const top = js.slice(js.indexOf('function renderTopbar'), js.indexOf('function renderNetbar'));
  assert.ok(top.length > 100 && !/sendPillHTML/.test(top), '위쪽 막대에는 알약 없음');
  const bar = js.slice(js.indexOf('function barHTML'), js.indexOf('function setCoach'));
  assert.ok(/sendPillHTML\(\)/.test(bar), '행동 막대가 알약을 그림');
  assert.ok(/H\.movePill\(/.test(js), '내 수 커밋에만');
  // 게임 행동 커밋(commitState)만 moveRef 를 기록
  const cs = js.slice(js.indexOf('function commitState'), js.indexOf('function freshEvents'));
  assert.ok(/setMoveRef\(S\.room\.commit/.test(cs));
  for (const fn of ['function claimSeat', 'function rematch', 'function takeover', 'function enterRoom']) {
    const i = js.indexOf(fn);
    const body = js.slice(i, js.indexOf('\n  }\n', i));
    assert.ok(body.length > 50 && !/setMoveRef/.test(body), fn + ' 는 알약 없음');
  }
  // 알약 모양 클래스가 행동 막대의 .warn(줄바꿈 경고 글) 과 겹치지 않게
  assert.ok(/class="sendpill\$\{p\.cls \? ' sp-'/.test(js));
});

test('행동 막대: 처음 안내 끄기는 글자 버튼, 특권·채우기는 늘 아이콘+글자', () => {
  const js = read('js/app.js');
  const bar = js.slice(js.indexOf('function barHTML'), js.indexOf('function setCoach'));
  assert.ok(/data-a="coach-x">안내 끄기<\/button>/.test(bar), "'안내 끄기' 글자 버튼");
  assert.ok(!/ico\('close'\), 'coach-x'/.test(bar), '글자 없는 ✕ 버튼 없음');
  assert.ok(/\$\{ico\('scroll'\)\}특권 \$\{v\.pl\.privileges\}/.test(bar));
  assert.ok(/\$\{ico\('refill'\)\}채우기/.test(bar));
  assert.ok(!/coach \? '' :/.test(bar), '안내 중이라고 글자를 빼지 않음');
});

test('style.css: 무엇을 할지는 행동 막대 한 곳 (배너는 모든 폭에서 alert 일 때만)', () => {
  const css = read('css/style.css');
  // 미디어 쿼리 밖(맨 바깥)에 있어야 넓은 화면에도 적용
  let depth = 0; let top = '';
  for (const line of css.split('\n')) {
    if (depth === 0) top += line + '\n';
    depth += (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length;
  }
  assert.ok(/^\.banner:not\(\.alert\) \{ display: none; \}/m.test(top));
  assert.ok(/^\.area-banner:not\(:has\(\.lastline, \.banner\.alert\)\) \{ display: none; \}/m.test(top));
  assert.ok(/body\.coaching \{ --bar-h:/.test(css), '안내 줄만큼 화면 아래 여백');
});
