/* 스플렌더 대결 — 화면, 조작, 모드(온라인/한 기기/봇), 동기화 연결
 * 규칙은 전부 SDEngine 에 맡기고, 여기서는 보여 주고 입력만 받아요. (docs/SPEC.md §5, §7)
 */
(function () {
  'use strict';

  // ───────── 순수 도우미 (DOM 없음 · Node 테스트: tests/ui-helpers.test.js) ─────────
  const H = (function () {
    const isGemT = (t) => !!t && t !== 'gold';
    // 두 칸이 한 줄(가로·세로·대각선)에서 정확히 두 칸 떨어져 있으면 가운데 칸 번호, 아니면 null
    function gapMiddle(cells) {
      if (!Array.isArray(cells) || cells.length !== 2) return null;
      const a = Math.min(cells[0], cells[1]);
      const b = Math.max(cells[0], cells[1]);
      const ra = Math.floor(a / 5), ca = a % 5, rb = Math.floor(b / 5), cb = b % 5;
      const dr = rb - ra, dc = cb - ca;
      const okD = (d) => d === 0 || Math.abs(d) === 2;
      if (!okD(dr) || !okD(dc) || (dr === 0 && dc === 0)) return null;
      return (ra + dr / 2) * 5 + (ca + dc / 2);
    }
    // 가운데가 빠진 두 칸 선택(가운데에 보석·진주가 있을 때)이면 가운데 칸, 아니면 null
    function openMiddle(board, sel) {
      const m = gapMiddle(sel);
      if (m == null || !board || !isGemT(board[m])) return null;
      if (!isGemT(board[sel[0]]) || !isGemT(board[sel[1]])) return null;
      return m;
    }
    // 토큰 칸을 눌렀을 때 다음 선택. validate = (cells) => {ok, error}
    // 돌려주는 값: { sel, error? }  (error 가 있으면 선택은 그대로)
    function tapSelect(board, sel, i, validate) {
      sel = Array.isArray(sel) ? sel.slice() : [];
      const idx = sel.indexOf(i);
      if (idx >= 0) {
        const rest = sel.filter((c) => c !== i);
        if (!rest.length || validate(rest).ok) return { sel: rest };
        return { sel: [rest[rest.length - 1]] }; // 남은 게 안 맞으면 마지막에 누른 칸만 남김
      }
      if (sel.length >= 3) return { sel, error: '토큰은 한 번에 3개까지만 가져올 수 있어요.' };
      const next = sel.concat([i]);
      const vt = validate(next);
      if (vt.ok) return { sel: next };
      if (next.length === 2 && openMiddle(board, next) != null) return { sel: next }; // 양 끝을 먼저 고른 경우
      return { sel, error: vt.error || '고를 수 없는 칸이에요.' };
    }
    // 보내기 표시. d = room.delivery. 돌려주는 값: null | { text|null, cls, next(ms)|null }
    function deliveryPill(d, now, oppOnline) {
      if (!d) return null;
      const age = Math.max(0, now - (typeof d.since === 'number' ? d.since : now));
      if (d.state === 'pending') {
        if (age >= 8000) return { text: '아직 못 보냈어요 · 다시 연결하는 중', cls: 'warn', next: null };
        return { text: '보내는 중…', cls: '', next: 8000 - age };
      }
      if (d.state === 'relayed') {
        if (age < 1500) return { text: '보냄', cls: 'done', next: 1500 - age };
        if (oppOnline !== true) return null; // 상대가 꺼져 있으면 문서는 브로커에 남아 있으니 경고하지 않음
        if (age >= 10000) return { text: '상대에게 아직 전달되지 않았어요', cls: 'soft', next: null };
        return { text: null, cls: '', next: 10000 - age };
      }
      if (d.state === 'delivered') {
        if (age < 2500) return { text: '상대가 받았어요', cls: 'done', next: 2500 - age };
        return null;
      }
      return null;
    }
    const sameRef = (a, b) => !!a && !!b && a.seq === b.seq && a.nonce === b.nonce;
    // 보내기 표시는 내가 둔 수(게임 행동)에만. 방 만들기·자리 잡기·새 판 준비·이어받기 커밋에는 없음.
    // moveRef = 마지막으로 보낸 내 수의 {seq, nonce}
    function movePill(d, moveRef, now, oppOnline) {
      if (!d || !sameRef(d, moveRef)) return null;
      return deliveryPill(d, now, oppOnline);
    }
    // 이름 옆 꼬리표: 이름과 같으면 ('나' 나) 빼요
    function playerTag(name, tag) {
      if (!tag) return '';
      return String(name == null ? '' : name).trim() === tag ? '' : tag;
    }
    // onConflict({lost, winner}) 을 어떻게 알릴지
    // ctx: { deviceId, seat, takeover:{seq,nonce}|null }
    // → { kind:'resign', player } | { kind:'takeover' } | { kind:'silent' } | { kind:'move' }
    function conflictPlan(lost, winner, ctx) {
      lost = Array.isArray(lost) ? lost : [];
      const seats = (winner && Array.isArray(winner.seats)) ? winner.seats : [null, null];
      const mine = seats.findIndex((s) => s && s.deviceId === ctx.deviceId);
      const wg = winner && winner.game;
      const resign = lost.find((d) => d && d.game && d.game.over && d.game.over.reason === 'resign' && d.game.over.winner === 1 - mine);
      if (resign && mine >= 0 && wg && !wg.over) return { kind: 'resign', player: mine };
      if (ctx.takeover && lost.some((d) => sameRef(d, ctx.takeover)) && mine < 0) return { kind: 'takeover' };
      // 자리 잡기만 진 경우(빈자리가 있으면 다시 잡음), 둘 다 새 판을 시작한 경우는 조용히
      const fresh = (g) => !!g && !g.over && g.turn && g.turn.number === 1 && (!g.log || !g.log.some((e) => e.t === 'take' || e.t === 'buy' || e.t === 'reserve'));
      // (새로고침 뒤의 lost 는 game 이 없는 요약본일 수 있음 → 무엇이었는지 모르니 일반 안내)
      const known = lost.length > 0 && lost.every((d) => d && 'game' in d);
      if (known && lost.every((d) => d.game === null || (fresh(d.game) && fresh(wg)))) return { kind: 'silent' };
      return { kind: 'move' };
    }
    // 차례 순서 (turnNo → 둔 사람)
    function turnOwners(g) {
      const o = {};
      o[g.turn.number] = g.turn.player;
      for (const e of g.log) if (e.t === 'turn') o[e.number] = e.p;
      for (const e of g.log) if (e.t === 'turn' && o[e.number - 1] === undefined) o[e.number - 1] = e.extra ? e.p : 1 - e.p;
      return o;
    }
    // p 가 지금 몇 번째 자기 차례인지 (1부터)
    function myTurnIndex(g, p) {
      const own = turnOwners(g);
      let n = 0;
      for (let t = 1; t <= g.turn.number; t++) if (own[t] === p) n++;
      if (own[1] === undefined && g.turn.number > 1) return 99; // 기록이 잘려 모름 → 초반이 아님
      return n;
    }
    const COACH = [
      null,
      { text: '보드에서 한 줄로 붙은 보석을 최대 3개 눌러요', sec: 4 },
      { text: '금색 테두리 카드는 지금 살 수 있어요 · 카드를 누르면 설명이 나와요', sec: 8 },
      { text: '두루마리는 특권 — 차례 처음에 보석 1개를 공짜로 가져와요', sec: 5 },
    ];
    // 첫 게임 안내: coach = 저장값(null | 'done' | {id}), id = 이번 게임 표시
    // → { hint|null, store: 새로 저장할 값|undefined }
    function coachHint(coach, id, turnIdx) {
      if (coach === 'done') return { hint: null };
      if (coach && typeof coach === 'object' && coach.id !== id) return { hint: null, store: 'done' }; // 첫 게임이 아님
      const st = coach && coach.id === id ? undefined : { id };
      if (turnIdx >= 1 && turnIdx <= 3) return { hint: COACH[turnIdx], store: st };
      if (turnIdx > 3) return { hint: null, store: 'done' };
      return { hint: null, store: st };
    }
    // 조커 색: 고를 수 있는 색 중 색 점수가 가장 높은 색 (같으면 보너스가 많은 색). 하나뿐이거나 모두 0점이면 null
    function jokerPick(opts, colorPoints, bonuses) {
      if (!Array.isArray(opts) || opts.length < 2) return null;
      let best = null;
      for (const c of opts) {
        if (!best) { best = c; continue; }
        const a = colorPoints[c] || 0, b = colorPoints[best] || 0;
        if (a > b || (a === b && (bonuses[c] || 0) > (bonuses[best] || 0))) best = c;
      }
      if (!(colorPoints[best] > 0)) return null;
      return best;
    }
    // 상대 자리 비움 문구를 보여도 되는가 (내 연결이 멀쩡할 때만)
    function awayAllowed(status, synced) { return !!status && status.connected > 0 && !!synced; }
    return { gapMiddle, openMiddle, tapSelect, deliveryPill, movePill, playerTag, conflictPlan, turnOwners, myTurnIndex, coachHint, jokerPick, awayAllowed, COACH };
  })();
  if (typeof window === 'undefined' || !window.document) {
    if (typeof module !== 'undefined' && module.exports) module.exports = H;
    return;
  }

  const E = window.SDEngine;
  const N = window.SDNet || null;
  const B = window.SDBot || null;
  if (!E) {
    document.body.insertAdjacentHTML('afterbegin', '<p class="noscript">게임 파일을 불러오지 못했어요. 새로고침해 주세요.</p>');
    return;
  }
  const K = E.CONSTANTS;
  const COLORS = K.COLORS;
  const TOKENS = K.TOKENS;
  const PAY = COLORS.concat(['pearl']);
  const CN = { white: '하양', blue: '파랑', green: '초록', red: '빨강', black: '검정', pearl: '진주', gold: '금' };
  const CUT = { white: '브릴리언트 컷', blue: '쿠션 컷', green: '에메랄드 컷', red: '오벌 컷', black: '육각 컷', pearl: '광택 점', gold: '금괴 문양' };
  const KAKAO = /KAKAOTALK/i.test(navigator.userAgent || '');
  const RM = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  // 폰 배치(세로 폰 · 가로 폰): 상대 줄 요약, 왕실 카드를 레벨 3 줄 안에, 위쪽 막대 없음. css/style.css 의 같은 조건과 맞춰야 함
  const COMPACT_Q = '(max-width: 599px), (orientation: landscape) and (max-height: 500px)';
  const MQ = window.matchMedia ? window.matchMedia(COMPACT_Q) : null;
  const EMOTES = ['👍', '😮', '😂', '😭', '❤️', '🔥'];
  const ROMAN = ['', 'Ⅰ', 'Ⅱ', 'Ⅲ'];
  const QS = new URLSearchParams(location.search);
  const DEBUG = QS.get('debug') === '1';
  const ABIL_SHORT = { extra_turn: '한 번 더', bonus_token: '같은 색 토큰', steal: '토큰 뺏기', privilege: '특권' };
  const ROYAL_ABIL = { extra_turn: '한 번 더', steal: '토큰 1개 뺏기', privilege: '특권 1개' };

  // ───────── 작은 도구 ─────────
  const $ = (s, r) => (r || document).querySelector(s);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const sumT = (t) => TOKENS.reduce((n, k) => n + ((t && t[k]) || 0), 0);
  const isGem = (t) => !!t && t !== 'gold';
  const store = {
    get(k, d) {
      try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; }
    },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* 저장 불가 */ } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { /* 무시 */ } },
  };
  function rand32() {
    try { const a = new Uint32Array(1); crypto.getRandomValues(a); return a[0]; } catch (e) { return Math.floor(Math.random() * 4294967296) >>> 0; }
  }
  function randHex(n) { let s = ''; while (s.length < n) s += rand32().toString(16).padStart(8, '0'); return s.slice(0, n); }
  function setHTML(el, html) {
    if (!el) return;
    if (el._html === html) return;
    el._html = html;
    el.innerHTML = html;
  }
  function ago(ms) {
    const d = Math.max(0, Date.now() - ms) / 1000;
    if (d < 60) return '방금';
    if (d < 3600) return Math.floor(d / 60) + '분 전';
    if (d < 86400) return Math.floor(d / 3600) + '시간 전';
    return Math.floor(d / 86400) + '일 전';
  }
  const use = (id, cls) => `<svg class="${cls || ''}" aria-hidden="true" focusable="false"><use href="#${id}"/></svg>`;
  const tok = (t, cls) => use('tk-' + t, cls);
  const ico = (n, cls) => use('ic-' + n, cls);
  const pip = (t, n) => `<span class="pip p-${t}">${use('pp-' + t)}<b>${n}</b></span>`;

  // ───────── 기기 설정 ─────────
  let deviceId = store.get('sd.device', null);
  if (typeof deviceId !== 'string' || !deviceId) { deviceId = 'd' + randHex(15); store.set('sd.device', deviceId); }

  const S = {
    screen: 'home',
    name: String(store.get('sd.name', '') || ''),
    sound: store.get('sd.sound', true) !== false,
    mode: null, // 'online' | 'local' | 'bot'
    game: null,
    ui: freshUI(),
    sheet: null,
    fx: null,
    counts: {},
    lastBottom: null,
    resultKey: null,
    viewBoard: false,
    invite: null,
    // 온라인
    room: null, code: null, doc: null, seat: null, spectator: false, full: false,
    peers: {}, status: { connected: 0, total: 0 }, everConnected: false, joinAt: 0,
    gotRemote: false, claiming: false, presSeat: undefined,
    synced: false, everSynced: false, delivery: null, pillTimer: null, takeoverRef: null,
    moveRef: null, // 마지막으로 보낸 내 수 {seq, nonce} (보내기 표시는 이 커밋에만)
    oppOnline: null, oppOfflineSince: 0,
    compact: !!(MQ && MQ.matches),
    coach: store.get('sd.coach', null),
    selLast: null,
    tunnelBase: null, tunnelTries: 0, tick: null,
    // 봇
    botSeat: 1, botLevel: 'normal', botTimer: null,
    // 디버그 자동 진행
    auto: null, autoTimer: null,
    pendingOpened: null,
  };
  function freshUI() { return { sel: [], mode: null, reserve: null, goldCell: null, shake: null }; }

  // ───────── 소리 · 진동 ─────────
  let audioCtx = null;
  function getAudio() {
    if (audioCtx) return audioCtx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    try { audioCtx = new AC(); } catch (e) { audioCtx = null; }
    return audioCtx;
  }
  document.addEventListener('pointerdown', () => {
    if (!S.sound) return;
    const c = getAudio();
    if (c && c.state === 'suspended') c.resume().catch(() => {});
  }, { passive: true });
  function chime(kind) {
    if (!S.sound) return;
    const ctx = getAudio();
    if (!ctx || ctx.state !== 'running') return;
    const notes = kind === 'win' ? [523.25, 659.25, 783.99, 1046.5] : [659.25, 987.77];
    const t0 = ctx.currentTime + 0.02;
    notes.forEach((f, i) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'sine';
      o.frequency.value = f;
      const t = t0 + i * 0.13;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.16, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.9);
      o.connect(g);
      g.connect(ctx.destination);
      o.start(t);
      o.stop(t + 1);
    });
  }
  function vibrate(p) { try { if (navigator.vibrate) navigator.vibrate(p); } catch (e) { /* 무시 */ } }

  // ───────── 토스트 · 이모티콘 ─────────
  function toast(msg, kind) {
    if (!msg) return;
    const root = $('#toast-root');
    const last = root.lastElementChild;
    if (last && last.textContent === msg && !last.classList.contains('out')) return;
    const el = document.createElement('div');
    el.className = 'toast ' + (kind || '');
    el.textContent = msg;
    root.appendChild(el);
    while (root.children.length > 2) root.firstElementChild.remove();
    setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 260); }, 2600);
  }
  function floatEmote(e, fromTop, label) {
    const layer = $('#emote-layer');
    const el = document.createElement('div');
    el.className = 'emote-fly' + (fromTop ? ' from-top' : '');
    el.innerHTML = esc(e) + (label ? `<small>${esc(label)}</small>` : '');
    const w = window.innerWidth;
    el.style.left = Math.round(w * (0.18 + Math.random() * 0.55)) + 'px';
    el.style.top = fromTop ? '70px' : Math.max(120, window.innerHeight - 190) + 'px';
    layer.appendChild(el);
    setTimeout(() => el.remove(), 2700);
  }

  // ───────── 카드 그리기 ─────────
  function cardShort(c, jokerColor) {
    let col;
    if (c.bonus === 'joker') col = jokerColor ? `조커(${CN[jokerColor]})` : '조커';
    else if (!c.bonus) col = '점수';
    else col = CN[c.bonus] + (c.bonusCount === 2 ? ' 2보너스' : '');
    return col + (c.points ? ` ${c.points}점` : '');
  }
  function costText(cost) {
    const parts = PAY.filter((t) => cost[t] > 0).map((t) => `${CN[t]} ${cost[t]}`);
    return parts.length ? parts.join(', ') : '없음';
  }
  function cardLabel(c) {
    let s = `레벨 ${c.level} ${cardShort(c)} 카드`;
    if (c.crowns) s += `, 왕관 ${c.crowns}개`;
    if (c.ability) s += `, 능력: ${ABIL_SHORT[c.ability]}`;
    return s + `, 비용: ${costText(c.cost)}`;
  }
  function abilityIcon(c) {
    switch (c.ability) {
      case 'extra_turn': return `<span class="abil" title="한 번 더">${ico('extra')}</span>`;
      case 'bonus_token': return `<span class="abil bt" title="같은 색 토큰 1개">${tok(c.bonus === 'joker' ? 'joker' : c.bonus)}</span>`;
      case 'steal': return `<span class="abil" title="토큰 뺏기">${ico('steal')}</span>`;
      case 'privilege': return `<span class="abil" title="특권 1개">${ico('scroll')}</span>`;
      default: return '';
    }
  }
  function cardHTML(id, o) {
    o = o || {};
    const c = E.cardById(id);
    if (!c) return '';
    const tag = o.button ? 'button' : 'div';
    const b = c.bonus === null ? 'none' : c.bonus;
    let bon = '';
    if (c.bonus === 'joker') bon = o.jokerColor ? tok(o.jokerColor) : use('tk-joker');
    else if (c.bonus) bon = tok(c.bonus).repeat(c.bonusCount);
    const crowns = c.crowns ? `<span class="crowns">${ico('crown').repeat(c.crowns)}</span>` : '';
    const types = PAY.filter((t) => c.cost[t] > 0);
    const n4 = types.length >= 4;
    const cost = `<span class="cost${n4 ? ' n4' : ''}">${types.map((t) => pip(t, c.cost[t])).join('')}</span>`;
    // 비용이 네 가지면 2×2 비용 칸이 레벨 점 자리까지 차지하므로 레벨 점은 뺌 (줄 위치로 레벨을 알 수 있음)
    const lvl = n4 ? '' : `<span class="lvl">${'<i></i>'.repeat(c.level)}</span>`;
    return `<${tag} ${o.button ? 'type="button" ' : ''}class="card b-${b}${n4 ? ' n4' : ''} ${o.cls || ''}" ${o.attrs || ''} aria-label="${esc((o.label ? o.label + ' ' : '') + cardLabel(c))}">` +
      `<span class="band"><span class="pts${c.points ? '' : ' zero'}">${c.points}</span><span class="bon">${bon}</span></span>` +
      `<span class="meta">${crowns}${abilityIcon(c)}</span>${cost}${lvl}</${tag}>`;
  }
  function backHTML(level, o) {
    o = o || {};
    const tag = o.button ? 'button' : 'div';
    return `<${tag} ${o.button ? 'type="button" ' : ''}class="cardback ${o.cls || ''}" ${o.attrs || ''} aria-label="레벨 ${level} 카드 뒷면"><span class="roman">${ROMAN[level]}</span><span class="lvl">${'<i></i>'.repeat(level)}</span></${tag}>`;
  }
  function royalHTML(id, o) {
    o = o || {};
    const r = E.royalById(id);
    const tag = o.button ? 'button' : 'div';
    let body;
    if (r.ability === 'extra_turn') body = `<span class="abil">${ico('extra')}</span>`;
    else if (r.ability === 'steal') body = `<span class="abil">${ico('steal')}</span>`;
    else if (r.ability === 'privilege') body = `<span class="abil">${ico('scroll')}</span>`;
    else body = `<span class="none">능력 없음</span>`;
    const label = `왕실 카드 ${r.points}점` + (r.ability ? `, ${ROYAL_ABIL[r.ability]}` : '');
    return `<${tag} ${o.button ? 'type="button" ' : ''}class="royal ${o.cls || ''}" ${o.attrs || ''} aria-label="${label}"><span class="band"><span class="pts">${r.points}</span>${ico('crown')}</span><span class="rbody">${body}</span></${tag}>`;
  }

  // ───────── 모드별 판단 ─────────
  function isMe(p) {
    if (S.mode === 'online') return !S.spectator && S.seat === p;
    if (S.mode === 'bot') return p !== S.botSeat;
    return false;
  }
  function isBot(p) { return S.mode === 'bot' && p === S.botSeat; }
  function nameOf(p) {
    const g = S.game;
    if (isBot(p)) return '봇';
    return g ? g.players[p].name : '';
  }
  function who(p) { return isMe(p) ? '내가' : isBot(p) ? '봇이' : nameOf(p) + '님이'; }
  function topic(p) { return isMe(p) ? '나는' : isBot(p) ? '봇은' : nameOf(p) + '님은'; }
  function whose(p) { return isMe(p) ? '내' : isBot(p) ? '봇의' : nameOf(p) + '님의'; }
  function fromWhom(p) { return isMe(p) ? '나에게서' : isBot(p) ? '봇에게서' : nameOf(p) + '님에게서'; }
  function turnName(p) { return isMe(p) ? '내' : isBot(p) ? '봇' : nameOf(p) + '님'; }
  function toWhom(p) { return isMe(p) ? '나에게' : isBot(p) ? '봇에게' : nameOf(p) + '님에게'; }

  function viewSeat() {
    const g = S.game;
    if (S.mode === 'online') return S.seat == null ? 0 : S.seat;
    if (S.mode === 'bot') return 1 - S.botSeat;
    return g ? g.turn.player : 0;
  }
  // 온라인에서 내 차례이지만 아직 중계 서버의 최신 문서를 확인하지 못함 (옛 캐시 위에서 두지 않게)
  function unsyncedTurn() {
    const g = S.game;
    return S.mode === 'online' && !!g && !g.over && S.seat != null && !S.spectator && g.turn.player === S.seat && !S.synced;
  }
  function syncMsg() { return S.everSynced ? '다시 연결하는 중… 잠시 후 이어서 둘 수 있어요.' : '방에 연결하는 중… 잠시 후 이어서 둘 수 있어요.'; }
  function canAct() {
    const g = S.game;
    if (!g || g.over) return false;
    if (S.mode === 'online') return S.seat != null && !S.spectator && g.turn.player === S.seat && S.synced;
    if (S.mode === 'bot') return g.turn.player !== S.botSeat;
    return S.mode === 'local';
  }
  function canSee(p, entry) {
    if (!entry.fromDeck) return true;
    if (S.game && S.game.over) return true;
    if (S.mode === 'local') return true;
    return isMe(p);
  }
  function notYourTurnMsg() {
    const g = S.game;
    if (!g) return '';
    if (g.over) return '게임이 끝났어요.';
    if (S.mode === 'online' && (S.spectator || S.seat == null)) return '관전 중에는 둘 수 없어요.';
    if (unsyncedTurn()) return syncMsg();
    if (isBot(g.turn.player)) return '지금은 봇 차례예요. 잠시만 기다려 주세요.';
    return `지금은 ${nameOf(g.turn.player)}님 차례예요.`;
  }

  // ───────── 최근 행동 강조 ─────────
  const turnOwners = H.turnOwners;
  function highlights(g, viewer) {
    const own = turnOwners(g);
    const cur = g.turn.number;
    const turns = new Set();
    let n = cur;
    let target;
    if (viewer === 0 || viewer === 1) {
      target = 1 - viewer;
      if (own[cur] === viewer) n = cur - 1;
    } else {
      turns.add(cur);
      n = cur - 1;
      target = own[n];
    }
    while (n >= 1 && own[n] === target && turns.size < 4) { turns.add(n); n--; }
    const evs = g.log.filter((e) => turns.has(e.turnNo) && e.t !== 'turn');
    const hl = { evs, taken: new Map(), fresh: new Set(), refill: new Set(), card: null, stolen: new Set(), resNew: false, royal: null };
    for (const e of evs) {
      if (e.t === 'take') e.cells.forEach((c, i) => hl.taken.set(c, e.tokens[i]));
      else if ((e.t === 'privilege' || e.t === 'bonusToken') && e.cell != null) hl.taken.set(e.cell, e.token);
      else if (e.t === 'replenish') e.cells.forEach((c) => hl.fresh.add(c));
      else if (e.t === 'reserve') {
        hl.taken.set(e.goldCell, 'gold');
        if (e.source.from === 'pyramid') hl.refill.add(e.source.level + '-' + e.source.slot);
        hl.resNew = true;
        if (!e.fromDeck || S.mode === 'local') hl.card = { id: e.cardId, kind: 'reserve' };
        else hl.card = { back: e.source.level, kind: 'reserve' };
      } else if (e.t === 'buy') {
        if (e.source.from === 'pyramid') hl.refill.add(e.source.level + '-' + e.source.slot);
        hl.card = { id: e.cardId, kind: 'buy', joker: e.jokerColor };
      } else if (e.t === 'steal' && !e.skipped) hl.stolen.add(e.from + '-' + e.token);
      else if (e.t === 'royal' && !e.skipped) hl.royal = e.id;
    }
    // 새로 채운 칸에서 다시 가져간 경우는 가져간 표시가 우선
    return hl;
  }

  // ───────── 이벤트 → 한국어 문장 ─────────
  function tokenList(tokens) {
    const cnt = {};
    tokens.forEach((t) => { cnt[t] = (cnt[t] || 0) + 1; });
    return TOKENS.filter((t) => cnt[t]).map((t) => `${CN[t]} ${cnt[t]}개`).join(', ');
  }
  function tokenObjList(obj) {
    return TOKENS.filter((t) => obj[t] > 0).map((t) => `${CN[t]} ${obj[t]}개`).join(', ');
  }
  function reasonText(over) {
    if (!over) return '';
    if (over.reason === 'points') return '20점 달성';
    if (over.reason === 'crowns') return '왕관 10개';
    if (over.reason === 'color') return `${CN[over.color]} 카드로 10점`;
    if (over.reason === 'resign') return '기권';
    return '';
  }
  function describe(e) {
    const p = e.p;
    switch (e.t) {
      case 'privilege': return `${who(p)} 특권을 써서 ${CN[e.token]} 토큰을 가져왔어요.`;
      case 'replenish': return `${who(p)} 보드를 채웠어요. (토큰 ${e.cells.length}개)`;
      case 'take': return `${who(p)} 토큰 ${tokenList(e.tokens)}를 가져왔어요.`;
      case 'gainPrivilege': {
        if (e.from === 'none') return `${topic(p)} 이미 특권이 3개라 더 받지 않았어요.`;
        const why = { penalty: '같은 색 3개·진주 2개 규칙으로', replenish: '보드 채우기 규칙으로', ability: '카드 능력으로', royal: '왕실 카드 능력으로' }[e.reason] || '';
        if (e.from === 'opponent') return `${who(p)} ${why} ${fromWhom(1 - p)} 특권 1개를 가져왔어요.`;
        return `${who(p)} ${why} 특권 1개를 받았어요.`;
      }
      case 'reserve': {
        if (e.fromDeck) return `${who(p)} 레벨 ${e.source.level} 더미에서 카드 1장을 몰래 예약하고 금 1개를 가져왔어요.`;
        const c = E.cardById(e.cardId);
        return `${who(p)} 레벨 ${c.level} ${cardShort(c)} 카드를 예약하고 금 1개를 가져왔어요.`;
      }
      case 'buy': {
        const c = E.cardById(e.cardId);
        const from = e.source.from === 'reserved' ? '예약해 둔 ' : '';
        const paid = tokenObjList(e.payment);
        return `${who(p)} ${from}${cardShort(c, e.jokerColor)} 카드를 샀어요.` + (paid ? ` (${paid} 냄)` : '');
      }
      case 'bonusToken':
        if (e.skipped) return `보드에 ${CN[e.token]} 토큰이 없어서 카드 능력을 건너뛰었어요.`;
        return `${who(p)} 카드 능력으로 ${CN[e.token]} 토큰 1개를 가져왔어요.`;
      case 'steal':
        if (e.skipped) return `${topic(e.from)} 가져갈 보석이나 진주가 없어서 능력을 건너뛰었어요.`;
        return `${who(p)} ${whose(e.from)} ${CN[e.token]} 토큰을 가져갔어요.`;
      case 'royal': {
        if (e.skipped) return '남은 왕실 카드가 없어서 넘어갔어요.';
        const r = E.royalById(e.id);
        return `${who(p)} 왕실 카드(${r.points}점${r.ability ? ' · ' + ROYAL_ABIL[r.ability] : ''})를 얻었어요.`;
      }
      case 'discard': return `${who(p)} 토큰 ${tokenObjList(e.tokens)}를 주머니에 돌려놨어요.`;
      case 'extraTurn': return `${who(p)} 한 번 더 해요!`;
      case 'pass': return `${who(p)} 할 수 있는 행동이 없어서 차례를 넘겼어요.`;
      case 'resign': return `${who(p)} 기권했어요.`;
      case 'win': return `${who(p)} 이겼어요! (${reasonText({ reason: e.reason, color: e.color })})`;
      default: return null;
    }
  }

  // ───────── 공통 행동 적용 ─────────
  function act(action, opts) {
    opts = opts || {};
    const g = S.game;
    if (!g) return false;
    const r = E.apply(g, action);
    if (!r.ok) { toast(r.error, 'bad'); return false; }
    if (!opts.keepUI) S.ui = freshUI();
    else { S.ui.sel = []; }
    // 기권은 seq 를 2 올려서, 동시에 올라온 상대의 보통 수보다 앞서게 함
    commitState(r.state, r.events, action.type === 'resign' ? { jump: 2 } : null);
    return true;
  }
  function commitState(next, events, copts) {
    if (S.mode === 'online') {
      if (!S.room) return;
      const d = S.room.doc || S.doc || {};
      try {
        setMoveRef(S.room.commit({ seats: d.seats || [null, null], game: next, prevLoser: d.prevLoser == null ? null : d.prevLoser }, copts || undefined));
      } catch (e) {
        console.error(e);
        toast('보내지 못했어요. 다시 시도해 주세요.', 'bad');
      }
      return;
    }
    const prev = S.game;
    S.game = next;
    saveLocal();
    onGameChanged(prev, next, events);
  }

  function freshEvents(prev, next) {
    if (!prev || !next) return [];
    const pl = prev.log || [];
    const nl = next.log || [];
    if (!pl.length) return nl.slice();
    const k1 = JSON.stringify(pl[pl.length - 1]);
    const k2 = pl.length > 1 ? JSON.stringify(pl[pl.length - 2]) : null;
    for (let i = nl.length - 1; i >= 0; i--) {
      if (JSON.stringify(nl[i]) !== k1) continue;
      if (k2 && i > 0 && JSON.stringify(nl[i - 1]) !== k2) continue;
      return nl.slice(i + 1);
    }
    return nl.filter((e) => e.turnNo >= prev.turn.number);
  }
  function isNewGame(prev, next) {
    if (!prev || !next) return true;
    if (next.turn.number < prev.turn.number) return true;
    if (prev.over && !next.over) return true;
    for (let p = 0; p < 2; p++) if (next.players[p].cards.length < prev.players[p].cards.length) return true;
    return false;
  }
  function gameKey(g) { return g ? g.turn.number + ':' + (g.over ? g.over.winner + g.over.reason : '') + ':' + g.rng : ''; }

  function onGameChanged(prev, next, events) {
    if (!next) { render(); return; }
    const fresh = isNewGame(prev, next);
    if (fresh) {
      S.ui = freshUI();
      S.viewBoard = false;
      S.fx = null;
      S.counts = {};
      S.pendingOpened = null;
      if (S.sheet && S.sheet.kind !== 'rules' && S.sheet.kind !== 'menu') closeSheet(true);
    } else {
      const evs = events || freshEvents(prev, next);
      if (evs.length) S.fx = { evs, at: Date.now(), done: {} };
      if (prev.turn.number !== next.turn.number || prev.pending.length !== next.pending.length) {
        const keepPriv = S.ui.mode === 'privilege' && prev.turn.number === next.turn.number;
        S.ui = freshUI();
        if (keepPriv) S.ui.mode = 'privilege';
      }
    }
    // 내 차례 알림 (온라인)
    if (S.mode === 'online' && prev && !fresh) {
      const was = !prev.over && prev.turn.player === S.seat;
      const now = !next.over && next.turn.player === S.seat && !S.spectator;
      if (now && !was) { chime(); vibrate([70, 50, 70]); }
    }
    // 게임이 막 끝났으면 잠깐 보드를 보여 주고 결과로
    if (next.over) {
      const key = gameKey(next);
      if (S.resultKey !== key) {
        if (prev && !prev.over && !fresh) {
          const iWon = isMe(next.over.winner) || S.mode === 'local';
          setTimeout(() => {
            if (!S.game || gameKey(S.game) !== key) return;
            S.resultKey = key;
            if (iWon) chime('win');
            route();
          }, 1500);
        } else S.resultKey = key;
      }
      if (S.mode !== 'online') store.del('sd.local');
      if (S.coach && typeof S.coach === 'object') setCoach('done'); // 첫 게임이 끝나면 안내도 끝
    }
    scheduleBot();
    tickAuto();
    route();
  }

  // ───────── 화면 전환 ─────────
  function show(screen) {
    if (S.screen !== screen) {
      S.screen = screen;
      ['home', 'lobby', 'game', 'result'].forEach((k) => {
        const el = $('#scr-' + k);
        el.hidden = k !== screen;
        if (k === screen) { el.classList.remove('enter'); void el.offsetWidth; el.classList.add('enter'); }
      });
      window.scrollTo(0, 0);
      if (screen !== 'game') document.body.classList.remove('coaching');
      if (screen !== 'game' && S.sheet && !['rules', 'menu', 'confirm', 'hotseat', 'bot', 'log'].includes(S.sheet.kind)) closeSheet(true);
    }
    render();
  }
  function route() {
    if (!S.mode) return show('home');
    if (S.mode === 'online') {
      if (S.game && (S.seat != null || S.spectator)) {
        if (S.game.over && S.resultKey === gameKey(S.game) && !S.viewBoard) return show('result');
        return show('game');
      }
      return show('lobby');
    }
    if (!S.game) return show('home');
    if (S.game.over && S.resultKey === gameKey(S.game) && !S.viewBoard) return show('result');
    return show('game');
  }
  function render() {
    if (S.screen === 'home') renderHome();
    else if (S.screen === 'lobby') renderLobby();
    else if (S.screen === 'game') renderGame();
    else if (S.screen === 'result') renderResult();
    renderSheet();
    updateTitle();
  }
  function updateTitle() {
    const g = S.game;
    const mine = S.mode === 'online' && g && !g.over && S.seat != null && !S.spectator && g.turn.player === S.seat;
    const t = mine ? '● 내 차례 · 스플렌더 대결' : '스플렌더 대결';
    if (document.title !== t) document.title = t;
  }

  // ───────── 홈 ─────────
  function myName() { return (S.name || '').trim(); }
  function renderHome() {
    const root = $('#home-root');
    const key = (S.invite || '') + '|' + (S.otherWays ? 1 : 0);
    if (!root._built || root._key !== key) {
      root._built = true;
      root._key = key;
      const nameField = (hint) => `<div class="field"><label for="in-name">내 이름</label>
            <input id="in-name" class="input" maxlength="12" autocomplete="nickname" enterkeyhint="${hint}" placeholder="예: 지은" value="${esc(S.name)}"></div>`;
      // 카카오톡 안의 브라우저는 저장 공간이 따로라 나중에 이어하기가 안 될 수 있음
      const kakao = KAKAO ? `<div class="note kakao">카카오톡 안에서 열렸어요. 계속 이어서 하려면 Safari/Chrome으로 여는 게 좋아요
          <button type="button" class="btn small block" data-a="open-external">${ico('globe')} 다른 브라우저로 열기</button></div>` : '';
      const others = `
        <div class="panel home-card">
          ${S.invite ? '' : nameField('done')}
          <button type="button" class="btn primary block" data-a="create">${ico('globe')} 온라인 방 만들기</button>
          <div class="or">또는 받은 코드로 참가</div>
          <div class="row">
            <input id="in-code" class="input code grow" autocapitalize="characters" autocomplete="off" autocorrect="off" spellcheck="false" enterkeyhint="go" placeholder="ABC234" aria-label="방 코드 6글자">
            <button type="button" class="btn" data-a="join-code">참가</button>
          </div>
        </div>
        <div id="resume-box"></div>
        <div class="mode-grid">
          <button type="button" class="mode-btn" data-a="hotseat">${ico('people')}<b>한 기기로 둘이 하기</b><small>폰 하나를 번갈아 넘기며 해요</small></button>
          ${B ? `<button type="button" class="mode-btn" data-a="bot">${ico('bot')}<b>봇과 연습하기</b><small>쉬움 · 보통 중에 골라요</small></button>` : ''}
        </div>`;
      let body;
      if (S.invite) {
        // 초대 링크로 왔으면: 이름 → 바로 아래 참가하기. 다른 방법(방 만들기 등)은 접어 둠
        body = `
        <div class="panel home-card invite-card">
          <h2>초대받았어요!</h2>
          <p class="hint" style="margin:0">초대받은 방(<span class="code-inline">${esc(S.invite)}</span>)에 들어가려면 이름을 적고 참가하기를 눌러요.</p>
          ${nameField('go')}
          <button type="button" class="btn primary block" data-a="invite-join">${ico('arrow')} 참가하기</button>
          ${kakao}
        </div>
        <button type="button" class="btn ghost block" data-a="other-ways" aria-expanded="${S.otherWays ? 'true' : 'false'}">다른 방법으로 시작하기</button>
        ${S.otherWays ? others : ''}`;
      } else body = (kakao ? `<div class="panel home-card">${kakao}</div>` : '') + others;
      root.innerHTML = `
        <header class="brand">${use('ic-gem', 'logo')}<h1>스플렌더 대결</h1><p>둘이서 즐기는 보석 대결 · 링크 하나로 바로 시작해요</p></header>
        ${body}
        <div class="home-foot">
          <button type="button" class="linkish" data-a="rules">${ico('book')} 규칙 보기</button>
          <button type="button" class="linkish" data-a="sound" id="home-sound"></button>
        </div>`;
    }
    const sb = $('#home-sound');
    if (sb) setHTML(sb, S.sound ? `${ico('sound')} 소리 켜짐` : `${ico('mute')} 소리 꺼짐`);
    const rb = $('#resume-box');
    if (rb) setHTML(rb, resumeHTML());
  }
  function recentRooms() {
    const list = store.get('sd.recent', []);
    return Array.isArray(list) ? list.filter((r) => r && typeof r.code === 'string') : [];
  }
  function addRecent(code) {
    const list = recentRooms().filter((r) => r.code !== code);
    list.unshift({ code, at: Date.now() });
    store.set('sd.recent', list.slice(0, 8));
  }
  function resumeHTML() {
    const items = [];
    const loc = store.get('sd.local', null);
    if (loc && loc.game && !loc.game.over) {
      const g = loc.game;
      const title = loc.mode === 'bot' ? `봇과 연습 (${loc.botLevel === 'easy' ? '쉬움' : '보통'})` : `${g.players[0].name} vs ${g.players[1].name}`;
      const sub = (loc.mode === 'bot' ? '봇과 연습 · ' : '한 기기로 둘이 · ') + `${g.turn.number}번째 차례 · ${ago(loc.at || 0)}`;
      items.push(`<div class="resume-item"><button type="button" class="resume-main" data-a="resume-local"><span class="resume-ico">${ico(loc.mode === 'bot' ? 'bot' : 'people')}</span><span class="resume-txt"><b>${esc(title)}</b><small>${esc(sub)}</small></span>${ico('arrow', 'chev')}</button><button type="button" class="resume-x" data-a="local-remove" aria-label="이 게임 지우기">${ico('close')}</button></div>`);
    }
    for (const r of recentRooms()) {
      let doc = null;
      try { const raw = localStorage.getItem('sd.room.' + r.code); doc = raw ? JSON.parse(raw) : null; } catch (e) { doc = null; }
      const seats = (doc && doc.seats) || [null, null];
      const mine = seats.findIndex((s) => s && s.deviceId === deviceId);
      const opp = mine >= 0 ? seats[1 - mine] : null;
      const g = doc && doc.game;
      let pill = '<span class="pill">대기 중</span>';
      if (g) {
        if (g.over) pill = '<span class="pill done">끝난 판</span>';
        else if (mine >= 0 && g.turn.player === mine) pill = '<span class="pill me">내 차례</span>';
        else pill = '<span class="pill">상대 차례</span>';
      }
      const oppName = opp ? `${opp.name}님과` : (mine >= 0 ? '상대를 기다리는 중' : '참가 전');
      const when = doc && doc.at ? ago(doc.at) : ago(r.at);
      items.push(`<div class="resume-item"><button type="button" class="resume-main" data-a="resume-room" data-code="${esc(r.code)}"><span class="resume-ico">${ico('globe')}</span><span class="resume-txt"><b>${esc(oppName)}</b><small>방 ${esc(r.code)} · ${esc(when)}</small></span>${pill}</button><button type="button" class="resume-x" data-a="room-remove" data-code="${esc(r.code)}" aria-label="방 ${esc(r.code)} 목록에서 지우기">${ico('close')}</button></div>`);
    }
    if (!items.length) return '';
    return `<div class="panel home-card"><h2>이어하기</h2><div class="resume-list">${items.join('')}</div></div>`;
  }
  function needName() {
    const inp = $('#in-name');
    if (inp) S.name = inp.value.trim().slice(0, 12);
    if (myName()) { store.set('sd.name', S.name); return true; }
    toast('이름을 먼저 적어 주세요.', 'bad');
    if (inp) { inp.focus(); inp.classList.add('shake'); setTimeout(() => inp.classList.remove('shake'), 400); }
    return false;
  }

  // ───────── 온라인 ─────────
  function setUrlRoom(code) {
    try {
      const u = new URL(location.href);
      if (code) u.searchParams.set('room', code); else u.searchParams.delete('room');
      history.replaceState(null, '', u.toString());
    } catch (e) { /* file:// 등 */ }
  }
  function inviteLink() {
    let base;
    if (S.tunnelBase) base = S.tunnelBase + location.pathname;
    else if (location.protocol === 'file:') base = location.href.split(/[?#]/)[0];
    else base = location.origin + location.pathname;
    return base + '?room=' + S.code;
  }
  function fetchTunnel() {
    if (!/^https?:$/.test(location.protocol) || S.tunnelBase || S.tunnelTries > 40) return;
    S.tunnelTries++;
    fetch(location.origin + '/tunnel.json', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (!j) return;
        if (j.url && j.verified) { S.tunnelBase = String(j.url).replace(/\/+$/, ''); render(); }
        else if (j.status && j.status !== 'off' && j.status !== 'error' && S.mode === 'online') setTimeout(fetchTunnel, 4000);
      })
      .catch(() => {});
  }
  function enterRoom(code, create) {
    if (!N) { toast('온라인 모듈을 불러오지 못했어요. 새로고침해 주세요.', 'bad'); return; }
    leaveRoom();
    stopBot();
    Object.assign(S, {
      mode: 'online', code, game: null, doc: null, seat: null, spectator: false, full: false,
      peers: {}, status: { connected: 0, total: 0 }, everConnected: false, joinAt: Date.now(),
      gotRemote: false, claiming: false, presSeat: undefined, oppOnline: null, oppOfflineSince: 0,
      synced: false, everSynced: false, delivery: null, takeoverRef: null, moveRef: loadMoveRef(code),
      ui: freshUI(), fx: null, counts: {}, resultKey: null, viewBoard: false, invite: null, pendingOpened: null,
    });
    addRecent(code);
    setUrlRoom(code);
    // net.js 의 resume() 은 이제 언제 불러도 안전해서 (연결 중에는 건드리지 않음) 바로 들어가요.
    try {
      S.room = N.join({ room: code, deviceId, name: myName(), onDoc, onPeers, onStatus, onEmote, onDelivery, onConflict });
    } catch (e) {
      toast(e.message || '방에 들어가지 못했어요.', 'bad');
      S.mode = null;
      show('home');
      return;
    }
    if (create) {
      try { S.room.commit({ seats: [{ deviceId, name: myName() }, null], game: null, prevLoser: null }); } catch (e) { console.error(e); }
    }
    fetchTunnel();
    clearInterval(S.tick);
    S.tick = setInterval(onTick, 2000);
    route();
  }
  function leaveRoom() {
    clearInterval(S.tick);
    clearTimeout(S.pillTimer);
    if (S.room) { try { S.room.leave(); } catch (e) { /* 무시 */ } }
    S.room = null;
    S.delivery = null;
    S.synced = false;
  }
  function goHome() {
    closeSheet(true);
    leaveRoom();
    stopBot();
    S.auto = null;
    S.mode = null;
    S.game = null;
    S.doc = null;
    S.code = null;
    setUrlRoom(null);
    try { sessionStorage.removeItem('sd.active'); } catch (e) { /* 무시 */ }
    show('home');
  }
  function onTick() {
    if (S.mode !== 'online') return;
    // 방을 못 찾는 경우 안내, 상대 오프라인 30초 안내 갱신
    render();
  }
  function onDoc(doc, info) {
    if (S.mode !== 'online' || !doc) return;
    const prevGame = S.game;
    S.doc = doc;
    if (info && info.source === 'remote') S.gotRemote = true;
    const seats = doc.seats || [null, null];
    const mine = seats.findIndex((s) => s && s.deviceId === deviceId);
    if (mine >= 0) {
      S.seat = mine;
      S.full = false;
      S.spectator = false;
    } else {
      const hadSeat = S.seat != null && !S.spectator;
      S.seat = null;
      const free = [0, 1].find((i) => !seats[i]);
      if (hadSeat && free === undefined && info && info.source === 'remote') {
        // 다른 기기가 내 자리를 이어받음 → 이 기기는 관전으로
        S.spectator = true;
        toast('다른 기기에서 내 자리를 이어받았어요. 이 기기는 관전으로 바뀌었어요.');
      }
      if (free !== undefined) {
        S.full = false;
        if (info && info.source !== 'cache' && !S.spectator) claimSeat(free);
      } else S.full = true;
    }
    if (S.presSeat !== S.seat && S.room) {
      S.presSeat = S.seat;
      try { S.room.setPresence({ name: myName(), seat: S.seat }); } catch (e) { /* 무시 */ }
    }
    S.game = doc.game || null;
    updatePeers();
    onGameChanged(prevGame, S.game, null);
    if (!S.game) route();
  }
  function claimSeat(free) {
    if (S.claiming) return;
    S.claiming = true;
    setTimeout(() => {
      S.claiming = false;
      if (S.mode !== 'online' || !S.room) return;
      const d = S.room.doc;
      if (!d) return;
      const seats = (d.seats || [null, null]).slice();
      if (seats[free] || seats.some((s) => s && s.deviceId === deviceId)) return;
      seats[free] = { deviceId, name: myName() || '손님' };
      let game = d.game || null;
      const prevLoser = d.prevLoser === 0 || d.prevLoser === 1 ? d.prevLoser : null;
      if (!game && seats[0] && seats[1]) {
        game = E.newGame({ names: [seats[0].name, seats[1].name], first: prevLoser != null ? prevLoser : (rand32() & 1), seed: rand32() });
      }
      try { S.room.commit({ seats, game, prevLoser }); } catch (e) { console.error(e); }
    }, 0);
  }
  function onPeers(peers) { S.peers = peers || {}; updatePeers(); render(); }
  function onStatus(st) {
    S.status = st || { connected: 0, total: 0 };
    if (S.status.connected > 0) S.everConnected = true;
    const was = S.synced;
    S.synced = !!(S.room ? S.room.synced : S.status.synced);
    if (S.synced) S.everSynced = true;
    if (was !== S.synced) {
      // 연결이 다시 확인되면 상대 자리 비움 시계를 새로 (내 쪽 문제였을 수 있음)
      if (S.synced && S.oppOnline === false) S.oppOfflineSince = Date.now();
      if (!S.synced) S.ui = freshUI();
    }
    render();
  }
  function onEmote(e) {
    if (!e || !e.emote) return;
    const seats = (S.doc && S.doc.seats) || [];
    const idx = seats.findIndex((s) => s && s.deviceId === e.from);
    const label = idx >= 0 ? seats[idx].name : '';
    floatEmote(e.emote, true, label);
  }
  function peerOnline(devId) {
    if (!devId) return false;
    if (devId === deviceId) return S.status.connected > 0;
    const p = S.peers[devId];
    return !!(p && p.online);
  }
  function updatePeers() {
    if (S.mode !== 'online' || S.seat == null || !S.doc) return;
    const opp = (S.doc.seats || [])[1 - S.seat];
    const on = opp ? peerOnline(opp.deviceId) : null;
    if (on === false && S.oppOnline !== false) S.oppOfflineSince = Date.now();
    S.oppOnline = on;
  }
  // 상대가 오프라인이라고 말해도 되는가: 내 연결이 멀쩡하고(연결됨 + 동기화됨) 상대 표시가 꺼졌을 때만
  function oppAway() {
    return S.mode === 'online' && !!S.game && !S.game.over && S.seat != null && !S.spectator &&
      S.oppOnline === false && H.awayAllowed(S.status, S.synced);
  }
  function seatOnline(p) {
    if (S.mode !== 'online' || !S.doc) return null;
    const s = (S.doc.seats || [])[p];
    return s ? peerOnline(s.deviceId) : false;
  }
  // ── 보내기 상태: net.js 의 room.delivery / onDelivery 만 믿음 ──
  // 내 수(게임 행동) 커밋만 기억 → 방 만들기·자리 잡기·새 판 준비·이어받기에는 알약이 안 나와요.
  // 새로고침 뒤에도 '보내는 중…' 이 이어지게 방 코드와 함께 저장.
  function setMoveRef(out) {
    if (!out || typeof out.seq !== 'number') return;
    S.moveRef = { seq: out.seq, nonce: out.nonce };
    store.set('sd.move', { room: S.code, seq: out.seq, nonce: out.nonce });
  }
  function loadMoveRef(code) {
    const m = store.get('sd.move', null);
    return m && m.room === code && typeof m.seq === 'number' ? { seq: m.seq, nonce: m.nonce } : null;
  }
  function onDelivery(d) {
    S.delivery = d || null;
    renderSendPill();
  }
  function sendPill() {
    if (S.mode !== 'online' || !S.room) return null;
    return H.movePill(S.delivery, S.moveRef, Date.now(), S.oppOnline);
  }
  const PILL_ICO = { done: 'check', warn: 'refill', soft: 'log' };
  function sendPillHTML() {
    const p = sendPill();
    if (!p || !p.text) return '';
    const ic = PILL_ICO[p.cls] ? ico(PILL_ICO[p.cls]) : '<span class="sp-dot" aria-hidden="true"></span>';
    return `<span class="sendpill${p.cls ? ' sp-' + p.cls : ''}" role="status">${ic}${esc(p.text)}</span>`;
  }
  // 알약은 행동 막대 안(글자 칸)에 있어요 → 막대만 다시 그림 + 다음 바뀔 때 다시
  function renderSendPill() {
    clearTimeout(S.pillTimer);
    if (S.screen !== 'game' || S.mode !== 'online' || !S.game) return;
    const v = view();
    sanitizeUI(v);
    setHTML($('#g-bar'), barHTML(v));
    markCoaching();
    schedulePill();
  }
  // 첫 게임 안내 중이면 세로 폰에서 막대가 한 줄 더 높아짐 → 화면 아래 여백도 (css body.coaching)
  function markCoaching() { document.body.classList.toggle('coaching', S.screen === 'game' && !!$('#g-bar .ab-inner.coaching')); }
  function schedulePill() {
    clearTimeout(S.pillTimer);
    const p = S.screen === 'game' ? sendPill() : null;
    if (p && p.next != null) S.pillTimer = setTimeout(renderSendPill, Math.max(50, p.next + 30));
  }
  function onConflict(info) {
    if (S.mode !== 'online' || !S.room || !info) return;
    const plan = H.conflictPlan(info.lost, info.winner, { deviceId, seat: S.seat, takeover: S.takeoverRef });
    if (plan.kind === 'resign') {
      // 내 기권이 상대 수에 밀렸음 → 이긴 문서 위에 기권을 다시 올림
      const w = info.winner;
      const r = E.apply(w.game, { type: 'resign', player: plan.player });
      if (r.ok) {
        try { setMoveRef(S.room.commit({ seats: w.seats, game: r.state, prevLoser: w.prevLoser == null ? null : w.prevLoser }, { jump: 2 })); } catch (e) { console.error(e); }
      }
      return;
    }
    if (plan.kind === 'takeover') { toast('자리 이어받기가 취소됐어요. 다시 눌러 주세요.', 'bad'); return; }
    if (plan.kind === 'silent') return;
    toast('상대가 먼저 둔 수가 있어서 내 수가 취소됐어요.', 'bad');
  }
  function rematch() {
    const g = S.game;
    if (!g || !g.over) return;
    const loser = 1 - g.over.winner;
    if (S.mode === 'online') {
      if (S.seat == null || S.spectator || !S.room) return;
      const d = S.room.doc;
      if (!d || !d.game || !d.game.over) return;
      const seats = d.seats;
      const game = E.newGame({ names: [seats[0].name, seats[1].name], first: loser, seed: rand32() });
      try { S.room.commit({ seats, game, prevLoser: loser }); } catch (e) { console.error(e); }
      return;
    }
    const names = g.players.map((p) => p.name);
    const prev = S.game;
    S.game = E.newGame({ names, first: loser, seed: rand32() });
    saveLocal();
    onGameChanged(prev, S.game, null);
  }
  function takeover(seat) {
    if (!S.room) return;
    const d = S.room.doc;
    if (!d || !d.seats || !d.seats[seat]) return;
    const seats = d.seats.slice();
    seats[seat] = { deviceId, name: seats[seat].name };
    S.spectator = false;
    let out = null;
    // seq 를 2 올려서, 예전 기기가 동시에 올린 보통 수보다 앞서게 함 (예전 기기는 onConflict 로 알게 됨)
    try { out = S.room.commit({ seats, game: d.game || null, prevLoser: d.prevLoser == null ? null : d.prevLoser }, { jump: 2 }); } catch (e) { console.error(e); }
    if (!out) { toast('자리를 이어받지 못했어요. 다시 시도해 주세요.', 'bad'); return; }
    S.takeoverRef = { seq: out.seq, nonce: out.nonce };
    toast(`${seats[seat].name} 자리를 이어받았어요.`, 'good');
  }

  // ───────── 로컬 · 봇 ─────────
  function saveLocal() {
    if (S.mode !== 'local' && S.mode !== 'bot') return;
    if (!S.game || S.game.over) return;
    store.set('sd.local', { mode: S.mode, game: S.game, botSeat: S.botSeat, botLevel: S.botLevel, at: Date.now() });
    try { sessionStorage.setItem('sd.active', 'local'); } catch (e) { /* 무시 */ }
  }
  function startLocal(mode, names, first, opts) {
    leaveRoom();
    setUrlRoom(null);
    stopBot();
    Object.assign(S, { mode, code: null, doc: null, seat: null, spectator: false, ui: freshUI(), fx: null, counts: {}, resultKey: null, viewBoard: false, pendingOpened: null, lastBottom: null });
    if (mode === 'bot') { S.botSeat = 1; S.botLevel = (opts && opts.level) || 'normal'; }
    S.game = E.newGame({ names, first, seed: rand32() });
    saveLocal();
    onGameChanged(null, S.game, null);
  }
  function resumeLocal() {
    const loc = store.get('sd.local', null);
    if (!loc || !loc.game) return false;
    if (loc.mode === 'bot' && !B) { toast('봇 파일을 불러오지 못해서 이어할 수 없어요.', 'bad'); return false; }
    leaveRoom();
    setUrlRoom(null);
    Object.assign(S, { mode: loc.mode === 'bot' ? 'bot' : 'local', botSeat: loc.botSeat === 0 ? 0 : 1, botLevel: loc.botLevel === 'easy' ? 'easy' : 'normal', code: null, doc: null, seat: null, spectator: false, ui: freshUI(), fx: null, counts: {}, resultKey: null, viewBoard: false, pendingOpened: null });
    S.game = loc.game;
    try { sessionStorage.setItem('sd.active', 'local'); } catch (e) { /* 무시 */ }
    onGameChanged(null, S.game, null);
    return true;
  }
  function stopBot() { clearTimeout(S.botTimer); S.botTimer = null; }
  function scheduleBot() {
    stopBot();
    const g = S.game;
    if (S.mode !== 'bot' || !B || !g || g.over || g.turn.player !== S.botSeat) return;
    S.botTimer = setTimeout(() => {
      S.botTimer = null;
      const cur = S.game;
      if (S.mode !== 'bot' || !cur || cur.over || cur.turn.player !== S.botSeat) return;
      let a = null;
      try { a = B.chooseAction(cur, { level: S.botLevel }); } catch (e) { console.error('[bot]', e); }
      let r = a ? E.apply(cur, a) : null;
      if (!r || !r.ok) {
        const legal = E.legalActions(cur);
        for (const la of legal) { r = E.apply(cur, la); if (r.ok) break; }
      }
      if (!r || !r.ok) return;
      commitState(r.state, r.events);
    }, 700);
  }

  // 디버그: 이 기기에서 둘 수 있는 차례를 봇이 대신 둠
  function tickAuto() {
    clearTimeout(S.autoTimer);
    if (!S.auto) return;
    S.autoTimer = setTimeout(() => {
      if (!S.auto) return;
      const g = S.game;
      if (g && !g.over && canAct() && !(S.mode === 'online' && S.delivery && S.delivery.state === 'pending')) {
        let a = null;
        try { a = B ? B.chooseAction(g, { level: S.auto.level || 'normal' }) : null; } catch (e) { a = null; }
        if (!a) a = E.legalActions(g)[0];
        if (a) { if (S.sheet && S.sheet.kind !== 'menu') closeSheet(true); act(a); }
      }
      tickAuto();
    }, S.auto.delay);
  }

  // ───────── 게임 화면 ─────────
  function view() {
    const g = S.game;
    const bottom = viewSeat();
    const cur = g.turn.player;
    const head = g.pending[0] || null;
    const can = canAct();
    const main = can && !head && !g.turn.mainDone;
    const mainPossible = E.mainActionPossible(g);
    const bagTotal = sumT(g.bag);
    const pl = g.players[cur];
    const gemsOnBoard = g.board.some(isGem);
    const canPriv = main && !g.turn.replenished && pl.privileges > 0 && gemsOnBoard;
    const canRefill = main && !g.turn.replenished && bagTotal > 0;
    const forced = main && !mainPossible;
    const viewer = S.mode === 'online' ? (S.spectator || S.seat == null ? -1 : S.seat) : bottom;
    const hl = highlights(g, viewer);
    return { g, bottom, top: 1 - bottom, cur, head, can, main, mainPossible, bagTotal, pl, canPriv, canRefill, forced, hl, gemsOnBoard };
  }
  function sanitizeUI(v) {
    const ui = S.ui;
    const g = v.g;
    if (!v.main) { ui.sel = []; if (ui.mode) { ui.mode = null; ui.reserve = null; ui.goldCell = null; } return; }
    if (ui.mode === 'privilege' && !v.canPriv) ui.mode = null;
    if (ui.mode === 'gold') {
      if (!g.board.includes('gold') || g.players[v.cur].reserved.length >= K.MAX_RESERVED) { ui.mode = null; ui.reserve = null; ui.goldCell = null; }
      else if (ui.goldCell != null && g.board[ui.goldCell] !== 'gold') ui.goldCell = null;
    }
    if (ui.sel.length) {
      ui.sel = ui.sel.filter((c) => isGem(g.board[c]));
      if (ui.sel.length && !E.validateTake(g, ui.sel).ok && H.openMiddle(g.board, ui.sel) == null) ui.sel = [];
    }
  }
  function fxOn(region) {
    if (!S.fx || Date.now() - S.fx.at > 2500) return false;
    if (S.fx.done[region]) return false;
    S.fx.done[region] = true;
    return true;
  }
  function bump(key, val) {
    const prev = S.counts[key];
    S.counts[key] = val;
    return prev !== undefined && prev !== val && S.fx && Date.now() - S.fx.at < 1500 ? ' bump' : '';
  }

  function renderGame() {
    const g = S.game;
    if (!g) return;
    const v = view();
    sanitizeUI(v);
    const swap = S.mode === 'local' && S.lastBottom != null && S.lastBottom !== v.bottom;
    S.lastBottom = v.bottom;
    document.body.classList.toggle('compact', S.compact);
    renderTopbar();
    renderNetbar();
    setHTML($('#g-opp'), playerHTML(v, v.top, 'top', swap));
    setHTML($('#g-banner'), bannerHTML(v));
    setHTML($('#g-market'), marketHTML(v));
    setHTML($('#g-board'), boardHTML(v));
    setHTML($('#g-me'), playerHTML(v, v.bottom, 'me', swap));
    setHTML($('#g-bar'), barHTML(v));
    markCoaching();
    schedulePill();
    // 해결해야 할 결정은 시트를 자동으로 한 번 열어 줌
    if (v.can && v.head && ['steal', 'royal', 'discard'].includes(v.head.kind)) {
      const key = gameKey(g) + ':' + v.head.kind + ':' + g.pending.length + ':' + g.log.length;
      if (S.pendingOpened !== key && (!S.sheet || S.sheet.kind !== 'pending')) {
        S.pendingOpened = key;
        setTimeout(() => { if (S.screen === 'game') openPendingSheet(); }, S.fx && Date.now() - S.fx.at < 800 ? 450 : 0);
      }
    }
    // 카드 능력으로 보드에서 토큰을 골라야 하면 보드가 보이게 (한 번만)
    if (v.can && v.head && v.head.kind === 'bonusToken') {
      const key = gameKey(g) + ':bt:' + g.log.length;
      if (S.btRevealed !== key) { S.btRevealed = key; setTimeout(revealBoard, 60); }
    }
  }
  // 보드가 화면 밖이면 보이게 스크롤 (이미 다 보이면 그대로)
  function revealBoard() {
    const b = $('#g-board');
    if (!b || !b.scrollIntoView || S.screen !== 'game') return;
    b.scrollIntoView({ behavior: RM && RM.matches ? 'auto' : 'smooth', block: 'nearest' });
  }
  function renderTopbar() {
    if (S.screen !== 'game' || !S.game) return;
    let title;
    if (S.mode === 'online') {
      const st = S.status.connected > 0 ? 'on' : 'off';
      // 보내기 알약은 행동 막대 안에 (여기에는 없음)
      title = `<span class="dot ${st}" title="${st === 'on' ? '중계 서버 연결됨' : '연결 끊김'}"></span><span class="ellip">방 <b>${esc(S.code)}</b>${S.spectator ? ' · 관전' : ''}</span>`;
    } else if (S.mode === 'bot') title = `<span class="ellip">봇과 연습 · ${S.botLevel === 'easy' ? '쉬움' : '보통'}</span>`;
    else title = `<span class="ellip">한 기기로 둘이</span>`;
    const emote = S.mode === 'online' && !S.spectator ? `<button type="button" class="icon-btn" data-a="emote" aria-label="이모티콘 보내기">${ico('smile')}</button>` : '';
    setHTML($('#g-top'), `<button type="button" class="icon-btn" data-a="menu" aria-label="메뉴">${ico('menu')}</button><div class="tb-title">${title}</div><button type="button" class="icon-btn" data-a="log" aria-label="지난 기록">${ico('log')}</button>${emote}`);
  }
  function renderNetbar() {
    const el = $('#g-net');
    if (S.mode !== 'online') { el.hidden = true; return; }
    let msg = '';
    let soft = false;
    const offline = typeof navigator.onLine === 'boolean' && !navigator.onLine;
    if (offline) msg = '인터넷 연결이 끊겼어요. 다시 연결되면 바로 이어서 할 수 있어요.';
    else if (S.status.connected === 0) {
      if (S.everConnected || Date.now() - S.joinAt > 7000) msg = '중계 서버와 연결이 끊겼어요. 다시 연결하는 중이에요…';
      else { msg = '중계 서버에 연결하는 중이에요…'; soft = true; }
    } else if (oppAway() && Date.now() - S.oppOfflineSince > 30000) {
      // 자리 비움 안내는 여기 한 곳에서만 (행동 막대·배너에는 없음)
      const opp = S.game.players[1 - S.seat].name;
      msg = `${opp}님이 잠시 자리를 비웠어요. 돌아오면 바로 이어져요.`;
      soft = true;
    }
    el.hidden = !msg;
    el.className = 'netbar' + (soft ? ' soft' : '');
    setHTML(el, esc(msg));
  }

  function playerHTML(v, p, pos, swap) {
    const g = v.g;
    const pl = g.players[p];
    const st = E.stats(g, p);
    const active = !g.over && g.turn.player === p;
    let tag = '';
    if (S.mode === 'online') tag = isMe(p) ? '나' : (S.spectator ? '' : '상대');
    else if (S.mode === 'bot') tag = isBot(p) ? (S.botLevel === 'easy' ? '봇 · 쉬움' : '봇 · 보통') : '나';
    let dot = '';
    if (S.mode === 'online') {
      const on = seatOnline(p);
      // 내 연결이 끊겼거나 확인 중이면 상대가 접속했는지 알 수 없음 → 회색 점 (상대 탓으로 보이지 않게)
      const unk = !isMe(p) && !H.awayAllowed(S.status, S.synced);
      const cls = unk ? 'unk' : on ? 'on' : 'off';
      const lbl = unk ? '연결 확인 중' : on ? '접속 중' : '오프라인';
      dot = `<span class="dot ${cls}" title="${lbl}" aria-label="${lbl}"></span>`;
    }
    const nm = isBot(p) ? '봇' : pl.name;
    tag = H.playerTag(nm, tag); // 이름이 '나' 면 '나 나' 가 되지 않게
    if (S.compact && (pos === 'top' || pos === 'me')) return stripHTML(v, p, pos, swap, { st, pl, nm, tag, dot, active });
    const stats = `<div class="pp-stats">
      <span class="stat pts${st.points >= 15 ? ' near' : ''}" title="점수 (20점이면 승리)"><b class="${bump(p + 'pts', st.points).trim()}">${st.points}</b><small>/20</small></span>
      <span class="stat${st.crowns >= 7 ? ' near' : ''}" title="왕관 (10개면 승리)">${ico('crown')}<b>${st.crowns}</b></span>
      <span class="stat" title="특권">${ico('scroll')}<b class="${bump(p + 'priv', pl.privileges).trim()}">${pl.privileges}</b></span></div>`;
    const gems = COLORS.map((c) => {
      const bn = st.bonuses[c];
      const cp = st.colorPoints[c];
      const t = pl.tokens[c];
      const lost = v.hl.stolen.has(p + '-' + c) ? ' lost' : '';
      return `<div class="gcol" title="${CN[c]}: 보너스 ${bn}, 토큰 ${t}${cp ? `, ${CN[c]} 점수 ${cp}` : ''}">
        <div class="bchip c-${c}${bn ? '' : ' zero'}">${bn}${cp ? `<span class="cpts${cp >= 7 ? ' near' : ''}">${cp}점</span>` : ''}</div>
        <div class="tchip${t ? '' : ' zero'}${lost}${bump(p + c, t)}">${tok(c)}<b>${t}</b></div></div>`;
    }).join('') + ['pearl', 'gold'].map((c) => {
      const t = pl.tokens[c];
      const lost = v.hl.stolen.has(p + '-' + c) ? ' lost' : '';
      return `<div class="gcol" title="${CN[c]} 토큰 ${t}"><div class="bchip empty-slot"></div><div class="tchip${t ? '' : ' zero'}${lost}${bump(p + c, t)}">${tok(c)}<b>${t}</b></div></div>`;
    }).join('');
    const total = sumT(pl.tokens);
    const royals = pl.royals.length ? `<span class="owned-royals">${pl.royals.map((id) => { const r = E.royalById(id); return `<span class="mini-royal" title="왕실 카드 ${r.points}점">${ico('crown')}${r.points}</span>`; }).join('')}</span>` : '';
    const cardsBtn = `<button type="button" class="pp-cardsbtn" data-a="cards" data-p="${p}" aria-label="${esc(nm)}의 카드 보기">${ico('cards')}카드 ${pl.cards.length}</button>`;
    let reserved = '';
    const topNew = pos === 'top' && v.hl.resNew;
    if (pos === 'sheet') {
      // 선수 시트 안: 예약·카드는 시트가 따로 크게 보여 줌
      return `<div class="pp pp-top pp-sheet${active ? ' active' : ''}">
        <div class="pp-head">${dot}<span class="pp-name">${esc(nm)}</span>${tag ? `<span class="pp-tag">${esc(tag)}</span>` : ''}${active ? '<span class="pp-turn">차례</span>' : ''}${stats}</div>
        <div class="pp-gems">${gems}</div>
        <div class="pp-foot"><span class="tokcount${total >= 10 ? ' full' : ''}">토큰 ${total}/10</span>${royals}</div></div>`;
    }
    if (pos === 'top') {
      reserved = pl.reserved.length ? `<span class="pp-reserved"><span class="rlabel">예약</span>${pl.reserved.map((r, i) => {
        const cls = topNew && i === pl.reserved.length - 1 ? 'hl' : '';
        if (canSee(p, r)) return cardHTML(r.id, { button: true, cls, attrs: `data-a="res" data-p="${p}" data-i="${i}"` });
        return backHTML(E.cardById(r.id).level, { button: true, cls, attrs: `data-a="res" data-p="${p}" data-i="${i}"` });
      }).join('')}</span>` : '';
      return `<div class="pp pp-top${active ? ' active' : ''}${swap ? ' swap-in' : ''}">
        <div class="pp-head">${dot}<span class="pp-name">${esc(nm)}</span>${tag ? `<span class="pp-tag">${esc(tag)}</span>` : ''}${active ? '<span class="pp-turn">차례</span>' : ''}${stats}</div>
        <div class="pp-gems">${gems}</div>
        <div class="pp-foot"><span class="tokcount${total >= 10 ? ' full' : ''}">토큰 ${total}/10</span>${royals}${reserved}${cardsBtn}</div></div>`;
    }
    return `<div class="pp pp-me${active ? ' active' : ''}${swap ? ' swap-in' : ''}">
      <div class="pp-head">${dot}<span class="pp-name">${esc(nm)}</span>${tag ? `<span class="pp-tag">${esc(tag)}</span>` : ''}${active ? '<span class="pp-turn">차례</span>' : ''}${stats}</div>
      <div class="pp-gems">${gems}</div>
      <div class="pp-foot"><span class="tokcount${total >= 10 ? ' full' : ''}">토큰 ${total}/10</span>${royals}${cardsBtn}</div>
      <div class="pp-resrow"><span class="rlabel">예약</span>${resSlots(v, p, active)}</div></div>`;
  }
  // 폰용 선수 줄: 1줄 = 점·이름·점수·왕관·특권·예약·토큰 수(+메뉴·기록 버튼), 2줄 = 색마다 보너스+토큰.
  // 줄 전체를 누르면 선수 시트(자세한 패널 + 예약 카드 크게 + 산 카드)가 열려요.
  function stripHTML(v, p, pos, swap, o) {
    const g = v.g;
    const { st, pl, nm, tag, dot, active } = o;
    const total = sumT(pl.tokens);
    const cells = COLORS.map((c) => {
      const bn = st.bonuses[c];
      const cp = st.colorPoints[c];
      const t = pl.tokens[c];
      const lost = v.hl.stolen.has(p + '-' + c) ? ' lost' : '';
      return `<span class="sg" title="${CN[c]}: 보너스 ${bn}, 토큰 ${t}${cp ? `, ${CN[c]} 점수 ${cp}점` : ''}"><span class="bchip c-${c}${bn ? '' : ' zero'}">${bn}${cp ? `<span class="cpts${cp >= 7 ? ' near' : ''}">${cp}</span>` : ''}</span>` +
        `<span class="tchip${t ? '' : ' zero'}${lost}${bump(p + c, t)}">${tok(c)}<b>${t}</b></span></span>`;
    }).join('') + ['pearl', 'gold'].map((c) => {
      const t = pl.tokens[c];
      const lost = v.hl.stolen.has(p + '-' + c) ? ' lost' : '';
      return `<span class="sg solo" title="${CN[c]} 토큰 ${t}"><span class="tchip${t ? '' : ' zero'}${lost}${bump(p + c, t)}">${tok(c)}<b>${t}</b></span></span>`;
    }).join('');
    const nres = pl.reserved.length;
    const resPill = pos === 'top' ? `<span class="st-res${nres ? '' : ' zero'}${v.hl.resNew && nres ? ' new' : ''}">예약 ${nres}</span>` : '';
    // 위 줄은 늘 상대라 '상대'·'봇 · 쉬움' 꼬리표는 빼서 이름 자리를 확보 (선수 시트에는 있음)
    const tg = pos === 'top' ? '' : tag;
    const r1 = `<div class="st-r1"><span class="st-id">${dot}<span class="pp-name">${esc(nm)}</span>${tg ? `<span class="pp-tag">${esc(tg)}</span>` : ''}</span>
      <span class="st-nums"><span class="stat pts${st.points >= 15 ? ' near' : ''}" title="점수 (20점이면 승리)"><b class="${bump(p + 'pts', st.points).trim()}">${st.points}</b><small>/20</small></span>
      <span class="stat${st.crowns >= 7 ? ' near' : ''}" title="왕관 (10개면 승리)">${ico('crown')}<b>${st.crowns}</b></span>
      <span class="stat" title="특권">${ico('scroll')}<b class="${bump(p + 'priv', pl.privileges).trim()}">${pl.privileges}</b></span>
      ${resPill}<span class="tokcount${total >= 10 ? ' full' : ''}" title="토큰 ${total}개 (10개까지)">${total}/10</span></span></div>`;
    const icons = pos === 'top' ? `<div class="st-icons"><button type="button" class="icon-btn" data-a="menu" aria-label="메뉴">${ico('menu')}</button><button type="button" class="icon-btn" data-a="log" aria-label="지난 기록">${ico('log')}</button></div>` : '';
    const hit = `<button type="button" class="st-hit" data-a="player" data-p="${p}" aria-label="${esc(nm)} 자세히 보기 (토큰·예약 카드·산 카드)"></button>`;
    let res = '';
    if (pos === 'me') {
      const slots = resSlots(v, p, active);
      res = `<div class="pp-resrow"><span class="rlabel">예약</span>${slots}<button type="button" class="pp-cardsbtn" data-a="cards" data-p="${p}" aria-label="${esc(nm)}의 카드 보기">${ico('cards')}<span class="lbl">카드 </span>${pl.cards.length}</button></div>`;
    }
    return `<div class="pp strip pp-${pos === 'top' ? 'top' : 'me'}${active ? ' active' : ''}${swap ? ' swap-in' : ''}">${hit}
      <div class="st-main">${r1}<div class="st-r2">${cells}</div></div>${icons}${res}</div>`;
  }
  // 내 예약 칸 3개 (살 수 있으면 금색 테두리)
  function resSlots(v, p, active) {
    const g = v.g;
    const pl = g.players[p];
    const slots = [];
    for (let i = 0; i < K.MAX_RESERVED; i++) {
      const r = pl.reserved[i];
      if (!r) { slots.push(`<div class="res-slot">예약</div>`); continue; }
      const afford = active && v.main && canBuyNow(g, p, r.id) ? ' afford' : '';
      if (canSee(p, r)) slots.push(cardHTML(r.id, { button: true, cls: afford, attrs: `data-a="res" data-p="${p}" data-i="${i}"` }));
      else slots.push(backHTML(E.cardById(r.id).level, { button: true, attrs: `data-a="res" data-p="${p}" data-i="${i}"` }));
    }
    return slots.join('');
  }
  function canBuyNow(g, p, id) {
    const c = E.cardById(id);
    if (c.bonus === 'joker' && !E.jokerOptions(g, p).length) return false;
    return !!E.defaultPayment(g, p, id);
  }

  function instruction(v) {
    const g = v.g;
    const pl = v.pl;
    if (v.head) {
      switch (v.head.kind) {
        case 'bonusToken': return `카드 능력: 보드에서 ${CN[v.head.color]} 토큰 1개를 골라요.`;
        case 'steal': return '능력: 상대의 보석이나 진주 1개를 가져와요. (금은 안 돼요)';
        case 'royal': return `왕관이 ${E.stats(g, v.cur).crowns}개가 됐어요! 왕실 카드 1장을 골라요.`;
        case 'discard': return `토큰이 10개를 넘었어요. ${v.head.count}개를 골라 주머니에 돌려놔요.`;
      }
    }
    if (v.forced) return v.bagTotal > 0 && !g.turn.replenished ? '할 수 있는 행동이 하나도 없어요. 먼저 보드를 채워야 해요.' : '보드를 채울 수도 없어서 이번 차례는 넘겨야 해요.';
    if (S.ui.mode === 'privilege') return `특권 1개로 보드의 보석·진주 1개를 가져와요. 남은 특권 ${pl.privileges}개`;
    if (S.ui.mode === 'gold') return '예약하면서 가져올 금 토큰을 보드에서 골라요.';
    if (S.ui.sel.length) return '한 줄로 붙어 있는 보석·진주를 3개까지 골라요.';
    let s = '토큰을 고르거나, 카드를 눌러 사거나 예약해요.';
    if (v.canPriv) s += ' 먼저 특권을 쓸 수도 있어요.';
    else if (g.turn.replenished) s = '보드를 채웠어요. ' + s;
    return s;
  }
  function bannerHTML(v) {
    const g = v.g;
    let cls = '';
    let icon = 'log';
    let title;
    let sub;
    if (g.over) {
      title = `${who(g.over.winner)} 이겼어요!`;
      sub = reasonText(g.over);
      cls = 'mine';
      icon = 'crown';
    } else if (S.mode === 'online' && (S.spectator || S.seat == null)) {
      title = `${nameOf(v.cur)}님 차례예요`;
      sub = '관전 중이에요. 두 사람의 대결을 지켜봐요.';
    } else if (v.can) {
      const extra = g.log.some((e) => e.t === 'turn' && e.number === g.turn.number && e.extra);
      title = (S.mode === 'local' ? `${nameOf(v.cur)}님 차례예요` : '내 차례예요') + (extra ? ' · 한 번 더!' : '');
      sub = instruction(v);
      cls = v.forced ? 'alert' : 'mine';
      icon = v.forced ? 'refill' : 'arrow';
    } else {
      const nm = isBot(v.cur) ? '봇' : nameOf(v.cur) + '님';
      title = `${nm} 차례예요`;
      if (unsyncedTurn()) {
        title = '내 차례예요';
        sub = syncMsg();
        icon = 'refill';
      } else if (oppAway() && v.cur !== S.seat) {
        sub = `${nameOf(v.cur)}님이 잠시 자리를 비웠어요`;
      } else if (v.head) {
        sub = { bonusToken: '카드 능력으로 토큰을 고르는 중이에요…', steal: '가져갈 토큰을 고르는 중이에요…', royal: '왕실 카드를 고르는 중이에요…', discard: '토큰을 정리하는 중이에요…' }[v.head.kind];
      } else sub = isBot(v.cur) ? '봇이 생각 중이에요…' : `${nameOf(v.cur)}님이 고민 중이에요…`;
      if (!unsyncedTurn()) icon = isBot(v.cur) ? 'bot' : 'log';
    }
    // 상대가 방금 한 일
    let last = '';
    const lines = v.hl.evs.map(describe).filter(Boolean);
    if (lines.length && !g.over) {
      const shown = lines.slice(-2).join(' ');
      let thumb = '';
      const c = v.hl.card;
      if (c && c.id) thumb = cardHTML(c.id, { jokerColor: c.joker });
      else if (c && c.back) thumb = backHTML(c.back);
      const more = lines.length > (S.compact ? 1 : 2) ? ` <span class="hint">외 ${lines.length - (S.compact ? 1 : 2)}개</span>` : '';
      // 폰에서는 한 줄: 주 행동(가져오기·사기·예약) 문장 하나만 (전부는 눌러서 기록에서)
      const mainEv = v.hl.evs.slice().reverse().find((e) => ['take', 'buy', 'reserve', 'pass', 'resign'].includes(e.t));
      const txt = S.compact ? ((mainEv && describe(mainEv)) || lines[lines.length - 1]) : shown;
      last = `<button type="button" class="lastline${fxOn('last') ? ' fx' : ''}" data-a="log" aria-label="${esc(shown)} · 지난 기록 보기">${thumb}<span class="ll-txt">${esc(txt)}${more}</span>${ico('arrow', 'chev')}</button>`;
    }
    // 할 일은 행동 막대 한 곳에서 알려 주므로 (폰·넓은 화면 모두) 배너는 '할 수 있는 게 없음'(alert) 일 때만 보여요 (css).
    // 나머지 배너는 화면에 안 보이지만 같은 정보가 행동 막대(차례·상대가 하는 일·승자)에 있어요.
    return `<div class="banner ${cls}"><span class="b-ico">${ico(icon)}</span><div class="b-txt"><span class="b-title">${esc(title)}</span><span class="b-sub">${esc(sub)}</span></div></div>${last}`;
  }

  function marketHTML(v) {
    const g = v.g;
    const fx = fxOn('market');
    const pickRoyal = v.can && v.head && v.head.kind === 'royal';
    const royals = E_ROYAL_IDS.map((id) => {
      if (!g.royals.includes(id)) return `<div class="royal empty" aria-hidden="true"></div>`;
      return royalHTML(id, { button: true, cls: pickRoyal ? 'pick' : '', attrs: `data-a="royal" data-id="${id}"` });
    }).join('');
    // 금을 고르는 중이면 예약하려는 카드(또는 더미)를 표시
    const resv = v.main && S.ui.mode === 'gold' ? S.ui.reserve : null;
    // 폰: 왕실 카드는 레벨 3 줄 오른쪽에 2×2 작은 칩으로 (한 덩어리 버튼)
    let mini = '';
    if (S.compact) {
      const chips = E_ROYAL_IDS.map((id) => {
        if (!g.royals.includes(id)) return '<span class="rchip empty"></span>';
        const r = E.royalById(id);
        const ab = r.ability === 'extra_turn' ? ico('extra') : r.ability === 'steal' ? ico('steal') : r.ability === 'privilege' ? ico('scroll') : '';
        return `<span class="rchip"><b>${r.points}</b>${ab || '<i class="none">–</i>'}</span>`;
      }).join('');
      const label = `왕실 카드 ${g.royals.length}장 남음: ` + g.royals.map((id) => { const r = E.royalById(id); return `${r.points}점${r.ability ? ' ' + ROYAL_ABIL[r.ability] : ''}`; }).join(', ');
      mini = `<button type="button" class="royals mini${pickRoyal ? ' pick' : ''}" data-a="royal" aria-label="${esc(label)}">${chips}</button>`;
    }
    const rows = [3, 2, 1].map((level) => {
      const deckN = g.decks[level].length;
      const deckHl = resv && resv.from === 'deck' && resv.level === level ? ' hl' : '';
      const deck = `<button type="button" class="deck${deckN ? '' : ' empty'}${deckHl}" data-a="deck" data-l="${level}" aria-label="레벨 ${level} 더미, ${deckN}장 남음"><span class="roman">${ROMAN[level]}</span><span class="lvl">${'<i></i>'.repeat(level)}</span><span class="cnt">${deckN}</span></button>`;
      const cards = g.pyramid[level].map((id, slot) => {
        if (!id) return `<div class="card-empty" aria-label="빈 자리"></div>`;
        const isNew = v.hl.refill.has(level + '-' + slot);
        const target = resv && resv.from === 'pyramid' && resv.level === level && resv.slot === slot;
        let cls = '';
        if (v.main && canBuyNow(g, v.cur, id)) cls += ' afford';
        if (isNew || target) cls += ' hl' + (fx && isNew ? ' fx-in' : '');
        if (target) cls += ' target';
        return cardHTML(id, { button: true, cls, attrs: `data-a="card" data-l="${level}" data-s="${slot}"` });
      }).join('');
      return `<div class="prow lv${level}">${deck}${cards}${level === 3 ? mini : ''}</div>`;
    }).join('');
    return `<div class="market">${S.compact ? '' : `<div class="royals" aria-label="왕실 카드">${royals}</div>`}${rows}</div>`;
  }

  function boardHTML(v) {
    const g = v.g;
    const ui = S.ui;
    const fx = fxOn('board');
    const head = v.can ? v.head : null;
    const dropNow = new Set();
    if (fx && S.fx) S.fx.evs.forEach((e) => { if (e.t === 'replenish') e.cells.forEach((c) => dropNow.add(c)); });
    let exts = null;
    if (v.main && !ui.mode && ui.sel.length) {
      const mid = E.validateTake(g, ui.sel).ok ? null : H.openMiddle(g.board, ui.sel);
      // 양 끝만 고른 경우: 가운데 칸만 점선으로
      exts = new Set(mid != null ? [mid] : E.takeExtensions(g, ui.sel));
    }
    const cells = [];
    for (let i = 0; i < 25; i++) {
      const t = g.board[i];
      const r = Math.floor(i / 5) + 1;
      const c = (i % 5) + 1;
      let cls = 'cell';
      let inner = t ? tok(t) : '';
      let extra = '';
      let label = `${r}행 ${c}열 ${t ? CN[t] + ' 토큰' : '빈 칸'}`;
      const selIdx = ui.sel.indexOf(i);
      if (selIdx >= 0) { cls += ' sel'; extra = ` data-n="${selIdx + 1}"`; label += ', 고름'; }
      if (head && head.kind === 'bonusToken') {
        if (t === head.color) cls += ' target'; else if (t) cls += ' dim';
      } else if (v.main && ui.mode === 'privilege') {
        if (isGem(t)) cls += ' target'; else if (t) cls += ' dim';
      } else if (v.main && ui.mode === 'gold') {
        if (t === 'gold') cls += ui.goldCell === i ? ' sel' : ' target'; else if (t) cls += ' dim';
      } else if (exts && selIdx < 0) {
        if (exts.has(i)) cls += ' ext'; else if (t) cls += ' dim';
      }
      if (!t && v.hl.taken.has(i)) {
        cls += ' ghost' + (fx ? ' fx' : '');
        inner = tok(v.hl.taken.get(i));
        label += `, 방금 ${CN[v.hl.taken.get(i)]} 토큰을 가져감`;
      } else if (t && v.hl.fresh.has(i)) {
        cls += ' newtok' + (dropNow.has(i) ? ' fx-drop' : '');
      } else if (t && dropNow.has(i)) cls += ' fx-drop';
      if (ui.shake === i) cls += ' shake';
      cells.push(`<button type="button" class="${cls}" data-a="cell" data-i="${i}"${extra} aria-label="${label}">${inner}</button>`);
    }
    let slots = '';
    for (let i = 0; i < K.PRIVILEGES; i++) {
      const full = i < g.privilegeSupply;
      slots += `<span class="scroll-slot${full ? ' full' : ''}">${full ? ico('scroll') : ''}</span>`;
    }
    return `<div class="boardwrap"><div class="board" role="grid" aria-label="토큰 보드">${cells.join('')}</div>
      <aside class="board-side"><div class="supply" aria-label="특권 공급처 ${g.privilegeSupply}개"><span class="slabel">특권</span>${slots}</div>
      <div class="bag" title="주머니에 든 토큰 (보드를 채울 때 써요)">${ico('bag')}<b>${v.bagTotal}</b><span class="slabel">주머니</span></div></aside></div>`;
  }

  function barHTML(v) {
    const g = v.g;
    // 줄바꿈은 <span class="br"> (가로 폰의 한 줄 막대에서는 ' · ' 로 이어 붙임)
    // 보내기 알약(내가 둔 수가 상대에게 가는 중/갔음)은 여기, 첫 줄 끝에 (게임 화면의 다른 정보를 가리지 않게)
    const pill = sendPillHTML();
    const withPill = (txt) => {
      if (!pill) return txt;
      if (txt.includes('<br>')) return txt.replace('<br>', ` ${pill}<br>`);
      if (txt.includes('<span class="warn">')) return txt.replace('<span class="warn">', `${pill}<span class="warn">`);
      return `${txt} ${pill}`;
    };
    // 줄바꿈은 <span class="br"> (가로 폰의 한 줄 막대에서는 ' · ' 로 이어 붙임)
    const brk = (txt) => txt.split('<br>').join('<span class="br"></span>');
    const wrap = (txt, btns, raw) => `<div class="ab-inner"><div class="ab-txt">${brk(raw ? txt : withPill(txt))}</div><div class="ab-btns">${btns || ''}</div></div>`;
    const btn = (label, a, cls, extra) => `<button type="button" class="btn ${cls || ''}" data-a="${a}" ${extra || ''}>${label}</button>`;
    const off = (label, why, cls, extra) => `<button type="button" class="btn off ${cls || ''}" data-a="noop" data-why="${esc(why)}" aria-disabled="true" ${extra || ''}>${label}</button>`;
    if (g.over) return wrap(`<b>${esc(who(g.over.winner))} 이겼어요!</b><br>${esc(reasonText(g.over))}`, btn('결과 보기', 'result', 'primary'));
    if (S.mode === 'online' && (S.spectator || S.seat == null)) return wrap(`<b>관전 중이에요</b><br>${esc(nameOf(v.cur))}님 차례예요`, btn(`${ico('home')}홈으로`, 'home', 'ghost small'));
    if (unsyncedTurn()) {
      // 내 차례지만 중계 서버의 최신 문서를 아직 확인 못 함 → 옛 화면 위에서 두지 않게 버튼 없음
      return wrap(`<span class="ab-wait"><span class="thinking"><i></i><i></i><i></i></span><span><b>${S.everSynced ? '다시 연결하는 중…' : '방에 연결하는 중…'}</b> 잠시 후 이어서 둘 수 있어요</span></span>`, '', true);
    }
    if (!v.can) {
      const nm = isBot(v.cur) ? '봇' : nameOf(v.cur) + '님';
      const emote = S.mode === 'online' ? btn(`${ico('smile')}<span class="sr">이모티콘</span>`, 'emote', 'ghost small', 'aria-label="이모티콘 보내기"') : '';
      // 둘째 줄: 보내기 알약이 있으면 알약, 없으면 상대가 하는 일.
      // 상대 자리 비움 안내는 위쪽 알림 줄(netbar) 한 곳에서만 → 그때는 '고민 중' 이라고 하지 않음
      let sub = '';
      if (v.head) sub = { bonusToken: '카드 능력으로 토큰을 고르는 중이에요…', steal: '가져갈 토큰을 고르는 중이에요…', royal: '왕실 카드를 고르는 중이에요…', discard: '토큰을 정리하는 중이에요…' }[v.head.kind] || '';
      else if (!oppAway()) sub = isBot(v.cur) ? '생각 중이에요…' : '고민 중이에요…';
      const line2 = pill || (sub ? `<span class="ab-sub">${esc(sub)}</span>` : '');
      return wrap(`<span class="ab-wait"><span class="thinking"><i></i><i></i><i></i></span><span class="ab-wl"><b>${esc(nm)}</b> 차례예요${line2 ? '<br>' + line2 : ''}</span></span>`, emote, true);
    }
    const ui = S.ui;
    if (v.head) {
      const h = v.head;
      if (h.kind === 'bonusToken') return wrap(`<b>${CN[h.color]} 토큰 1개</b>를 보드에서 눌러 가져와요.`, '');
      const label = { steal: '가져올 토큰 고르기', royal: '왕실 카드 고르기', discard: '버릴 토큰 고르기' }[h.kind];
      const txt = { steal: '<b>카드 능력</b> · 상대 토큰 1개를 가져와요.', royal: '<b>왕관 보상</b> · 왕실 카드 1장을 골라요.', discard: `<b>토큰 정리</b> · ${h.count}개를 돌려놔요.` }[h.kind];
      return wrap(txt, btn(label, 'pending-open', 'primary'));
    }
    if (v.forced) {
      if (v.bagTotal > 0 && !g.turn.replenished) return wrap('<b>할 수 있는 행동이 없어요.</b><span class="warn">보드를 먼저 채워야 해요.</span>', btn(`${ico('refill')}보드 채우기`, 'refill', 'primary'));
      return wrap('<b>할 수 있는 행동이 없어요.</b><span class="warn">주머니도 비어 있어서 차례를 넘겨요.</span>', btn('차례 넘기기', 'pass', 'primary'));
    }
    if (ui.mode === 'privilege') {
      return wrap(`<b>특권 사용 중</b> · 남은 특권 ${v.pl.privileges}개<br>가져올 보석·진주를 눌러요.`, btn('다 썼어요', 'priv-end', 'primary'));
    }
    if (ui.mode === 'gold') {
      const ok = ui.goldCell != null;
      const r = ui.reserve;
      let what = '고른 카드';
      let thumb = '';
      if (r && r.from === 'deck') { what = `레벨 ${r.level} 더미 맨 위 카드`; thumb = backHTML(r.level, { cls: 'ab-thumb' }); }
      else if (r && r.from === 'pyramid') {
        const id = g.pyramid[r.level] && g.pyramid[r.level][r.slot];
        if (id) { what = `레벨 ${r.level} ${cardShort(E.cardById(id))} 카드`; thumb = cardHTML(id, { cls: 'ab-thumb' }); }
      }
      return wrap(`<span class="ab-with-thumb">${thumb}<span><b>${esc(what)} 예약</b><br>${ok ? '이 금을 가져갈까요?' : '가져올 금 토큰을 눌러요.'}</span></span>`,
        btn('취소', 'gold-cancel', 'ghost') + (ok ? btn('예약하기', 'gold-ok', 'primary') : off('예약하기', '보드에서 금 토큰을 먼저 골라 주세요.', 'primary')));
    }
    if (ui.sel.length) {
      const vt = E.validateTake(g, ui.sel);
      if (!vt.ok && H.openMiddle(g.board, ui.sel) != null) {
        // 양 끝만 고름 → 가운데를 눌러야 가져올 수 있음
        return wrap('<b>2개 골랐어요</b><span class="warn">가운데 토큰도 골라야 해요.</span>',
          btn('취소', 'sel-clear', 'ghost') + off('가져오기', '가운데 토큰도 골라야 해요.', 'primary'));
      }
      const warn = vt.ok && vt.privilegeToOpponent ? `<span class="warn">${ui.sel.length === 3 && new Set(ui.sel.map((c) => g.board[c])).size === 1 ? '같은 색 3개라' : '진주 2개라'} 상대가 특권 1개를 받아요.</span>` : '';
      return wrap(`<b>${ui.sel.length}개 골랐어요</b>${warn || (ui.sel.length < 3 ? '<br>이어서 더 고를 수 있어요.' : '')}`,
        btn('취소', 'sel-clear', 'ghost') + btn(`가져오기 (${ui.sel.length})`, 'take', 'primary'));
    }
    const coach = coachFor(v);
    // 버튼은 늘 아이콘 + 짧은 글자 (못 누를 때도 글자는 그대로, 누르면 이유를 알려 줌)
    const btns = [];
    if (v.pl.privileges > 0) {
      const lbl = `${ico('scroll')}특권 ${v.pl.privileges}`;
      const aria = `aria-label="특권 ${v.pl.privileges}개 쓰기"`;
      if (v.canPriv) btns.push(btn(lbl, 'priv', '', aria));
      else btns.push(off(lbl, g.turn.replenished ? '보드를 채운 뒤에는 이번 차례에 특권을 쓸 수 없어요.' : '보드에 가져올 보석이나 진주가 없어요.', '', aria));
    }
    const rl = `${ico('refill')}채우기`;
    if (v.canRefill) btns.push(btn(rl, 'refill', '', 'aria-label="보드 채우기"'));
    else btns.push(off(rl, g.turn.replenished ? '보드는 한 차례에 한 번만 채울 수 있어요.' : '주머니가 비어 있어서 보드를 채울 수 없어요.', '', 'aria-label="보드 채우기"'));
    const extra = g.log.some((e) => e.t === 'turn' && e.number === g.turn.number && e.extra) ? ' · 한 번 더!' : '';
    const whoTurn = S.mode === 'local' ? esc(nameOf(v.cur)) + '님 차례' : '내 차례';
    const main = wrap(`<b>${whoTurn}${extra}</b><br><span class="ab-hint">토큰을 고르거나 카드를 눌러요.</span>`, btns.join(''));
    if (coach) {
      // 첫 게임 안내: 막대 위쪽에 한 줄(좁으면 두 줄). 글을 누르면 규칙의 해당 부분, '안내 끄기' 는 글자로 분명하게.
      const tip = `<div class="ab-coach"><button type="button" class="coach" data-a="coach-rules" data-sec="${coach.sec}"><span class="coach-in"><span class="coach-k">처음 안내</span> <span class="coach-t">${esc(coach.text)}</span> <u>규칙 보기</u></span></button>` +
        `<button type="button" class="coach-off" data-a="coach-x">안내 끄기</button></div>`;
      return main.replace('<div class="ab-inner">', `<div class="ab-inner coaching">${tip}`);
    }
    return main;
  }
  // 첫 게임(이 기기) 안내: 내 처음 세 차례에만
  function setCoach(v) { S.coach = v; store.set('sd.coach', v); }
  function coachFor(v) {
    if (S.coach === 'done') return null;
    const g = v.g;
    const id = `${S.mode}:${S.code || ''}:${g.players.map((p) => p.name).join('/')}`;
    const r = H.coachHint(S.coach, id, H.myTurnIndex(g, v.cur));
    if (r.store !== undefined) setCoach(r.store);
    return r.hint;
  }

  // ───────── 입력 처리 ─────────
  function tapCell(i) {
    const g = S.game;
    if (!g) return;
    const v = view();
    const t = g.board[i];
    if (!v.can) { toast(notYourTurnMsg()); return; }
    const ui = S.ui;
    if (v.head) {
      if (v.head.kind === 'bonusToken') { act({ type: 'bonusToken', cell: i }); return; }
      openPendingSheet();
      return;
    }
    if (v.forced) {
      toast(v.bagTotal > 0 && !g.turn.replenished ? '할 수 있는 행동이 없어서 먼저 보드를 채워야 해요.' : '할 수 있는 행동이 없어서 차례를 넘겨야 해요.');
      return;
    }
    if (ui.mode === 'privilege') {
      if (act({ type: 'usePrivilege', cell: i }, { keepUI: true })) {
        const pl = S.game.players[S.game.turn.player];
        if (pl.privileges <= 0) S.ui.mode = null;
        render();
      } else shake(i);
      return;
    }
    if (ui.mode === 'gold') {
      if (t === 'gold') { ui.goldCell = i; render(); }
      else { toast('금 토큰을 골라 주세요. 예약할 때는 금 1개를 함께 가져와요.'); shake(i); }
      return;
    }
    // 양 끝을 먼저 골라도 되고(가운데를 채우면 완성), 가운데를 빼면 마지막에 누른 칸만 남아요.
    const r = H.tapSelect(g.board, ui.sel, i, (cells) => E.validateTake(g, cells));
    if (r.error) { toast(r.error, ui.sel.length >= 3 ? '' : 'bad'); shake(i); return; }
    ui.sel = r.sel;
    render();
  }
  function shake(i) {
    S.ui.shake = i;
    render();
    setTimeout(() => { if (S.ui.shake === i) { S.ui.shake = null; render(); } }, 420);
  }

  // ───────── 시트 ─────────
  function openSheet(kind, data) {
    S.sheet = Object.assign({ kind }, data || {});
    document.body.classList.add('sheet-open');
    const root = $('#sheet-root');
    root.innerHTML = `<div class="sheet-backdrop" data-a="sheet-close"></div><div class="sheet" role="dialog" aria-modal="true"><div class="grab"></div><div class="sheet-body"></div></div>`;
    renderSheet();
    const sh = $('.sheet', root);
    if (sh) { sh.scrollTop = 0; setTimeout(() => { const f = sh.querySelector('[data-autofocus]') || sh.querySelector('h2'); if (f && f.focus) { f.setAttribute('tabindex', f.getAttribute('tabindex') || '-1'); f.focus({ preventScroll: true }); } }, 30); }
  }
  function closeSheet(instant) {
    const root = $('#sheet-root');
    S.sheet = null;
    document.body.classList.remove('sheet-open');
    if (!root.firstChild) return;
    if (instant) { root.innerHTML = ''; return; }
    const sh = $('.sheet', root);
    const bd = $('.sheet-backdrop', root);
    if (sh) sh.classList.add('closing');
    if (bd) bd.classList.add('closing');
    setTimeout(() => { if (!S.sheet) root.innerHTML = ''; }, 200);
  }
  function renderSheet() {
    if (!S.sheet) return;
    const body = $('#sheet-root .sheet-body');
    if (!body) return;
    let html = '';
    try { html = sheetContent(); } catch (e) { console.error(e); html = ''; }
    if (html == null) { closeSheet(true); return; }
    setHTML(body, html);
    const sh = $('#sheet-root .sheet');
    if (sh) sh.setAttribute('aria-label', (body.querySelector('h2') || {}).textContent || '창');
  }
  function sheetHead(title) {
    return `<div class="sheet-head"><h2>${title}</h2><button type="button" class="icon-btn" data-a="sheet-close" aria-label="닫기">${ico('close')}</button></div>`;
  }
  function sheetContent() {
    const sh = S.sheet;
    switch (sh.kind) {
      case 'card': return cardSheet();
      case 'deck': return deckSheet();
      case 'pending': return pendingSheet();
      case 'confirm': return confirmSheet();
      case 'menu': return menuSheet();
      case 'log': return logSheet();
      case 'rules': return sheetHead('규칙 한눈에 보기') + rulesHTML();
      case 'emote': return sheetHead('이모티콘 보내기') + `<div class="emote-tray">${EMOTES.map((e) => `<button type="button" data-a="emote-send" data-e="${e}" aria-label="${e} 보내기">${e}</button>`).join('')}</div><p class="hint" style="margin:10px 0 0;text-align:center">두 화면에 동시에 떠올라요.</p>`;
      case 'hotseat': return hotseatSheet();
      case 'bot': return botSheet();
      case 'cards': return cardsSheet();
      case 'player': return playerSheet();
      default: return null;
    }
  }

  // 카드 시트: 구매(결제 편집, 조커 색) / 예약
  function sheetCardInfo() {
    const g = S.game;
    const sh = S.sheet;
    if (!g) return null;
    if (sh.src.from === 'pyramid') {
      const id = g.pyramid[sh.src.level][sh.src.slot];
      return id ? { id, owner: null, fromDeck: false } : null;
    }
    const r = g.players[sh.src.p].reserved[sh.src.index];
    return r ? { id: r.id, owner: sh.src.p, fromDeck: r.fromDeck } : null;
  }
  function openCard(src) { openSheet('card', { src, pay: null, joker: null, key: null }); }
  function cardSheet() {
    const g = S.game;
    const sh = S.sheet;
    const info = sheetCardInfo();
    if (!info) return null;
    if (sh.key && sh.key !== info.id) return null; // 카드가 바뀜 → 닫기
    sh.key = info.id;
    const v = view();
    const c = E.cardById(info.id);
    const buyer = v.can ? v.cur : v.bottom;
    const pl = g.players[buyer];
    const eff = E.effectiveCost(g, buyer, info.id);
    const bonuses = E.stats(g, buyer).bonuses;
    // 비용 표
    const costRows = PAY.filter((t) => c.cost[t] > 0).map((t) => {
      const disc = t === 'pearl' ? 0 : Math.min(bonuses[t], c.cost[t]);
      return `<div class="costrow">${pip(t, c.cost[t])}<span>${CN[t]}</span>${disc ? `<span class="hint">보너스 −${disc}</span>` : ''}<span>→</span><span class="eff${eff[t] ? '' : ' free'}">${eff[t] ? eff[t] + '개' : '무료'}</span></div>`;
    }).join('') || '<div class="hint">비용이 없어요.</div>';
    let abil = '';
    if (c.bonus === 'joker') abil += '<div class="ci-abil"><b>조커</b> · 내가 가진 보너스 색 하나를 골라 그 색 보너스 1개가 돼요. 점수도 그 색으로 쳐요.</div>';
    if (!c.bonus) abil += '<div class="ci-abil">보너스 없이 점수만 주는 카드예요. 색 승리 점수에는 들어가지 않아요.</div>';
    if (c.ability === 'extra_turn') abil += '<div class="ci-abil"><b>한 번 더</b> · 사고 나면 이번 차례가 끝난 뒤 한 번 더 해요.</div>';
    if (c.ability === 'bonus_token') abil += `<div class="ci-abil"><b>같은 색 토큰</b> · 보드에서 ${CN[c.bonus]} 토큰 1개를 바로 가져와요. 없으면 넘어가요.</div>`;
    if (c.ability === 'steal') abil += '<div class="ci-abil"><b>토큰 뺏기</b> · 상대의 보석이나 진주 1개를 가져와요. 금은 안 돼요.</div>';
    if (c.ability === 'privilege') abil += '<div class="ci-abil"><b>특권</b> · 특권 1개를 받아요. 공급처가 비었으면 상대에게서 가져와요.</div>';
    const where = info.owner == null ? `피라미드 레벨 ${c.level}` : (info.owner === buyer && v.can ? '내가 예약한 카드' : `${whose(info.owner)} 예약 카드`);
    const facts = `<div class="ci-row"><span class="pill">${esc(where)}</span>${c.points ? `<span class="pill">${c.points}점</span>` : ''}${c.crowns ? `<span class="pill">${ico('crown')}왕관 ${c.crowns}</span>` : ''}</div>`;
    let html = sheetHead(`${esc(cardShort(c))} 카드`) + `<div class="cardview">${cardHTML(info.id)}<div class="cardinfo">${facts}${abil}<div class="costlist">${costRows}</div></div></div>`;

    // 구매 가능 여부
    const isMine = info.owner == null || info.owner === v.cur;
    let buyWhy = null;
    if (!v.can) buyWhy = notYourTurnMsg();
    else if (v.head) buyWhy = '먼저 해야 할 일을 끝내 주세요.';
    else if (g.turn.mainDone) buyWhy = '이번 차례의 행동은 이미 했어요.';
    else if (!isMine) buyWhy = '상대가 예약한 카드는 살 수 없어요.';
    const jokerOpts = E.jokerOptions(g, buyer);
    const def = E.defaultPayment(g, buyer, info.id);
    if (!buyWhy && c.bonus === 'joker' && !jokerOpts.length) buyWhy = '조커는 보너스가 있는 카드를 먼저 가지고 있어야 살 수 있어요.';
    if (!buyWhy && !def) {
      const short = PAY.filter((t) => eff[t] > (pl.tokens[t] || 0)).map((t) => `${CN[t]} ${eff[t] - (pl.tokens[t] || 0)}개`);
      const gold = pl.tokens.gold || 0;
      buyWhy = `토큰이 모자라요. ${short.join(', ')}가 더 필요해요.` + (gold ? ` 금 ${gold}개로는 다 채울 수 없어요.` : '');
    }
    let payHTML = '';
    let payOk = false;
    if (!buyWhy) {
      if (!sh.pay) sh.pay = Object.assign({}, def);
      const pay = sh.pay;
      const goldUsed = PAY.reduce((n, t) => n + (eff[t] - pay[t]), 0);
      pay.gold = goldUsed;
      const rows = PAY.filter((t) => eff[t] > 0).map((t) => {
        const gem = pay[t];
        const gold = eff[t] - gem;
        const canMore = gem > 0 && goldUsed < (pl.tokens.gold || 0);
        const canLess = gold > 0 && gem < (pl.tokens[t] || 0);
        const toks = tok(t).repeat(Math.min(gem, 8)) + tok('gold').repeat(Math.min(gold, 8));
        return `<div class="payrow">${pip(t, eff[t])}<div class="pr-txt">${CN[t]} ${eff[t]}개<small>내 ${CN[t]} ${pl.tokens[t] || 0}개${gold ? ` · 금으로 ${gold}개` : ''}</small></div><div class="pr-toks" aria-hidden="true">${toks}</div>` +
          ((pl.tokens.gold || 0) > 0 ? `<div class="stepper" aria-label="${CN[t]} 대신 낼 금"><button type="button" data-a="pay-less" data-t="${t}" ${canLess ? '' : 'disabled'} aria-label="금 1개 덜 내기">−</button><span class="gold-lbl">${tok('gold')}<span class="sv">${gold}</span></span><button type="button" data-a="pay-more" data-t="${t}" ${canMore ? '' : 'disabled'} aria-label="${CN[t]} 대신 금 1개 더 내기">+</button></div>` : '') + `</div>`;
      }).join('');
      const vp = E.validatePayment(g, buyer, info.id, pay);
      payOk = vp.ok;
      const sum = TOKENS.filter((t) => pay[t] > 0).map((t) => `<span class="tk">${tok(t)}${pay[t]}</span>`).join('');
      payHTML = `<div class="sheet-sec"><h3>낼 토큰${(pl.tokens.gold || 0) > 0 ? ' · 금으로 대신 낼 수 있어요' : ''}</h3>${rows ? `<div class="payrows">${rows}</div>` : '<p class="hint">낼 토큰이 없어요. 공짜예요!</p>'}<div class="paysum">합계 ${sum || '없음'}</div>${vp.ok ? '' : `<div class="why">${esc(vp.error)}</div>`}</div>`;
      if (c.bonus === 'joker') {
        if (!sh.joker && jokerOpts.length === 1) sh.joker = jokerOpts[0];
        const bst = E.stats(g, buyer);
        const rec = H.jokerPick(jokerOpts, bst.colorPoints, bst.bonuses);
        payHTML += `<div class="sheet-sec"><h3>조커 색 고르기</h3><div class="chips">${COLORS.map((col) => {
          const okc = jokerOpts.includes(col);
          const cp = bst.colorPoints[col];
          const label = `${CN[col]} · 보너스 ${bst.bonuses[col]}${cp > 0 ? ` · ${cp}점` : ''}`;
          return `<button type="button" class="chip${sh.joker === col ? ' on' : ''}" data-a="joker" data-c="${col}" ${okc ? '' : 'disabled'} aria-pressed="${sh.joker === col}">${tok(col)}${label}${rec === col ? '<span class="pill me">추천</span>' : ''}</button>`;
        }).join('')}</div><p class="hint" style="margin:6px 0 0">가지고 있는 보너스 색만 고를 수 있어요. 조커 점수는 고른 색 점수에 더해져요${rec ? ' — 색 점수가 가장 높은 색을 추천해요' : ''}.</p></div>`;
        if (!sh.joker) payOk = false;
      }
    }
    // 예약 가능 여부
    let resWhy = null;
    const canReserveHere = info.owner == null;
    if (canReserveHere) {
      if (!v.can) resWhy = notYourTurnMsg();
      else if (v.head) resWhy = '먼저 해야 할 일을 끝내 주세요.';
      else if (g.turn.mainDone) resWhy = '이번 차례의 행동은 이미 했어요.';
      else if (g.players[v.cur].reserved.length >= K.MAX_RESERVED) resWhy = '예약은 3장까지만 할 수 있어요.';
      else if (!g.board.includes('gold')) resWhy = '보드에 금 토큰이 없어서 예약할 수 없어요.';
    }
    const buyBtn = buyWhy || !payOk
      ? `<button type="button" class="btn primary off" data-a="noop" data-why="${esc(buyWhy || (c.bonus === 'joker' && !sh.joker ? '조커 색을 먼저 골라 주세요.' : '결제 내역을 확인해 주세요.'))}" aria-disabled="true">구매하기</button>`
      : `<button type="button" class="btn primary" data-a="buy">구매하기</button>`;
    const resBtn = canReserveHere ? (resWhy ? `<button type="button" class="btn off" data-a="noop" data-why="${esc(resWhy)}" aria-disabled="true">예약하기</button>` : `<button type="button" class="btn" data-a="reserve">예약하기 ${tok('gold')}</button>`) : '';
    html += payHTML + `<div class="actions">${resBtn}${buyBtn}</div>`;
    const whys = [];
    if (buyWhy) whys.push('구매: ' + buyWhy);
    if (canReserveHere && resWhy && resWhy !== buyWhy) whys.push('예약: ' + resWhy);
    if (whys.length) html += `<div class="why${!v.can ? ' muted' : ''}">${whys.map(esc).join('<br>')}</div>`;
    else if (canReserveHere) html += `<div class="why muted">예약하면 금 1개를 함께 가져와요.</div>`;
    return html;
  }
  function deckSheet() {
    const g = S.game;
    const level = S.sheet.level;
    const n = g.decks[level].length;
    const v = view();
    let why = null;
    if (!v.can) why = notYourTurnMsg();
    else if (v.head) why = '먼저 해야 할 일을 끝내 주세요.';
    else if (g.turn.mainDone) why = '이번 차례의 행동은 이미 했어요.';
    else if (!n) why = '이 더미에는 카드가 남아 있지 않아요.';
    else if (g.players[v.cur].reserved.length >= K.MAX_RESERVED) why = '예약은 3장까지만 할 수 있어요.';
    else if (!g.board.includes('gold')) why = '보드에 금 토큰이 없어서 예약할 수 없어요.';
    return sheetHead(`레벨 ${level} 더미`) + `<div class="cardview">${backHTML(level)}<div class="cardinfo"><div class="ci-row"><span class="pill">남은 카드 ${n}장</span></div>
      <div class="ci-abil">맨 위 카드를 보지 않고 예약해요. 가져온 뒤에는 나만 볼 수 있고, 상대에게는 뒷면만 보여요.</div><div class="hint">예약하면 보드의 금 1개를 함께 가져와요.</div></div></div>
      <div class="actions"><button type="button" class="btn ghost" data-a="sheet-close">닫기</button>${why ? `<button type="button" class="btn primary off" data-a="noop" data-why="${esc(why)}" aria-disabled="true">맨 위 카드 예약</button>` : `<button type="button" class="btn primary" data-a="reserve-deck">맨 위 카드 예약 ${tok('gold')}</button>`}</div>
      ${why ? `<div class="why${v.can ? '' : ' muted'}">${esc(why)}</div>` : ''}`;
  }
  function startReserve(source) {
    const g = S.game;
    const golds = [];
    g.board.forEach((t, i) => { if (t === 'gold') golds.push(i); });
    S.ui = freshUI();
    S.ui.mode = 'gold';
    S.ui.reserve = source;
    S.ui.goldCell = golds.length === 1 ? golds[0] : null;
    closeSheet();
    render();
    if (golds.length === 1) toast('보드의 금이 1개뿐이라 미리 골라 뒀어요. 예약하기를 눌러 확인해요.');
    revealBoard();
  }

  function openPendingSheet() {
    const g = S.game;
    if (!g || !g.pending.length) return;
    if (g.pending[0].kind === 'bonusToken') return;
    openSheet('pending', { pick: null, disc: null, forKey: g.pending[0].kind + g.log.length });
  }
  function pendingSheet() {
    const g = S.game;
    const v = view();
    if (!v.can || !v.head) return null;
    const h = v.head;
    const sh = S.sheet;
    if (h.kind === 'steal') {
      const opp = g.players[1 - v.cur];
      const btns = PAY.concat(['gold']).map((t) => {
        const n = opp.tokens[t] || 0;
        if (t === 'gold') return n ? `<button type="button" class="tokbtn" disabled>${tok(t)}<b>${CN[t]}</b><small>금은 못 가져가요</small></button>` : '';
        return `<button type="button" class="tokbtn" data-a="steal" data-t="${t}" ${n ? '' : 'disabled'}>${tok(t)}<b>${CN[t]}</b><small>${n}개 있음</small></button>`;
      }).join('');
      return sheetHead(`${esc(whose(1 - v.cur))} 토큰 1개 가져오기`) + `<p class="hint">카드 능력이에요. 보석이나 진주 중에서 하나를 골라요.</p><div class="tokpick">${btns}</div>`;
    }
    if (h.kind === 'royal') {
      const opts = g.royals.map((id) => {
        const r = E.royalById(id);
        const desc = r.ability === 'steal' ? '상대의 보석·진주 1개를 가져와요' : r.ability === 'extra_turn' ? '이번 차례가 끝나면 한 번 더 해요' : r.ability === 'privilege' ? '특권 1개를 받아요' : '능력 없이 3점이에요';
        return `<button type="button" class="royal-opt${sh.pick === id ? ' on' : ''}" data-a="royal-sel" data-id="${id}" aria-pressed="${sh.pick === id}">${royalHTML(id, { cls: 'big' })}<b>${r.points}점</b><small>${desc}</small></button>`;
      }).join('');
      return sheetHead('왕실 카드 고르기') + `<p class="hint">왕관 3개, 6개를 모을 때마다 왕실 카드 1장을 가져와요. 점수는 20점에 더해지지만 색 점수에는 들어가지 않아요.</p><div class="royal-pick">${opts}</div>
        <div class="actions">${sh.pick ? '<button type="button" class="btn primary" data-a="royal-ok">이 카드 가져오기</button>' : '<button type="button" class="btn primary off" data-a="noop" data-why="가져올 왕실 카드를 먼저 골라 주세요." aria-disabled="true">이 카드 가져오기</button>'}</div>`;
    }
    if (h.kind === 'discard') {
      const pl = g.players[v.cur];
      if (!sh.disc) sh.disc = { white: 0, blue: 0, green: 0, red: 0, black: 0, pearl: 0, gold: 0 };
      const d = sh.disc;
      const chosen = sumT(d);
      const rows = TOKENS.filter((t) => pl.tokens[t] > 0).map((t) => `<div class="discard-row">${tok(t, 'tk')}<div class="dr-txt">${CN[t]}<small>가진 ${pl.tokens[t]}개 → 남길 ${pl.tokens[t] - d[t]}개</small></div>
        <div class="stepper"><button type="button" data-a="disc-less" data-t="${t}" ${d[t] > 0 ? '' : 'disabled'} aria-label="${CN[t]} 덜 버리기">−</button><span class="sv">${d[t]}</span><button type="button" data-a="disc-more" data-t="${t}" ${d[t] < pl.tokens[t] && chosen < h.count ? '' : 'disabled'} aria-label="${CN[t]} 1개 더 버리기">+</button></div></div>`).join('');
      const done = chosen === h.count;
      return sheetHead(`토큰 ${h.count}개 돌려놓기`) + `<p class="hint">차례가 끝날 때 토큰은 10개까지만 가질 수 있어요. 돌려놓은 토큰은 주머니로 들어가요.</p>
        <p class="countline${done ? ' okc' : ''}">고른 토큰 ${chosen} / ${h.count}</p><div class="discard-list">${rows}</div>
        <div class="actions">${done ? '<button type="button" class="btn primary" data-a="disc-ok">돌려놓기</button>' : `<button type="button" class="btn primary off" data-a="noop" data-why="${esc(`정확히 ${h.count}개를 골라 주세요.`)}" aria-disabled="true">돌려놓기</button>`}</div>`;
    }
    return null;
  }
  function confirmSheet() {
    const sh = S.sheet;
    return sheetHead(esc(sh.title)) + `<p>${sh.html || esc(sh.text)}</p><div class="actions"><button type="button" class="btn ghost" data-a="sheet-close">${esc(sh.cancel || '취소')}</button><button type="button" class="btn ${sh.danger ? 'danger' : 'primary'}" data-a="confirm-ok">${esc(sh.ok || '확인')}</button></div>`;
  }
  function confirm(opts) { openSheet('confirm', opts); }

  function menuSheet() {
    const g = S.game;
    const items = [];
    if (S.mode === 'online' && S.code) items.push(`<button type="button" class="menu-item" data-a="copy">${ico('copy')}<span>초대 링크 복사<br><small>방 ${esc(S.code)}${S.spectator ? ' · 관전 중' : ''} · 중계 서버 ${S.status.connected}곳 연결됨</small></span></button>`);
    if (S.mode === 'online' && !S.spectator && S.seat != null) items.push(`<button type="button" class="menu-item" data-a="emote">${ico('smile')}<span>이모티콘 보내기</span></button>`);
    items.push(`<button type="button" class="menu-item" data-a="rules">${ico('book')}<span>규칙 보기</span></button>`);
    items.push(`<button type="button" class="menu-item" data-a="sound">${ico(S.sound ? 'sound' : 'mute')}<span>소리 ${S.sound ? '켜짐' : '꺼짐'}<br><small>누르면 ${S.sound ? '꺼요' : '켜요'}</small></span></button>`);
    const canResign = g && !g.over && (S.mode !== 'online' || (S.seat != null && !S.spectator));
    if (canResign) items.push(`<button type="button" class="menu-item danger" data-a="resign">${ico('flag')}<span>기권하기</span></button>`);
    items.push(`<button type="button" class="menu-item" data-a="home">${ico('home')}<span>홈으로<br><small>${S.mode === 'online' ? '방은 그대로 남아서 나중에 이어할 수 있어요' : '게임은 저장돼서 이어할 수 있어요'}</small></span></button>`);
    return sheetHead('메뉴') + `<div class="menu-list">${items.join('')}</div>`;
  }
  function logSheet() {
    const g = S.game;
    if (!g) return null;
    const own = turnOwners(g);
    const groups = [];
    let curN = null;
    for (const e of g.log) {
      if (e.t === 'turn') continue;
      const line = describe(e);
      if (!line) continue;
      if (e.turnNo !== curN) { curN = e.turnNo; groups.push({ n: curN, lines: [] }); }
      groups[groups.length - 1].lines.push({ line, p: e.p });
    }
    groups.reverse();
    const html = groups.map((gr) => {
      const p = own[gr.n];
      const head = `<div class="logturn">${gr.n}번째 차례${p === 0 || p === 1 ? ' · ' + esc(turnName(p) + (isMe(p) ? ' 차례' : ' 차례')) : ''}</div>`;
      return head + gr.lines.map((l) => `<div class="logline p${l.p === 1 ? 1 : 0}"><span class="ldot"></span><span>${esc(l.line)}</span></div>`).join('');
    }).join('');
    return sheetHead('지난 기록') + (html ? `<div class="loglist">${html}</div>` : '<p class="hint">아직 기록이 없어요. 첫 차례를 시작해 볼까요?</p>');
  }
  function hotseatSheet() {
    const sh = S.sheet;
    return sheetHead('한 기기로 둘이 하기') + `<p class="hint">폰 하나를 번갈아 넘기며 해요. 아래쪽에는 항상 지금 차례인 사람이 보여요.</p>
      <div class="field"><label for="hs-a">첫 번째 사람</label><input id="hs-a" class="input" maxlength="12" value="${esc(sh.a)}" placeholder="이름"></div>
      <div class="field" style="margin-top:10px"><label for="hs-b">두 번째 사람</label><input id="hs-b" class="input" maxlength="12" value="${esc(sh.b)}" placeholder="이름"></div>
      <p class="hint" style="margin-top:10px">먼저 할 사람은 무작위로 정해요. 나중에 하는 사람은 특권 1개를 받고 시작해요.</p>
      <div class="actions"><button type="button" class="btn primary" data-a="hs-start">시작하기</button></div>`;
  }
  function botSheet() {
    const sh = S.sheet;
    const lv = (k, label, desc) => `<button type="button" class="chip${sh.level === k ? ' on' : ''}" data-a="bot-level" data-v="${k}" aria-pressed="${sh.level === k}">${label}<small class="hint">${desc}</small></button>`;
    const fs = (k, label) => `<button type="button" class="chip${sh.first === k ? ' on' : ''}" data-a="bot-first" data-v="${k}" aria-pressed="${sh.first === k}">${label}</button>`;
    return sheetHead('봇과 연습하기') + `<h3 class="label" style="margin:4px 0 8px">난이도</h3><div class="chips">${lv('easy', '쉬움', '규칙 익히기')}${lv('normal', '보통', '제법 영리해요')}</div>
      <h3 class="label" style="margin:14px 0 8px">누가 먼저?</h3><div class="chips">${fs('me', '나 먼저')}${fs('bot', '봇 먼저')}${fs('random', '무작위')}</div>
      <div class="actions"><button type="button" class="btn primary" data-a="bot-start">시작하기</button></div>`;
  }
  // 선수 시트 (폰에서 선수 줄을 눌렀을 때): 자세한 패널 + 예약 카드(보통 크기) + 산 카드
  function playerSheet() {
    const g = S.game;
    if (!g) return null;
    const p = S.sheet.p;
    const pl = g.players[p];
    const v = view();
    const nm = isBot(p) ? '봇' : pl.name;
    const active = !g.over && g.turn.player === p;
    let res = '';
    if (pl.reserved.length) {
      res = pl.reserved.map((r, i) => {
        const afford = active && v.main && canBuyNow(g, p, r.id) ? 'afford' : '';
        if (canSee(p, r)) return cardHTML(r.id, { button: true, cls: afford, attrs: `data-a="res" data-p="${p}" data-i="${i}"` });
        return backHTML(E.cardById(r.id).level, { button: true, attrs: `data-a="res" data-p="${p}" data-i="${i}"` });
      }).join('');
      res = `<div class="chips res-big">${res}</div>${pl.reserved.some((r) => !canSee(p, r)) ? '<p class="hint" style="margin:6px 0 0">더미에서 몰래 예약한 카드는 뒷면만 보여요.</p>' : ''}`;
    } else res = '<p class="hint" style="margin:0">예약한 카드가 없어요.</p>';
    return sheetHead(`${esc(nm)}${isMe(p) && H.playerTag(nm, '나') ? ' (나)' : ''}`) + playerHTML(v, p, 'sheet') +
      `<div class="sheet-sec"><h3>예약한 카드 ${pl.reserved.length}/3</h3>${res}</div>` +
      `<div class="sheet-sec"><h3>산 카드 ${pl.cards.length}장</h3>${cardsListHTML(p) || '<p class="hint" style="margin:0">아직 산 카드가 없어요.</p>'}</div>`;
  }
  function cardsListHTML(p) {
    const g = S.game;
    const pl = g.players[p];
    const st = E.stats(g, p);
    const groups = COLORS.map((col) => {
      const ids = pl.cards.filter((id) => { const c = E.cardById(id); return c.bonus === col || (c.bonus === 'joker' && pl.jokerColor[id] === col); });
      if (!ids.length) return '';
      return `<div class="cgroup"><h4>${tok(col, 'ii')} ${CN[col]} · 보너스 ${st.bonuses[col]} · ${st.colorPoints[col]}점</h4><div class="chips">${ids.map((id) => cardHTML(id, { jokerColor: pl.jokerColor[id] })).join('')}</div></div>`;
    }).join('');
    const plain = pl.cards.filter((id) => !E.cardById(id).bonus);
    const plainHTML = plain.length ? `<div class="cgroup"><h4>점수 카드</h4><div class="chips">${plain.map((id) => cardHTML(id)).join('')}</div></div>` : '';
    const royals = pl.royals.length ? `<div class="cgroup"><h4>왕실 카드</h4><div class="chips">${pl.royals.map((id) => royalHTML(id)).join('')}</div></div>` : '';
    return groups + plainHTML + royals;
  }
  function cardsSheet() {
    const g = S.game;
    if (!g) return null;
    const p = S.sheet.p;
    const pl = g.players[p];
    const st = E.stats(g, p);
    const groups = COLORS.map((col) => {
      const ids = pl.cards.filter((id) => { const c = E.cardById(id); return c.bonus === col || (c.bonus === 'joker' && pl.jokerColor[id] === col); });
      if (!ids.length) return '';
      return `<div class="sheet-sec"><h3>${tok(col, 'ii')} ${CN[col]} · 보너스 ${st.bonuses[col]} · ${st.colorPoints[col]}점</h3><div class="chips">${ids.map((id) => cardHTML(id, { jokerColor: pl.jokerColor[id] })).join('')}</div></div>`;
    }).join('');
    const plain = pl.cards.filter((id) => !E.cardById(id).bonus);
    const plainHTML = plain.length ? `<div class="sheet-sec"><h3>점수 카드</h3><div class="chips">${plain.map((id) => cardHTML(id)).join('')}</div></div>` : '';
    const royals = pl.royals.length ? `<div class="sheet-sec"><h3>왕실 카드</h3><div class="chips">${pl.royals.map((id) => royalHTML(id)).join('')}</div></div>` : '';
    const nm = isBot(p) ? '봇' : pl.name;
    return sheetHead(`${esc(nm)}의 카드`) + `<p class="hint">카드 ${pl.cards.length}장 · ${st.points}점 · 왕관 ${st.crowns}개</p>` + (groups + plainHTML + royals || '<p class="hint">아직 산 카드가 없어요.</p>');
  }

  // ───────── 규칙 ─────────
  function rulesHTML() {
    const eg = E.cardById('2U3') ? cardHTML('2U3') : '';
    const mb = (cells, on) => `<div class="mini-board">${cells.map((t, i) => `<i class="${on.includes(i) ? 'on' : ''}">${t ? tok(t) : ''}</i>`).join('')}</div>`;
    return `<div class="rules">
      <h3 id="rule-1"><span class="n">1</span>이기는 방법</h3>
      <p>내 차례가 끝났을 때 아래 셋 중 하나라도 이루면 바로 이겨요.</p>
      <div class="wins"><div class="win"><b>20</b>점수 20점 이상<br><span class="hint">카드 + 왕실 카드</span></div><div class="win">${ico('crown')}<b>10</b>왕관 10개 이상</div><div class="win"><b>10</b>한 색 카드로<br>10점 이상</div></div>
      <h3 id="rule-2"><span class="n">2</span>준비</h3>
      <p>보드 25칸에 토큰 25개(보석 5색 × 4개, 진주 2개, 금 3개)가 가득 차 있고, 주머니는 비어 있어요. 카드는 레벨 3·2·1이 3·4·5장씩 피라미드로 펼쳐지고, 왕실 카드 4장이 따로 놓여요. 나중에 하는 사람은 특권 1개를 받고 시작해요.</p>
      <div class="tokrow">${TOKENS.map((t) => `<span>${tok(t)}${CN[t]}<small>${CUT[t]}</small></span>`).join('')}</div>
      <p class="hint">토큰마다 가운데 모양이 달라서 색을 구별하기 어려워도 알아볼 수 있어요.</p>
      <h3 id="rule-3"><span class="n">3</span>내 차례에 하는 일</h3>
      <div class="steps">
        <div class="step"><span class="tag">선택</span><div><b>① 특권 쓰기</b> · 특권 1개마다 보드의 보석이나 진주 1개를 아무 데서나 가져와요. 금은 안 돼요.</div></div>
        <div class="step"><span class="tag">선택</span><div><b>② 보드 채우기</b> · 주머니의 토큰을 모두 빈칸에 채워요. 대신 상대가 특권 1개를 받아요. 채운 뒤에는 이번 차례에 특권을 쓸 수 없어요.</div></div>
        <div class="step"><span class="tag must">필수</span><div><b>③ 행동 1개</b> · 토큰 가져오기, 금 받고 카드 예약하기, 카드 사기 중 하나만 해요.</div></div>
      </div>
      <p>순서는 꼭 ①→②→③이에요. 행동을 마치면 <b>카드 능력 → 왕실 카드 → 토큰 10개 정리 → 승리 확인</b> 순서로 차례를 마무리해요. 할 수 있는 행동이 하나도 없으면 먼저 보드를 채워야 해요.</p>
      <h3 id="rule-4"><span class="n">4</span>토큰 가져오기</h3>
      <p>보석이나 진주를 <b>1~3개</b>, 가로·세로·대각선으로 <b>한 줄로 붙어 있는 것</b>만 가져와요. 사이에 금이나 빈칸이 있으면 안 되고, 금은 이 방법으로 가져올 수 없어요.</p>
      <div class="lineeg"><figure class="good">${mb(['blue', null, 'red', 'white', 'green', null, 'gold', 'pearl', 'black'], [0, 4, 8])}<figcaption>대각선 3개 ○</figcaption></figure>
        <figure class="bad">${mb(['red', 'gold', 'green', null, null, null, 'white', 'blue', 'black'], [0, 2])}<figcaption>금을 건너뜀 ✕</figcaption></figure>
        <figure class="bad">${mb(['white', 'blue', null, null, 'green', null, null, null, 'red'], [0, 1, 4])}<figcaption>꺾인 줄 ✕</figcaption></figure></div>
      <p><b>같은 색 3개</b>를 가져오거나 <b>진주 2개</b>를 함께 가져오면 상대가 특권 1개를 받아요. <span class="hint">(특권이나 카드 능력으로 가져올 때는 해당 없어요)</span></p>
      <h3 id="rule-5"><span class="n">5</span>특권 ${ico('scroll', 'ii')}</h3>
      <p>특권은 모두 3개뿐이에요. 특권을 받아야 할 때 공급처가 비어 있으면 상대에게서 가져오고, 이미 3개를 다 가지고 있으면 아무 일도 없어요. 특권은 토큰 개수에 들어가지 않아요.</p>
      <h3 id="rule-6"><span class="n">6</span>카드 예약</h3>
      <p>보드의 <b>금 1개</b>(어디서든)를 가져오고, 피라미드의 카드 1장이나 더미 맨 위 카드 1장을 내 앞에 가져와요. 더미에서 가져온 카드는 상대에게 뒷면만 보여요. 예약은 <b>최대 3장</b>이고, 보드에 금이 없으면 예약할 수 없어요. 예약한 카드는 나중에 사야만 효과가 있어요.</p>
      <h3 id="rule-7"><span class="n">7</span>카드 사기</h3>
      <p>카드 비용에서 <b>내 보너스만큼 빼고</b> 남은 만큼 토큰을 내요. 금은 어떤 보석이나 진주든 대신할 수 있고, 같은 색 보석이 있어도 금으로 낼 수 있어요. 진주 비용은 보너스로 줄지 않아요. 낸 토큰은 주머니로 들어가요. 피라미드에서 산 자리는 같은 레벨 더미에서 새 카드로 채워요.</p>
      <h3 id="rule-8"><span class="n">8</span>카드 보는 법</h3>
      <div class="anatomy">${eg}<ul><li>왼쪽 위 숫자: <b>점수</b></li><li>오른쪽 위 보석: <b>보너스</b> (두 개면 보너스 2)</li><li>띠 아래: <b>왕관</b>과 <b>능력</b></li><li>왼쪽 아래: <b>비용</b> (모양 = 색, 숫자 = 개수)</li><li>오른쪽 아래 점: <b>레벨</b></li></ul></div>
      <p class="hint">내 차례에 지금 살 수 있는 카드는 <b>금색 테두리</b>로 보여요. 방금 새로 나온 카드는 더 굵게 빛나는 테두리예요.</p>
      <p>보너스 보석이 없는 회색 카드는 점수만 줘요. 20점에는 들어가지만 한 색 10점에는 안 들어가요.</p>
      <h3 id="rule-9"><span class="n">9</span>능력</h3>
      <div class="icorow"><span class="ico">${ico('extra')}</span><div><b>한 번 더</b> · 이번 차례가 끝나면 곧바로 한 번 더 해요.</div></div>
      <div class="icorow"><span class="ico">${tok('green')}</span><div><b>같은 색 토큰</b> · 보드에서 이 카드 색 토큰 1개를 가져와요. 없으면 넘어가요.</div></div>
      <div class="icorow"><span class="ico">${ico('steal')}</span><div><b>토큰 뺏기</b> · 상대의 보석이나 진주 1개를 가져와요. 금은 안 돼요.</div></div>
      <div class="icorow"><span class="ico">${ico('scroll')}</span><div><b>특권</b> · 특권 1개를 받아요.</div></div>
      <div class="icorow"><span class="ico">${use('tk-joker')}</span><div><b>조커</b> · 내가 가진 보너스 색 하나를 골라 그 색 보너스 1개가 돼요. 점수도 그 색으로 쳐요. 보너스가 있는 카드가 하나도 없으면 살 수 없어요(예약은 돼요).</div></div>
      <h3 id="rule-10"><span class="n">10</span>왕관과 왕실 카드 ${ico('crown', 'ii')}</h3>
      <p>왕관이 <b>3개</b>가 될 때, 그리고 <b>6개</b>가 될 때 남은 왕실 카드 중 1장을 골라 가져오고, 그 능력을 바로 써요. 왕실 카드 점수는 20점에는 들어가지만 색 점수에는 들어가지 않아요.</p>
      <ul><li>2점 + 상대 토큰 1개 뺏기</li><li>2점 + 한 번 더</li><li>2점 + 특권 1개</li><li>3점 (능력 없음)</li></ul>
      <h3 id="rule-11"><span class="n">11</span>토큰은 10개까지</h3>
      <p>차례가 끝날 때 금을 포함한 토큰이 10개보다 많으면, 10개가 되도록 골라서 주머니에 돌려놔요. 차례 중간에는 잠깐 넘어도 괜찮아요.</p>
      <h3 id="rule-12"><span class="n">12</span>이 앱에서는</h3>
      <ul><li>보드의 토큰을 눌러 고른 뒤 <b>가져오기</b>를 눌러요. 이어서 고를 수 있는 칸은 점선으로 보여요.</li><li>카드를 누르면 사기·예약 창이 열리고, 더미를 누르면 맨 위 카드를 예약할 수 있어요.</li><li>상대가 방금 가져간 자리는 주황 점선으로, 새로 나온 카드는 굵게 빛나는 테두리로, 지금 살 수 있는 카드는 금색 테두리로 보여요.</li></ul>
    </div>`;
  }

  // ───────── 로비 ─────────
  function renderLobby() {
    const root = $('#lobby-root');
    const d = S.doc;
    const conn = S.status.connected;
    const relay = conn > 0 ? `<span class="dot on"></span>중계 서버 ${conn}곳 연결됨`
      : (S.everConnected || Date.now() - S.joinAt > 7000) ? `<span class="dot warn"></span>연결이 끊겼어요. 다시 연결하는 중…` : `<span class="dot off"></span><span class="waiting-dots">중계 서버에 연결하는 중</span>`;
    const head = `<div class="lobby-head"><button type="button" class="icon-btn" data-a="home" aria-label="홈으로">${ico('home')}</button><h1>대기실</h1><button type="button" class="icon-btn" data-a="rules" aria-label="규칙 보기">${ico('book')}</button></div>`;
    let body;
    if (!d) {
      const waited = Date.now() - S.joinAt;
      const lost = conn > 0 && waited > 8000;
      body = `<div class="panel center-col">${lost ? '' : '<div class="spinner" aria-hidden="true"></div>'}<div class="code-big">${esc(S.code)}</div>
        <p style="margin:0">${lost ? '아직 이 코드의 방을 찾지 못했어요.' : '<span class="waiting-dots">방을 찾는 중이에요</span>'}</p>
        ${lost ? `<p class="hint" style="margin:0">코드가 맞는지 확인해 주세요. 방을 만든 사람의 화면이 꺼져 있으면 조금 늦게 보일 수 있어요.</p><div class="share-row"><button type="button" class="btn" data-a="home">홈으로</button><button type="button" class="btn primary" data-a="create-here">이 코드로 새 방 만들기</button></div>` : ''}</div>`;
    } else if (S.full && S.seat == null && !S.spectator) {
      const seats = d.seats || [];
      const rows = seats.map((s, i) => {
        const on = s ? peerOnline(s.deviceId) : false;
        // 내 이름과 같은 자리는 (접속 중으로 보여도) 언제나 이어받을 수 있음: 예전 기기가 꺼진 게 아직 안 보일 수 있어서
        const own = !!s && !!myName() && s.name === myName();
        let btn = '';
        if (own) btn = `<button type="button" class="btn small primary" data-a="takeover" data-seat="${i}" data-own="1">내 자리예요 · 이어받기</button>`;
        else if (!on && s) btn = `<button type="button" class="btn small" data-a="takeover" data-seat="${i}">${esc(s.name)} 자리 이어받기</button>`;
        return `<div class="seat filled"><div class="avatar">${esc((s && s.name || '?').slice(0, 1))}</div><div class="nm">${esc(s ? s.name : '')}</div><small><span class="dot ${on ? 'on' : 'off'}"></span>${on ? '접속 중' : '오프라인'}</small>
          ${btn}</div>`;
      }).join('');
      body = `<div class="panel home-card"><h2>이 방에는 이미 두 사람이 있어요</h2>
        <p class="hint" style="margin:0">다른 기기로 옮겨 왔다면 내 자리를 이어받을 수 있어요. 꺼진 기기는 1분쯤 지나야 오프라인으로 바뀌어요.</p>
        <div class="seats">${rows}</div>
        <button type="button" class="btn block" data-a="spectate">${ico('people')} 관전하기</button></div>`;
    } else {
      const seats = d.seats || [null, null];
      const link = inviteLink();
      const localOnly = !S.tunnelBase && (location.protocol === 'file:' || /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname));
      const seatHTML = [0, 1].map((i) => {
        const s = seats[i];
        if (!s) return `<div class="seat"><div class="avatar">?</div><div class="nm waiting-dots">기다리는 중</div><small>링크를 받은 사람이 들어오면 시작해요</small></div>`;
        const me = s.deviceId === deviceId;
        const on = peerOnline(s.deviceId);
        return `<div class="seat filled"><div class="avatar">${esc(s.name.slice(0, 1))}</div><div class="nm">${esc(s.name)}${me && H.playerTag(s.name, '나') ? ' (나)' : ''}</div><small><span class="dot ${on ? 'on' : 'off'}"></span>${on ? '접속 중' : '오프라인'}</small></div>`;
      }).join('');
      const starting = seats[0] && seats[1] && !d.game;
      body = `<div class="panel code-box"><span class="label">방 코드</span><div class="code-big" aria-label="방 코드 ${esc(S.code.split('').join(' '))}">${esc(S.code)}</div>
          <div class="link-row"><input class="input" id="invite-link" readonly value="${esc(link)}" aria-label="초대 링크"></div>
          <div class="share-row"><button type="button" class="btn primary" data-a="share">${ico('share')} 링크 보내기</button><button type="button" class="btn" data-a="copy">${ico('copy')} 복사</button></div>
          ${localOnly ? `<p class="note" style="margin:4px 0 0">이 주소는 이 컴퓨터에서만 열려요. 상대에게는 <b>방 코드 6글자</b>를 알려 주거나, GitHub Pages나 start.bat이 알려 주는 인터넷 주소로 들어오라고 해요.</p>` : ''}
        </div>
        <div class="seats">${seatHTML}</div>
        <p class="relay">${starting ? '<span class="waiting-dots">게임을 준비하는 중이에요</span>' : relay}</p>
        <p class="hint" style="text-align:center;margin:0">두 사람이 모이면 자동으로 시작해요. 먼저 할 사람은 무작위로 정해져요.</p>`;
    }
    setHTML(root, head + body + (d ? '' : `<p class="relay">${relay}</p>`));
  }

  // ───────── 결과 ─────────
  function renderResult() {
    const g = S.game;
    if (!g || !g.over) return;
    const w = g.over.winner;
    const root = $('#result-root');
    let title;
    if (S.mode === 'online' && !S.spectator && S.seat != null) title = w === S.seat ? '내가 이겼어요!' : `${nameOf(w)}님이 이겼어요`;
    else if (S.mode === 'bot') title = isBot(w) ? '봇이 이겼어요' : '내가 이겼어요!';
    else title = `${nameOf(w)}님 승리!`;
    const happy = isMe(w) || S.mode === 'local' || S.spectator;
    const reason = reasonText(g.over);
    const stw = E.stats(g, w);
    let detail = '';
    if (g.over.reason === 'points') detail = `총 ${stw.points}점으로 목표 20점을 넘었어요.`;
    else if (g.over.reason === 'crowns') detail = `왕관 ${stw.crowns}개를 모았어요.`;
    else if (g.over.reason === 'color') detail = `${CN[g.over.color]} 카드만으로 ${stw.colorPoints[g.over.color]}점을 냈어요.`;
    else if (g.over.reason === 'resign') detail = `${topic(1 - w)} 기권했어요.`;
    const finals = [0, 1].map((p) => {
      const st = E.stats(g, p);
      const pl = g.players[p];
      const nm = isBot(p) ? '봇' : pl.name;
      const best = COLORS.reduce((a, c) => (st.colorPoints[c] > st.colorPoints[a] ? c : a), COLORS[0]);
      return `<div class="panel final${p === w ? ' win' : ''}"><div class="fn">${p === w ? ico('crown') : ''}<span>${esc(nm)}${isMe(p) && H.playerTag(nm, '나') ? ' (나)' : ''}</span></div>
        <dl><dt>점수</dt><dd>${st.points}점</dd><dt>왕관</dt><dd>${st.crowns}개</dd><dt>카드</dt><dd>${pl.cards.length}장</dd><dt>왕실 카드</dt><dd>${pl.royals.length}장</dd><dt>최고 색</dt><dd>${st.colorPoints[best] ? CN[best] + ' ' + st.colorPoints[best] + '점' : '-'}</dd></dl>
        <div class="fcols">${COLORS.map((c) => `<div class="bchip c-${c}${st.bonuses[c] ? '' : ' zero'}">${st.bonuses[c]}</div>`).join('')}</div></div>`;
    }).join('');
    const loser = 1 - w;
    const canRematch = S.mode !== 'online' || (S.seat != null && !S.spectator);
    const nextFirst = isBot(loser) ? '봇이' : isMe(loser) ? '내가' : nameOf(loser) + '님이';
    const confetti = happy ? `<div class="confetti" aria-hidden="true">${Array.from({ length: 22 }, (_, i) => `<i style="left:${(i * 4.6 + 2) % 100}%;background:${['#D6AE5C', '#2F6BDA', '#1E9E62', '#D8403F', '#F3DCE4', '#EEF0F4'][i % 6]};animation-delay:${(i % 7) * 0.12}s"></i>`).join('')}</div>` : '';
    setHTML(root, `<div class="panel result-hero">${confetti}${happy ? use('ic-crown', 'trophy') : use('ic-gem', 'trophy')}<h1>${esc(title)}</h1><span class="reason">${esc(reason)}</span><p>${esc(detail)}</p></div>
      <div class="final-grid">${finals}</div>
      <div class="result-actions">
        ${canRematch ? `<button type="button" class="btn primary block" data-a="rematch">다시 하기</button><p class="hint" style="text-align:center;margin:-2px 0 0">다음 판은 ${esc(nextFirst)} 먼저 시작해요.</p>` : ''}
        <button type="button" class="btn block" data-a="view-board">마지막 보드 보기</button>
        <button type="button" class="btn ghost block" data-a="home">${ico('home')} 홈으로</button>
      </div>`);
  }

  // ───────── 공유 / 복사 ─────────
  function copyText(text) {
    const done = () => toast('초대 링크를 복사했어요. 카톡에 붙여 넣어 보내 주세요!', 'good');
    const fallback = () => {
      const inp = $('#invite-link');
      if (inp) { inp.focus(); inp.select(); inp.setSelectionRange(0, 9999); }
      let ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      if (ok) done(); else toast('자동 복사가 안 돼요. 선택된 링크를 길게 눌러 복사해 주세요.');
    };
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(done, fallback);
    else fallback();
  }
  function shareLink() {
    const url = inviteLink();
    const data = { title: '스플렌더 대결', text: `스플렌더 대결 한 판 해요! 방 코드 ${S.code}`, url };
    if (navigator.share) {
      navigator.share(data).catch((e) => { if (!e || e.name !== 'AbortError') copyText(url); });
    } else copyText(url);
  }

  // ───────── 클릭 처리 ─────────
  const A = {
    noop(el) { toast(el.dataset.why); },
    'sheet-close'() { closeSheet(); },
    create() {
      if (!needName()) return;
      if (!N) { toast('온라인 모듈을 불러오지 못했어요.', 'bad'); return; }
      enterRoom(N.newRoomCode(), true);
    },
    'join-code'() {
      const inp = $('#in-code');
      const code = N ? N.normalizeRoom(inp ? inp.value : '') : '';
      if (!N || !N.isRoomCode(code)) { toast('방 코드 6글자를 다시 확인해 주세요.', 'bad'); if (inp) inp.focus(); return; }
      if (!needName()) return;
      enterRoom(code, false);
    },
    'invite-join'() { if (!needName()) return; const c = S.invite; S.invite = null; enterRoom(c, false); },
    'create-here'() { const code = S.code; enterRoom(code, true); },
    'resume-room'(el) { if (!needName()) return; enterRoom(el.dataset.code, false); },
    'room-remove'(el) {
      const code = el.dataset.code;
      store.set('sd.recent', recentRooms().filter((r) => r.code !== code));
      store.del('sd.room.' + code);
      renderHome();
    },
    'resume-local'() { resumeLocal(); },
    'local-remove'() {
      confirm({ title: '저장된 게임을 지울까요?', text: '지우면 이 게임은 다시 이어할 수 없어요.', ok: '지우기', danger: true, onOk: () => { store.del('sd.local'); renderHome(); } });
    },
    hotseat() {
      const nm = (($('#in-name') || {}).value || S.name || '').trim();
      if (nm) { S.name = nm.slice(0, 12); store.set('sd.name', S.name); }
      openSheet('hotseat', { a: S.name || '', b: '' });
    },
    'hs-start'() {
      const a = (($('#hs-a') || {}).value || '').trim().slice(0, 12) || '플레이어 1';
      const b = (($('#hs-b') || {}).value || '').trim().slice(0, 12) || '플레이어 2';
      if (a === b) { toast('두 사람 이름을 다르게 적어 주세요.', 'bad'); return; }
      closeSheet(true);
      startLocal('local', [a, b], rand32() & 1);
    },
    bot() {
      if (!B) { toast('봇을 불러오지 못했어요.', 'bad'); return; }
      const nm = (($('#in-name') || {}).value || S.name || '').trim();
      if (nm) { S.name = nm.slice(0, 12); store.set('sd.name', S.name); }
      openSheet('bot', { level: store.get('sd.botLevel', 'easy') === 'normal' ? 'normal' : 'easy', first: 'random' });
    },
    'bot-level'(el) { S.sheet.level = el.dataset.v; renderSheet(); },
    'bot-first'(el) { S.sheet.first = el.dataset.v; renderSheet(); },
    'bot-start'() {
      const sh = S.sheet;
      store.set('sd.botLevel', sh.level);
      const first = sh.first === 'me' ? 0 : sh.first === 'bot' ? 1 : (rand32() & 1);
      closeSheet(true);
      startLocal('bot', [myName() || '나', '봇'], first, { level: sh.level });
    },
    rules() { openSheet('rules'); },
    sound() {
      S.sound = !S.sound;
      store.set('sd.sound', S.sound);
      if (S.sound) { const c = getAudio(); if (c && c.state === 'suspended') c.resume().then(() => chime(), () => {}); else chime(); }
      toast(S.sound ? '소리를 켰어요.' : '소리를 껐어요.');
      render();
    },
    home() {
      if (S.screen === 'game' && S.game && !S.game.over && S.mode !== 'online') { closeSheet(true); saveLocal(); }
      goHome();
    },
    share() { shareLink(); },
    copy() { copyText(inviteLink()); },
    takeover(el) {
      const seat = Number(el.dataset.seat);
      const s = S.doc && S.doc.seats && S.doc.seats[seat];
      if (!s) return;
      const text = el.dataset.own
        ? `이 기기에서 내 자리(${s.name})로 이어서 할까요? 다른 기기에서 아직 하고 있다면 그 기기는 관전으로 바뀌어요.`
        : `이 기기에서 ${s.name} 자리로 이어서 할까요? 원래 기기에서는 더 이상 둘 수 없게 돼요.`;
      confirm({ title: `${s.name} 자리 이어받기`, text, ok: '이어받기', onOk: () => takeover(seat) });
    },
    'other-ways'() { S.otherWays = !S.otherWays; renderHome(); },
    'open-external'() {
      // 카카오톡 인앱 브라우저 → 기본 브라우저로 열기
      location.href = 'kakaotalk://web/openExternal?url=' + encodeURIComponent(location.href);
    },
    player(el) { openSheet('player', { p: Number(el.dataset.p) }); },
    'coach-rules'(el) {
      const sec = el.dataset.sec;
      openSheet('rules');
      setTimeout(() => { const h = document.getElementById('rule-' + sec); if (h && h.scrollIntoView) h.scrollIntoView({ block: 'start' }); }, 80);
    },
    'coach-x'() { setCoach('done'); render(); },
    spectate() { S.spectator = true; route(); },
    menu() { openSheet('menu'); },
    log() { openSheet('log'); },
    emote() { openSheet('emote'); },
    'emote-send'(el) {
      const e = el.dataset.e;
      if (S.room) S.room.emote(e);
      floatEmote(e, false, '');
      closeSheet();
    },
    cards(el) { openSheet('cards', { p: Number(el.dataset.p) }); },
    resign() {
      const g = S.game;
      if (!g || g.over) return;
      let player = g.turn.player;
      if (S.mode === 'online') player = S.seat;
      else if (S.mode === 'bot') player = 1 - S.botSeat;
      const nm = S.mode === 'local' ? `${nameOf(player)}님이 ` : '';
      confirm({ title: '기권할까요?', text: `${nm}기권하면 이번 게임은 바로 상대의 승리로 끝나요.`, ok: '기권하기', danger: true, onOk: () => act({ type: 'resign', player }) });
    },
    'confirm-ok'() {
      const sh = S.sheet;
      const fn = sh && sh.onOk;
      closeSheet(true);
      if (fn) fn();
    },
    cell(el) { tapCell(Number(el.dataset.i)); },
    card(el) { openCard({ from: 'pyramid', level: Number(el.dataset.l), slot: Number(el.dataset.s) }); },
    deck(el) { openSheet('deck', { level: Number(el.dataset.l) }); },
    res(el) {
      const p = Number(el.dataset.p);
      const i = Number(el.dataset.i);
      const r = S.game.players[p].reserved[i];
      if (!r) return;
      if (!canSee(p, r)) { toast(`${whose(p)} 더미에서 몰래 예약한 카드라 뒷면만 보여요.`); return; }
      openCard({ from: 'reserved', p, index: i });
    },
    royal() {
      const v = view();
      if (v.can && v.head && v.head.kind === 'royal') { openPendingSheet(); return; }
      toast('왕관이 3개, 6개가 될 때 이 중에서 1장을 가져와요.');
    },
    'pay-more'(el) {
      const t = el.dataset.t;
      if (S.sheet.pay && S.sheet.pay[t] > 0) S.sheet.pay[t]--;
      renderSheet();
    },
    'pay-less'(el) {
      const t = el.dataset.t;
      if (S.sheet.pay) S.sheet.pay[t]++;
      renderSheet();
    },
    joker(el) { S.sheet.joker = el.dataset.c; renderSheet(); },
    buy() {
      const sh = S.sheet;
      const info = sheetCardInfo();
      if (!info) return;
      const src = sh.src.from === 'pyramid' ? { from: 'pyramid', level: sh.src.level, slot: sh.src.slot } : { from: 'reserved', index: sh.src.index };
      const a = { type: 'buy', source: src, payment: Object.assign({}, sh.pay) };
      if (E.cardById(info.id).bonus === 'joker') a.jokerColor = sh.joker;
      if (act(a)) closeSheet();
    },
    reserve() {
      const sh = S.sheet;
      startReserve({ from: 'pyramid', level: sh.src.level, slot: sh.src.slot });
    },
    'reserve-deck'() { startReserve({ from: 'deck', level: S.sheet.level }); },
    'gold-cancel'() { S.ui = freshUI(); render(); },
    'gold-ok'() {
      const ui = S.ui;
      if (ui.goldCell == null || !ui.reserve) return;
      act({ type: 'reserve', source: ui.reserve, goldCell: ui.goldCell });
    },
    take() {
      const sel = S.ui.sel.slice();
      if (!sel.length) return;
      act({ type: 'take', cells: sel });
    },
    'sel-clear'() { S.ui.sel = []; render(); },
    priv() {
      const v = view();
      if (!v.canPriv) return;
      S.ui = freshUI();
      S.ui.mode = 'privilege';
      render();
      revealBoard();
    },
    'priv-end'() { S.ui.mode = null; render(); },
    refill() {
      const g = S.game;
      const v = view();
      if (!v.canRefill) return;
      const opp = 1 - v.cur;
      const oppFull = g.privilegeSupply === 0 && g.players[opp].privileges >= K.PRIVILEGES;
      const gift = oppFull ? `${topic(opp)} 이미 특권이 3개라 더 받지 않아요.` : (g.privilegeSupply === 0 ? `공급처가 비어 있어서 ${whose(v.cur)} 특권 1개가 ${toWhom(opp)} 넘어가요.` : `대신 ${who(opp)} 특권 1개를 받아요.`);
      const priv = v.pl.privileges > 0 && !v.forced ? ' 채운 뒤에는 이번 차례에 특권을 쓸 수 없어요.' : '';
      const forced = v.forced ? '할 수 있는 행동이 없어서 보드를 먼저 채워야 해요. ' : '';
      confirm({ title: '보드를 채울까요?', text: `${forced}주머니의 토큰 ${v.bagTotal}개를 보드 빈칸에 채워요. ${gift}${priv}`, ok: '채우기', onOk: () => act({ type: 'replenish' }) });
    },
    pass() { act({ type: 'pass' }); },
    'pending-open'() { openPendingSheet(); },
    steal(el) { if (act({ type: 'steal', token: el.dataset.t })) closeSheet(); },
    'royal-sel'(el) { S.sheet.pick = el.dataset.id; renderSheet(); },
    'royal-ok'() { const id = S.sheet.pick; if (id && act({ type: 'royal', id })) closeSheet(); },
    'disc-more'(el) { const t = el.dataset.t; S.sheet.disc[t]++; renderSheet(); },
    'disc-less'(el) { const t = el.dataset.t; if (S.sheet.disc[t] > 0) S.sheet.disc[t]--; renderSheet(); },
    'disc-ok'() { const d = Object.assign({}, S.sheet.disc); if (act({ type: 'discard', tokens: d })) closeSheet(); },
    result() { S.viewBoard = false; S.resultKey = gameKey(S.game); route(); },
    'view-board'() { S.viewBoard = true; route(); },
    rematch() { rematch(); },
  };

  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-a]');
    if (!el || el.disabled) return;
    const fn = A[el.dataset.a];
    if (!fn) return;
    e.preventDefault();
    try { fn(el, e); } catch (err) { console.error(err); toast('앗, 문제가 생겼어요. 다시 시도해 주세요.', 'bad'); }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && S.sheet) { closeSheet(); return; }
    if (e.key === 'Enter' && e.target && e.target.id === 'in-code') A['join-code']();
    if (e.key === 'Enter' && e.target && e.target.id === 'in-name') {
      // 초대받은 화면에서는 Enter = 참가하기
      if (S.invite && S.screen === 'home') { e.preventDefault(); A['invite-join'](); } else e.target.blur();
    }
    if (e.key === 'Enter' && e.target && (e.target.id === 'hs-a' || e.target.id === 'hs-b')) A['hs-start']();
  });
  document.addEventListener('input', (e) => {
    const t = e.target;
    if (t.id === 'in-name') { S.name = t.value.slice(0, 12); store.set('sd.name', S.name.trim()); }
    if (t.id === 'in-code') {
      const raw = t.value;
      const norm = (N ? N.normalizeRoom(raw) : raw.toUpperCase().replace(/[^A-Z0-9]/g, '')).slice(0, 6);
      if (norm !== raw) t.value = norm;
    }
  });
  if (MQ) {
    const onMQ = () => { S.compact = MQ.matches; render(); };
    if (MQ.addEventListener) MQ.addEventListener('change', onMQ); else if (MQ.addListener) MQ.addListener(onMQ);
  }
  window.addEventListener('online', () => render());
  window.addEventListener('offline', () => render());
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') render(); });

  // ───────── 시작 ─────────
  const E_ROYAL_IDS = (window.SDCards && window.SDCards.ROYALS ? window.SDCards.ROYALS.map((r) => r.id) : ['R1', 'R2', 'R3', 'R4']);

  function boot() {
    const qRoom = QS.get('room');
    const code = qRoom && N ? N.normalizeRoom(qRoom) : '';
    if (code && N && N.isRoomCode(code)) {
      if (myName()) { enterRoom(code, false); return; }
      S.invite = code;
      show('home');
      setTimeout(() => { const i = $('#in-name'); if (i) i.focus(); }, 50);
      return;
    }
    if (qRoom) setUrlRoom(null);
    let active = null;
    try { active = sessionStorage.getItem('sd.active'); } catch (e) { active = null; }
    if (active === 'local' && resumeLocal()) return;
    show('home');
  }

  if (DEBUG) {
    window.__sd = {
      S, E,
      get game() { return S.game; },
      get doc() { return S.doc; },
      act,
      view: () => (S.game ? view() : null),
      state() {
        const g = S.game;
        return { screen: S.screen, mode: S.mode, seat: S.seat, code: S.code, spectator: S.spectator, sheet: S.sheet && S.sheet.kind, over: g && g.over, turn: g && g.turn, pending: g && g.pending, seq: S.doc && S.doc.seq, sending: !!(S.delivery && S.delivery.state === 'pending'), delivery: S.delivery, synced: S.synced, pill: (sendPill() || {}).text || null, compact: S.compact, sel: S.ui.sel.slice(), status: S.status, oppOnline: S.oppOnline, moveRef: S.moveRef };
      },
      autoplay(opts) { S.auto = Object.assign({ delay: 60, level: 'easy' }, opts || {}); tickAuto(); },
      stop() { S.auto = null; clearTimeout(S.autoTimer); },
      setGame(g) { if (S.mode === 'online') return false; const prev = S.game; S.game = g; saveLocal(); onGameChanged(prev, g, null); return true; },
    };
  }

  boot();
})();
