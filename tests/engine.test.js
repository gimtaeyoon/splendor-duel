// 규칙 엔진 단위 테스트 (node --test)
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const E = require('../js/engine.js');
const { CARDS, ROYALS } = require('../js/cards.js');

const { COLORS, TOKENS, SPIRAL } = E.CONSTANTS;
const HANGUL = /[가-힣]/;

// ── 도우미 ──
function game(opts) { return E.newGame(Object.assign({ names: ['가영', '나준'], first: 0, seed: 7 }, opts)); }
function toks(o) { return Object.assign({ white: 0, blue: 0, green: 0, red: 0, black: 0, pearl: 0, gold: 0 }, o); }
function act(s, a) {
  const r = E.apply(s, a);
  assert.ok(r.ok, 'expected ok: ' + JSON.stringify(a) + ' -> ' + r.error);
  return r;
}
function rej(s, a, re) {
  const r = E.apply(s, a);
  assert.strictEqual(r.ok, false, 'expected rejection: ' + JSON.stringify(a));
  assert.strictEqual(typeof r.error, 'string');
  assert.match(r.error, HANGUL);
  if (re) assert.match(r.error, re);
  return r;
}
function sumT(t) { return TOKENS.reduce((n, k) => n + (t[k] || 0), 0); }
function deepFreeze(o) {
  if (o && typeof o === 'object') { Object.values(o).forEach(deepFreeze); Object.freeze(o); }
  return o;
}
function mulberry(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// 보드를 전부 한 색으로 (특정 칸 덮어쓰기)
function board(fill, overrides) {
  const b = new Array(25).fill(fill === undefined ? null : fill);
  Object.keys(overrides || {}).forEach(k => { b[+k] = overrides[k]; });
  return b;
}
// 피라미드 1레벨 0번 자리에 카드를 둔 상태
function withCard(s, id, level, slot) {
  level = level || CARDS.find(c => c.id === id).level;
  s.pyramid[level][slot || 0] = id;
  // 덱/피라미드 다른 곳에 있으면 제거 (보존 불변식은 단위 테스트에서 중요하지 않지만 깔끔하게)
  for (const l of [1, 2, 3]) s.decks[l] = s.decks[l].filter(x => x !== id);
  return s;
}
const buyPyr = (level, slot, extra) => Object.assign({ type: 'buy', source: { from: 'pyramid', level, slot } }, extra);

// ── 준비 ──
test('setup: pyramid, decks, board, bag, privileges, royals', () => {
  for (const first of [0, 1]) {
    const s = game({ first, seed: 123 + first });
    assert.strictEqual(s.v, 1);
    assert.deepStrictEqual([s.pyramid[3].length, s.pyramid[2].length, s.pyramid[1].length], [3, 4, 5]);
    for (const l of [1, 2, 3]) {
      assert.ok(s.pyramid[l].every(id => typeof id === 'string'));
      s.pyramid[l].forEach(id => assert.strictEqual(E.cardById(id).level, l));
      s.decks[l].forEach(id => assert.strictEqual(E.cardById(id).level, l));
    }
    // 30/24/13장 - 피라미드 5/4/3장 = 25/20/10장
    assert.deepStrictEqual([s.decks[1].length, s.decks[2].length, s.decks[3].length], [25, 20, 10]);
    const all = [].concat(s.decks[1], s.decks[2], s.decks[3], s.pyramid[1], s.pyramid[2], s.pyramid[3]);
    assert.strictEqual(new Set(all).size, 67);
    // 보드: 25칸 모두 채움, 4/4/4/4/4/2/3
    assert.strictEqual(s.board.length, 25);
    assert.ok(s.board.every(t => t !== null));
    const cnt = toks();
    s.board.forEach(t => cnt[t]++);
    assert.deepStrictEqual(cnt, toks({ white: 4, blue: 4, green: 4, red: 4, black: 4, pearl: 2, gold: 3 }));
    assert.strictEqual(sumT(s.bag), 0);
    assert.strictEqual(s.privilegeSupply, 2);
    assert.strictEqual(s.players[first].privileges, 0);
    assert.strictEqual(s.players[1 - first].privileges, 1);
    assert.deepStrictEqual(s.royals, ['R1', 'R2', 'R3', 'R4']);
    assert.deepStrictEqual(s.turn, { player: first, number: 1, replenished: false, mainDone: false, extraTurn: false });
    assert.deepStrictEqual(s.pending, []);
    assert.strictEqual(s.over, null);
    assert.deepStrictEqual(s.players.map(p => p.name), ['가영', '나준']);
    for (const p of s.players) {
      assert.strictEqual(sumT(p.tokens), 0);
      assert.deepStrictEqual([p.cards, p.reserved, p.royals], [[], [], []]);
    }
  }
});

test('SPIRAL matches the rulebook order grid and is a permutation', () => {
  const grid = [
    [17, 18, 19, 20, 21],
    [16, 5, 6, 7, 22],
    [15, 4, 1, 8, 23],
    [14, 3, 2, 9, 24],
    [13, 12, 11, 10, 25]];
  const expected = new Array(25);
  grid.forEach((row, r) => row.forEach((n, c) => { expected[n - 1] = r * 5 + c; }));
  assert.deepStrictEqual(SPIRAL, expected);
  assert.deepStrictEqual([...SPIRAL].sort((a, b) => a - b), [...Array(25).keys()]);
  assert.deepStrictEqual(E.CONSTANTS.PYRAMID_SIZES, { 1: 5, 2: 4, 3: 3 });
  assert.strictEqual(E.CONSTANTS.MAX_TOKENS, 10);
  assert.strictEqual(E.CONSTANTS.MAX_RESERVED, 3);
  assert.strictEqual(E.CONSTANTS.PRIVILEGES, 3);
});

test('setup fills the board in SPIRAL order (shuffled token list laid along the spiral)', () => {
  // 같은 시드로 두 번 → 같은 보드; 시드마다 다른 보드
  assert.deepStrictEqual(game({ seed: 99 }).board, game({ seed: 99 }).board);
  const boards = new Set();
  for (let i = 0; i < 20; i++) boards.add(game({ seed: i }).board.join());
  assert.ok(boards.size >= 19);
});

test('cardById / royalById', () => {
  assert.strictEqual(E.cardById('3J1').ability, 'extra_turn');
  assert.strictEqual(E.royalById('R4').points, 3);
  assert.strictEqual(E.cardById('nope'), null);
  assert.strictEqual(E.royalById('R9'), null);
});

// ── 순수성, 결정성, JSON ──
function playSeq(seed, n, roundTrip) {
  const rnd = mulberry(seed * 7 + 1);
  let s = E.newGame({ names: ['a', 'b'], first: seed % 2, seed });
  const trace = [];
  for (let i = 0; i < n && !s.over; i++) {
    const acts = E.legalActions(s);
    const buys = acts.filter(a => a.type === 'buy');
    const a = buys.length && rnd() < 0.6 ? buys[Math.floor(rnd() * buys.length)] : acts[Math.floor(rnd() * acts.length)];
    const input = roundTrip ? JSON.parse(JSON.stringify(s)) : s;
    const r = act(input, a);
    s = r.state;
    trace.push(JSON.stringify(a));
  }
  return { s, trace };
}

test('determinism: same seed + same actions → identical states', () => {
  for (const seed of [1, 2, 3]) {
    const a = playSeq(seed, 150, false);
    const b = playSeq(seed, 150, false);
    assert.deepStrictEqual(a.trace, b.trace);
    assert.deepStrictEqual(a.s, b.s);
  }
  // 보드 채우기 결과도 rng로 결정됨
  const s = game();
  s.board = board(null, { 0: 'gold' });
  s.bag = toks({ white: 4, blue: 4, green: 4, red: 4, black: 4, pearl: 2, gold: 2 });
  const r1 = act(s, { type: 'replenish' }), r2 = act(s, { type: 'replenish' });
  assert.deepStrictEqual(r1.state.board, r2.state.board);
  assert.notStrictEqual(r1.state.rng, s.rng);
});

test('JSON round-trip: state stays plain JSON and keeps working', () => {
  for (const seed of [11, 12]) {
    const a = playSeq(seed, 200, false);
    const b = playSeq(seed, 200, true);
    assert.deepStrictEqual(a.trace, b.trace);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(a.s)), JSON.parse(JSON.stringify(b.s)));
    assert.deepStrictEqual(JSON.parse(JSON.stringify(a.s)), a.s);
  }
});

test('immutability: apply / legalActions / helpers never mutate the input', () => {
  let s = game({ seed: 5 });
  const rnd = mulberry(5);
  for (let i = 0; i < 80 && !s.over; i++) {
    const before = JSON.stringify(s);
    const frozen = deepFreeze(JSON.parse(before));
    const acts = E.legalActions(frozen);
    for (const a of acts) {
      const r = E.apply(frozen, a);
      assert.ok(r.ok, r.error);
    }
    E.mainActionPossible(frozen);
    E.stats(frozen, 0);
    E.takeExtensions(frozen, []);
    for (const l of [1, 2, 3]) for (const id of frozen.pyramid[l]) if (id) {
      E.effectiveCost(frozen, 0, id); E.defaultPayment(frozen, 1, id); E.jokerOptions(frozen, 0);
      E.validatePayment(frozen, 0, id, toks({}));
    }
    E.apply(frozen, { type: 'take', cells: [0, 1, 2] });
    E.apply(frozen, { type: 'resign', player: 1 });
    assert.strictEqual(JSON.stringify(frozen), before);
    const a = acts[Math.floor(rnd() * acts.length)];
    s = act(s, a).state;
  }
});

// ── 토큰 가져오기 ──
test('take: straight contiguous lines in all 4 directions, any order', () => {
  const s = game();
  s.board = board('blue');
  const ok = [
    [0], [12], [24],
    [0, 1], [1, 0], [0, 5], [0, 6], [4, 8], [8, 4], [9, 13],
    [0, 1, 2], [2, 0, 1], [1, 2, 0], [22, 23, 24],        // 가로
    [2, 7, 12], [12, 2, 7], [14, 24, 19],                 // 세로
    [0, 6, 12], [18, 6, 12], [12, 18, 24],                // ↘ 대각선
    [4, 8, 12], [12, 8, 4], [14, 18, 22], [22, 14, 18], [10, 6, 2] // ↙ 대각선
  ];
  for (const cells of ok) {
    const v = E.validateTake(s, cells);
    assert.ok(v.ok, 'should be valid: ' + cells + ' ' + v.error);
    const r = act(s, { type: 'take', cells });
    assert.strictEqual(r.state.players[0].tokens.blue, cells.length);
    cells.forEach(c => assert.strictEqual(r.state.board[c], null));
    const ev = r.events.find(e => e.t === 'take');
    assert.deepStrictEqual(ev.cells, [...cells].sort((a, b) => a - b));
    assert.deepStrictEqual(ev.tokens, cells.map(() => 'blue'));
  }
});

test('take: rejects bent lines, gaps, wrap-around, wrong counts, duplicates', () => {
  const s = game();
  s.board = board('green');
  const bad = [
    [], [0, 1, 2, 3], [0, 0], [0, 1, 1],
    [0, 2], [0, 10], [0, 12], [0, 1, 3], [0, 6, 18],       // 틈
    [0, 1, 6], [0, 6, 7], [1, 5, 6], [0, 5, 11],           // 꺾인 줄 / L자
    [4, 5], [3, 4, 5], [5, 9], [9, 10], [0, 4, 8], [14, 15], // 줄바꿈 넘어가기
    [-1], [25], [1.5], ['3']
  ];
  for (const cells of bad) {
    const v = E.validateTake(s, cells);
    assert.strictEqual(v.ok, false, 'should be invalid: ' + JSON.stringify(cells));
    assert.match(v.error, HANGUL);
    rej(s, { type: 'take', cells });
  }
  rej(s, { type: 'take' });
  assert.match(E.validateTake(s, [0, 2]).error, /한 줄로 붙어/);
});

test('take: gold and empty cells break lines; gold is never taken', () => {
  const s = game();
  s.board = board('red', { 1: 'gold', 7: null, 20: 'pearl' });
  rej(s, { type: 'take', cells: [0, 1, 2] }, /금/);
  rej(s, { type: 'take', cells: [1] }, /금/);
  rej(s, { type: 'take', cells: [0, 2] });      // 금을 건너뛸 수 없음
  rej(s, { type: 'take', cells: [2, 7, 12] });  // 빈 칸 포함
  rej(s, { type: 'take', cells: [2, 12] });     // 빈 칸 건너뛰기
  rej(s, { type: 'take', cells: [7] }, /빈 칸/);
  act(s, { type: 'take', cells: [20] });        // 진주는 가능
  act(s, { type: 'take', cells: [15, 20] });
  assert.ok(!E.takeExtensions(s, [0]).includes(1));
  assert.ok(!E.takeExtensions(s, [0]).includes(2));
  assert.deepStrictEqual(E.takeExtensions(s, [0]).sort((a, b) => a - b), [5, 6]);
  assert.deepStrictEqual(E.takeExtensions(s, [0, 6]), [12]);
  assert.deepStrictEqual(E.takeExtensions(s, [0, 5, 10]), []);
  assert.deepStrictEqual(E.takeExtensions(s, [0, 2]), []);
  assert.strictEqual(E.takeExtensions(s, []).length, 23);
});

test('take penalty: 3 same colour or both pearls → opponent gains a privilege', () => {
  const s = game(); // 공급 2, 1번 플레이어 1
  s.board = board('blue', { 0: 'red', 1: 'red', 2: 'red', 5: 'pearl', 10: 'pearl', 15: 'white', 6: 'red', 7: 'red' });
  let r = act(s, { type: 'take', cells: [0, 1, 2] });
  assert.strictEqual(r.state.players[1].privileges, 2);
  assert.strictEqual(r.state.privilegeSupply, 1);
  assert.deepStrictEqual(r.events.find(e => e.t === 'gainPrivilege'), { t: 'gainPrivilege', p: 1, from: 'supply', reason: 'penalty', turnNo: 1 });
  assert.strictEqual(E.validateTake(s, [0, 1, 2]).privilegeToOpponent, true);
  // 진주 2개 (2개만 가져와도)
  r = act(s, { type: 'take', cells: [5, 10] });
  assert.strictEqual(r.state.players[1].privileges, 2);
  // 진주 2개 + 다른 보석
  r = act(s, { type: 'take', cells: [5, 10, 15] });
  assert.strictEqual(r.state.players[1].privileges, 2);
  // 페널티 없음: 같은 색 2개, 섞인 3개, 진주 1개
  for (const cells of [[0, 1], [6, 7, 8], [0, 5], [10, 15, 20]]) {
    r = act(s, { type: 'take', cells });
    assert.strictEqual(r.state.players[1].privileges, 1, 'no penalty for ' + cells);
    assert.strictEqual(E.validateTake(s, cells).privilegeToOpponent, false);
    assert.ok(!r.events.some(e => e.t === 'gainPrivilege'));
  }
});

test('privilege acquisition rule: supply → opponent → nothing (penalty source)', () => {
  const s = game();
  s.board = board('black');
  // 공급 0: 가져가는 사람에게서 뺏어옴
  s.privilegeSupply = 0; s.players[0].privileges = 2; s.players[1].privileges = 1;
  let r = act(s, { type: 'take', cells: [0, 1, 2] });
  assert.deepStrictEqual([r.state.players[0].privileges, r.state.players[1].privileges, r.state.privilegeSupply], [1, 2, 0]);
  assert.strictEqual(r.events.find(e => e.t === 'gainPrivilege').from, 'opponent');
  // 상대가 이미 3개 → 아무 일 없음
  s.players[0].privileges = 0; s.players[1].privileges = 3;
  r = act(s, { type: 'take', cells: [0, 1, 2] });
  assert.deepStrictEqual([r.state.players[0].privileges, r.state.players[1].privileges, r.state.privilegeSupply], [0, 3, 0]);
  assert.strictEqual(r.events.find(e => e.t === 'gainPrivilege').from, 'none');
});

// ── 특권 사용 ──
test('usePrivilege: any gem/pearl, never gold, repeatable per scroll, no penalty, back to supply', () => {
  const s = game();
  s.board = board('white', { 3: 'gold', 4: 'pearl', 9: 'pearl', 12: null });
  s.privilegeSupply = 0; s.players[0].privileges = 2; s.players[1].privileges = 1;
  rej(s, { type: 'usePrivilege', cell: 3 }, /금/);
  rej(s, { type: 'usePrivilege', cell: 12 }, /빈 칸/);
  rej(s, { type: 'usePrivilege', cell: 30 });
  let r = act(s, { type: 'usePrivilege', cell: 4 });
  assert.strictEqual(r.state.players[0].tokens.pearl, 1);
  assert.strictEqual(r.state.players[0].privileges, 1);
  assert.strictEqual(r.state.privilegeSupply, 1);
  assert.deepStrictEqual(r.events, [{ t: 'privilege', p: 0, cell: 4, token: 'pearl', turnNo: 1 }]);
  assert.strictEqual(r.state.turn.player, 0);
  assert.strictEqual(r.state.turn.mainDone, false);
  r = act(r.state, { type: 'usePrivilege', cell: 9 }); // 진주 2개째도 페널티 없음
  assert.strictEqual(r.state.players[1].privileges, 1);
  assert.strictEqual(r.state.players[0].privileges, 0);
  assert.strictEqual(r.state.privilegeSupply, 2);
  rej(r.state, { type: 'usePrivilege', cell: 0 }, /특권이 없어요/);
  // 그 뒤 주요 행동 가능
  r = act(r.state, { type: 'take', cells: [0, 1, 2] });
  assert.strictEqual(r.state.turn.player, 1);
});

test('usePrivilege: only before replenish and before the main action', () => {
  const s = game();
  s.board = board('white', { 0: null, 1: null });
  s.bag = toks({ red: 2 });
  s.players[0].privileges = 1; s.players[1].privileges = 0; s.privilegeSupply = 2;
  let r = act(s, { type: 'replenish' });
  assert.strictEqual(r.state.turn.replenished, true);
  rej(r.state, { type: 'usePrivilege', cell: 5 }, /보드를 채운 뒤/);
  assert.ok(!E.legalActions(r.state).some(a => a.type === 'usePrivilege' || a.type === 'replenish'));
  // 주요 행동 뒤 대기 결정 중에도 불가
  const t = game();
  withCard(t, '1W4', 1, 0);
  t.players[0].tokens = toks({ red: 2, black: 2 });
  t.players[0].privileges = 1; t.players[1].privileges = 0;
  r = act(t, buyPyr(1, 0));
  assert.strictEqual(r.state.pending[0].kind, 'bonusToken');
  rej(r.state, { type: 'usePrivilege', cell: 0 }, /흰색/);
  rej(r.state, { type: 'replenish' });
  rej(r.state, { type: 'take', cells: [0] });
});

// ── 보드 채우기 ──
test('replenish: needs a non-empty bag, fills empty cells in SPIRAL order, opponent gains a privilege', () => {
  const s = game();
  rej(s, { type: 'replenish' }, /주머니/);
  assert.ok(!E.legalActions(s).some(a => a.type === 'replenish'));
  // 빈 칸 10개, 주머니 6개 → 나선 순서상 앞의 빈 칸 6개가 채워짐
  const empties = [12, 16, 6, 8, 18, 22, 20, 0, 2, 24];
  s.board = board('blue');
  empties.forEach(c => { s.board[c] = null; });
  s.bag = toks({ red: 3, pearl: 1, gold: 2 });
  const r = act(s, { type: 'replenish' });
  const order = SPIRAL.filter(c => empties.includes(c));
  const filled = order.slice(0, 6), left = order.slice(6);
  filled.forEach(c => assert.notStrictEqual(r.state.board[c], null));
  left.forEach(c => assert.strictEqual(r.state.board[c], null));
  assert.strictEqual(sumT(r.state.bag), 0);
  const placed = toks();
  filled.forEach(c => placed[r.state.board[c]]++);
  assert.deepStrictEqual(placed, toks({ red: 3, pearl: 1, gold: 2 }));
  const ev = r.events.find(e => e.t === 'replenish');
  assert.deepStrictEqual(ev.cells, filled);
  assert.deepStrictEqual(ev.tokens, filled.map(c => r.state.board[c]));
  assert.deepStrictEqual(r.events.find(e => e.t === 'gainPrivilege'), { t: 'gainPrivilege', p: 1, from: 'supply', reason: 'replenish', turnNo: 1 });
  assert.strictEqual(r.state.players[1].privileges, 2);
  assert.strictEqual(r.state.turn.replenished, true);
  assert.strictEqual(r.state.turn.player, 0);
  rej(r.state, { type: 'replenish' });
  // 공급이 비었으면 채운 사람에게서 가져감
  s.privilegeSupply = 0; s.players[0].privileges = 2; s.players[1].privileges = 1;
  const r2 = act(s, { type: 'replenish' });
  assert.deepStrictEqual([r2.state.players[0].privileges, r2.state.players[1].privileges], [1, 2]);
});

test('replenish: random draws are spread over the bag contents (seeded)', () => {
  const s = game();
  s.board = board(null);
  s.bag = toks({ white: 4, blue: 4, green: 4, red: 4, black: 4, pearl: 2, gold: 3 });
  const firstCell = {};
  for (let seed = 0; seed < 200; seed++) {
    s.rng = seed;
    const r = act(s, { type: 'replenish' });
    assert.ok(r.state.board.every(t => t !== null));
    firstCell[r.state.board[12]] = (firstCell[r.state.board[12]] || 0) + 1;
  }
  assert.strictEqual(Object.keys(firstCell).length, 7);
});

// ── 예약 ──
test('reserve from pyramid: takes the chosen gold, refills the slot from the deck', () => {
  const s = game();
  s.board = board('blue', { 3: 'gold', 20: 'gold' });
  const id = s.pyramid[2][1];
  const top = s.decks[2][s.decks[2].length - 1];
  const r = act(s, { type: 'reserve', source: { from: 'pyramid', level: 2, slot: 1 }, goldCell: 20 });
  const pl = r.state.players[0];
  assert.deepStrictEqual(pl.reserved, [{ id, fromDeck: false }]);
  assert.strictEqual(pl.tokens.gold, 1);
  assert.strictEqual(r.state.board[20], null);
  assert.strictEqual(r.state.board[3], 'gold');
  assert.strictEqual(r.state.pyramid[2][1], top);
  assert.strictEqual(r.state.decks[2].length, s.decks[2].length - 1);
  const ev = r.events.find(e => e.t === 'reserve');
  assert.deepStrictEqual(ev, { t: 'reserve', p: 0, cardId: id, source: { from: 'pyramid', level: 2, slot: 1 }, fromDeck: false, goldCell: 20, refill: top, turnNo: 1 });
  assert.strictEqual(r.state.turn.player, 1);
});

test('reserve: from deck top marks fromDeck; empty deck leaves slot empty / cannot be drawn', () => {
  const s = game();
  s.board = board('blue', { 7: 'gold' });
  const top = s.decks[3][s.decks[3].length - 1];
  let r = act(s, { type: 'reserve', source: { from: 'deck', level: 3 }, goldCell: 7 });
  assert.deepStrictEqual(r.state.players[0].reserved, [{ id: top, fromDeck: true }]);
  assert.strictEqual(r.state.decks[3].length, 9);
  assert.deepStrictEqual(r.state.pyramid[3], s.pyramid[3]);
  assert.strictEqual(r.events.find(e => e.t === 'reserve').fromDeck, true);
  s.decks[3] = [];
  rej(s, { type: 'reserve', source: { from: 'deck', level: 3 }, goldCell: 7 }, /더미/);
  r = act(s, { type: 'reserve', source: { from: 'pyramid', level: 3, slot: 2 }, goldCell: 7 });
  assert.strictEqual(r.state.pyramid[3][2], null);
  assert.strictEqual(r.events.find(e => e.t === 'reserve').refill, null);
  // 빈 자리는 예약 불가
  s.pyramid[3][2] = null;
  rej(s, { type: 'reserve', source: { from: 'pyramid', level: 3, slot: 2 }, goldCell: 7 }, /카드가 없어요/);
  assert.ok(!E.legalActions(s).some(a => a.type === 'reserve' && a.source.from === 'pyramid' && a.source.level === 3 && a.source.slot === 2));
});

test('reserve: needs gold on the board, a gold goldCell, fewer than 3 reserved and a card', () => {
  const s = game();
  s.board = board('blue');
  rej(s, { type: 'reserve', source: { from: 'deck', level: 1 }, goldCell: 0 }, /금/);
  assert.ok(!E.legalActions(s).some(a => a.type === 'reserve'));
  s.board[4] = 'gold';
  rej(s, { type: 'reserve', source: { from: 'deck', level: 1 }, goldCell: 0 }, /금 토큰이 있는 칸/);
  rej(s, { type: 'reserve', source: { from: 'deck', level: 4 }, goldCell: 4 });
  rej(s, { type: 'reserve', source: { from: 'pyramid', level: 1, slot: 9 }, goldCell: 4 });
  act(s, { type: 'reserve', source: { from: 'deck', level: 1 }, goldCell: 4 });
  s.players[0].reserved = [{ id: '1W1', fromDeck: false }, { id: '1W2', fromDeck: true }, { id: '1W3', fromDeck: false }];
  rej(s, { type: 'reserve', source: { from: 'deck', level: 1 }, goldCell: 4 }, /3장/);
  assert.ok(!E.legalActions(s).some(a => a.type === 'reserve'));
  // 모든 카드 출처가 비었으면 예약 불가
  const t = game();
  t.board = board('blue', { 4: 'gold' });
  t.decks = { 1: [], 2: [], 3: [] };
  t.pyramid = { 1: [null, null, null, null, null], 2: [null, null, null, null], 3: [null, null, null] };
  assert.ok(!E.legalActions(t).some(a => a.type === 'reserve'));
  rej(t, { type: 'reserve', source: { from: 'deck', level: 2 }, goldCell: 4 });
});

test('reserve: legalActions enumerates each gold cell × each source', () => {
  const s = game();
  s.board = board('blue', { 4: 'gold', 9: 'gold' });
  const res = E.legalActions(s).filter(a => a.type === 'reserve');
  assert.strictEqual(res.length, 2 * (12 + 3));
  res.forEach(a => act(s, a));
});

// ── 구매 ──
test('effectiveCost: bonuses reduce gem costs to min 0, pearls never reduced, double bonus counts 2', () => {
  const s = game();
  // 빨강 3, 파랑 2, 초록 1 보너스 (룰북 예시와 같은 보너스)
  s.players[0].cards = ['1R1', '1R2', '1R3', '1U1', '1U2', '1G1'];
  // 3R1: 파랑5 초록3 검정3 진주1
  assert.deepStrictEqual(E.effectiveCost(s, 0, '3R1'), { white: 0, blue: 3, green: 2, red: 0, black: 3, pearl: 1 });
  // 2W1: 초록2 빨강2 검정2 진주1 → 빨강 0
  assert.deepStrictEqual(E.effectiveCost(s, 0, '2W1'), { white: 0, blue: 0, green: 1, red: 0, black: 2, pearl: 1 });
  // 더블 보너스
  s.players[1].cards = ['2U4']; // 파랑 2
  assert.deepStrictEqual(E.effectiveCost(s, 1, '3U2'), { white: 2, blue: 4, green: 2, red: 0, black: 0, pearl: 0 });
  assert.deepStrictEqual(E.stats(s, 1).bonuses, { white: 0, blue: 2, green: 0, red: 0, black: 0 });
  // 보너스 없는 카드는 할인하지 않음
  s.players[1].cards = ['1N1', '2N1', '3N1'];
  assert.deepStrictEqual(E.effectiveCost(s, 1, '1W1'), { white: 0, blue: 1, green: 1, red: 1, black: 1, pearl: 0 });
});

test('buy: default payment gems first, gold for shortfall incl. pearls; spent tokens go to the bag', () => {
  const s = game();
  withCard(s, '2W3', 2, 0); // 흰4 검2 진주1
  s.players[0].tokens = toks({ white: 3, black: 2, gold: 2, blue: 1 });
  assert.deepStrictEqual(E.defaultPayment(s, 0, '2W3'), toks({ white: 3, black: 2, gold: 2 }));
  const top = s.decks[2][s.decks[2].length - 1];
  const r = act(s, buyPyr(2, 0));
  const pl = r.state.players[0];
  assert.deepStrictEqual(pl.tokens, toks({ blue: 1 }));
  assert.deepStrictEqual(r.state.bag, toks({ white: 3, black: 2, gold: 2 }));
  assert.deepStrictEqual(pl.cards, ['2W3']);
  assert.strictEqual(r.state.pyramid[2][0], top);
  const ev = r.events.find(e => e.t === 'buy');
  assert.deepStrictEqual(ev.payment, toks({ white: 3, black: 2, gold: 2 }));
  assert.deepStrictEqual(ev.source, { from: 'pyramid', level: 2, slot: 0 });
  assert.strictEqual(ev.refill, top);
  // 살 수 없으면 null
  s.players[0].tokens = toks({ white: 3, black: 2, gold: 1 });
  assert.strictEqual(E.defaultPayment(s, 0, '2W3'), null);
  rej(s, buyPyr(2, 0), /모자라/);
  assert.ok(!E.legalActions(s).some(a => a.type === 'buy' && a.source.level === 2 && a.source.slot === 0));
});

test('buy: player may pay gold while holding gems; exact payment only', () => {
  const s = game();
  withCard(s, '1W1', 1, 0); // 파1 초1 빨1 검1
  s.players[0].tokens = toks({ blue: 1, green: 1, red: 1, black: 1, gold: 2, white: 3 });
  const good = [
    toks({ blue: 1, green: 1, red: 1, black: 1 }),
    toks({ blue: 1, green: 1, red: 1, gold: 1 }),
    toks({ green: 1, red: 1, gold: 2 })
  ];
  good.forEach(pay => {
    assert.ok(E.validatePayment(s, 0, '1W1', pay).ok);
    act(s, buyPyr(1, 0, { payment: pay }));
  });
  const bad = [
    [toks({ blue: 1, green: 1, red: 1 }), /모자라/],                              // 부족
    [toks({ blue: 1, green: 1, red: 1, black: 1, gold: 1 }), /금 토큰을 필요한 것보다/], // 필요 없는 금
    [toks({ blue: 1, green: 1, red: 1, black: 1, white: 1 }), /흰색/],               // 초과 지불
    [toks({ blue: 1, green: 1, red: 1, gold: 3 }), /가지고 있는 것보다|필요한 것보다/],
    [toks({ blue: 1, green: 1, red: 1, black: 1, pearl: 1 }), null],
    [toks({ blue: -1, green: 1, red: 1, black: 1, gold: 1 }), /결제/],
    [toks({ blue: 0.5, green: 1, red: 1, black: 1 }), /결제/]
  ];
  bad.forEach(([pay, re]) => {
    const v = E.validatePayment(s, 0, '1W1', pay);
    assert.strictEqual(v.ok, false, JSON.stringify(pay));
    assert.match(v.error, HANGUL);
    rej(s, buyPyr(1, 0, { payment: pay }), re);
  });
  // 가지고 있지 않은 토큰으로 결제
  s.players[0].tokens = toks({ blue: 1, green: 1, red: 1, gold: 1 });
  rej(s, buyPyr(1, 0, { payment: toks({ blue: 1, green: 1, red: 1, black: 1 }) }));
});

test('buy: gold covers pearls; empty-deck refill leaves the slot empty; buy reserved card', () => {
  const s = game();
  withCard(s, '1W3', 1, 2); // 파2 초2 진주1 (한 턴 더)
  s.decks[1] = [];
  s.players[0].tokens = toks({ blue: 2, green: 2, gold: 1 });
  const r = act(s, buyPyr(1, 2));
  assert.deepStrictEqual(r.events.find(e => e.t === 'buy').payment, toks({ blue: 2, green: 2, gold: 1 }));
  assert.strictEqual(r.state.pyramid[1][2], null);
  // 예약 카드 구매
  const t = game();
  t.players[0].reserved = [{ id: '1K1', fromDeck: true }, { id: '1R2', fromDeck: false }];
  t.players[0].tokens = toks({ black: 3 });
  rej(t, { type: 'buy', source: { from: 'reserved', index: 2 } }, /예약한 카드/);
  const r2 = act(t, { type: 'buy', source: { from: 'reserved', index: 1 } });
  assert.deepStrictEqual(r2.state.players[0].reserved, [{ id: '1K1', fromDeck: true }]);
  assert.deepStrictEqual(r2.state.players[0].cards, ['1R2']);
  assert.deepStrictEqual(r2.events.find(e => e.t === 'buy').source, { from: 'reserved', index: 1, fromDeck: false });
  assert.deepStrictEqual(r2.state.pyramid, t.pyramid);
  // 상대의 예약 카드는 살 수 없음 (자기 예약만)
  assert.ok(E.legalActions(t).filter(a => a.type === 'buy' && a.source.from === 'reserved').every(a => a.source.index < 2));
});

test('bonuses make cards free; bonus cards reduce later purchases', () => {
  const s = game();
  s.players[0].cards = ['2W4', '2U4', '2G4', '2R4', '2K4']; // 각 색 2
  withCard(s, '1W1', 1, 0);
  assert.deepStrictEqual(E.defaultPayment(s, 0, '1W1'), toks({}));
  act(s, buyPyr(1, 0));
});

// ── 조커 ──
test('joker: needs an owned bonus card, colour must be one of jokerOptions, gives exactly 1 bonus', () => {
  const s = game();
  withCard(s, '1J1', 1, 0); // 검4 진주1
  s.players[0].tokens = toks({ black: 4, pearl: 1 });
  assert.deepStrictEqual(E.jokerOptions(s, 0), []);
  rej(s, buyPyr(1, 0, { jokerColor: 'white' }), /보너스가 있는 카드/);
  assert.ok(!E.legalActions(s).some(a => a.type === 'buy'));
  // 보너스 없는 카드만 있으면 여전히 불가
  s.players[0].cards = ['1N1'];
  assert.deepStrictEqual(E.jokerOptions(s, 0), []);
  rej(s, buyPyr(1, 0, { jokerColor: 'white' }));
  // 흰색 더블 보너스 + 파랑
  s.players[0].cards = ['2W4', '1U1'];
  assert.deepStrictEqual(E.jokerOptions(s, 0), ['white', 'blue']);
  rej(s, buyPyr(1, 0), /색/);
  rej(s, buyPyr(1, 0, { jokerColor: 'red' }), /그 색/);
  rej(s, buyPyr(1, 0, { jokerColor: 'gold' }));
  const buys = E.legalActions(s).filter(a => a.type === 'buy' && a.source.from === 'pyramid' && a.source.level === 1 && a.source.slot === 0);
  assert.deepStrictEqual(buys.map(a => a.jokerColor), ['white', 'blue']);
  const r = act(s, buyPyr(1, 0, { jokerColor: 'white' }));
  assert.deepStrictEqual(r.state.players[0].jokerColor, { '1J1': 'white' });
  assert.deepStrictEqual(E.stats(r.state, 0).bonuses, { white: 3, blue: 1, green: 0, red: 0, black: 0 });
  assert.strictEqual(E.stats(r.state, 0).colorPoints.white, 1 + 1);
  assert.strictEqual(r.events.find(e => e.t === 'buy').jokerColor, 'white');
});

test('joker: its points count toward its colour (colour victory)', () => {
  const s = game();
  s.players[0].cards = ['3W1', '3W2', '2W1']; // 흰색 3+4+2 = 9점, 왕관 3
  withCard(s, '1J1', 1, 0);
  s.players[0].tokens = toks({ black: 4, pearl: 1 });
  let r = act(s, buyPyr(1, 0, { jokerColor: 'white' }));
  assert.deepStrictEqual(r.state.over, { winner: 0, reason: 'color', color: 'white' });
  assert.deepStrictEqual(r.events[r.events.length - 1], { t: 'win', p: 0, reason: 'color', color: 'white', turnNo: 1 });
  // 다른 색으로 붙이면 흰색 9점 그대로
  s.players[0].cards.push('1U1');
  r = act(s, buyPyr(1, 0, { jokerColor: 'blue' }));
  assert.strictEqual(r.state.over, null);
});

test('3J1 joker + extra turn: colour chosen in the buy, then the extra turn', () => {
  const s = game();
  s.players[0].cards = ['1R1'];
  withCard(s, '3J1', 3, 0); // 빨8 → 7
  s.players[0].tokens = toks({ red: 7 });
  const r = act(s, buyPyr(3, 0, { jokerColor: 'red' }));
  assert.strictEqual(r.state.turn.player, 0);
  assert.strictEqual(r.state.turn.number, 2);
  assert.deepStrictEqual(r.events.map(e => e.t), ['buy', 'extraTurn', 'turn']);
  assert.strictEqual(E.stats(r.state, 0).bonuses.red, 2);
});

// ── 능력 ──
test('ability extra_turn: same player again with a fresh turn', () => {
  const s = game();
  withCard(s, '1W3', 1, 0);
  s.players[0].tokens = toks({ blue: 2, green: 2, pearl: 1 });
  const r = act(s, buyPyr(1, 0));
  assert.deepStrictEqual(r.state.turn, { player: 0, number: 2, replenished: false, mainDone: false, extraTurn: false });
  assert.deepStrictEqual(r.events.find(e => e.t === 'extraTurn'), { t: 'extraTurn', p: 0, source: 'card', cardId: '1W3', turnNo: 1 });
  assert.deepStrictEqual(r.events.find(e => e.t === 'turn'), { t: 'turn', p: 0, number: 2, extra: true, turnNo: 2 });
  // 다음 턴은 평소처럼 상대에게
  const r2 = act(r.state, { type: 'take', cells: [E.legalActions(r.state).find(a => a.type === 'take').cells[0]] });
  assert.strictEqual(r2.state.turn.player, 1);
  assert.strictEqual(r2.state.turn.number, 3);
});

test('ability bonus_token: pending pick of that colour; skipped when none on the board', () => {
  const s = game();
  withCard(s, '1U4', 1, 0); // 흰2 검2, 파란 토큰 받기
  s.players[0].tokens = toks({ white: 2, black: 2 });
  s.board = board('red', { 3: 'blue', 17: 'blue', 12: 'gold' });
  let r = act(s, buyPyr(1, 0));
  assert.deepStrictEqual(r.state.pending, [{ kind: 'bonusToken', color: 'blue' }]);
  assert.strictEqual(r.state.turn.player, 0);
  assert.strictEqual(r.state.turn.mainDone, true);
  assert.deepStrictEqual(E.legalActions(r.state), [{ type: 'bonusToken', cell: 3 }, { type: 'bonusToken', cell: 17 }]);
  rej(r.state, { type: 'bonusToken', cell: 0 }, /파란색/);
  rej(r.state, { type: 'bonusToken', cell: 12 });
  rej(r.state, { type: 'take', cells: [0] }, /파란색 토큰 1개/);
  const r2 = act(r.state, { type: 'bonusToken', cell: 17 });
  assert.strictEqual(r2.state.players[0].tokens.blue, 1);
  assert.strictEqual(r2.state.board[17], null);
  assert.strictEqual(r2.state.turn.player, 1);
  assert.strictEqual(r2.state.players[1].privileges, 1); // 페널티 없음
  // 해당 색이 없으면 건너뜀
  s.board = board('red');
  r = act(s, buyPyr(1, 0));
  assert.deepStrictEqual(r.state.pending, []);
  assert.strictEqual(r.state.turn.player, 1);
  assert.ok(r.events.some(e => e.t === 'bonusToken' && e.skipped === true && e.token === 'blue'));
});

test('ability steal: pending pick of a gem/pearl the opponent holds; never gold; skipped if none', () => {
  const s = game();
  withCard(s, '2W2', 2, 0); // 파4 빨3
  s.players[0].tokens = toks({ blue: 4, red: 3 });
  s.players[1].tokens = toks({ pearl: 1, green: 2, gold: 2 });
  let r = act(s, buyPyr(2, 0));
  assert.deepStrictEqual(r.state.pending, [{ kind: 'steal' }]);
  assert.deepStrictEqual(E.legalActions(r.state), [{ type: 'steal', token: 'green' }, { type: 'steal', token: 'pearl' }]);
  rej(r.state, { type: 'steal', token: 'gold' }, /금/);
  rej(r.state, { type: 'steal', token: 'white' }, /가지고 있지 않아요/);
  const r2 = act(r.state, { type: 'steal', token: 'pearl' });
  assert.strictEqual(r2.state.players[0].tokens.pearl, 1);
  assert.strictEqual(r2.state.players[1].tokens.pearl, 0);
  assert.deepStrictEqual(r2.events.find(e => e.t === 'steal'), { t: 'steal', p: 0, token: 'pearl', from: 1, turnNo: 1 });
  assert.strictEqual(r2.state.turn.player, 1);
  // 상대가 금만 가지고 있으면 건너뜀
  s.players[1].tokens = toks({ gold: 3 });
  r = act(s, buyPyr(2, 0));
  assert.deepStrictEqual(r.state.pending, []);
  assert.strictEqual(r.state.turn.player, 1);
  assert.ok(r.events.some(e => e.t === 'steal' && e.skipped));
});

test('ability privilege: automatic, supply → opponent → nothing', () => {
  const s = game();
  withCard(s, '2U3', 2, 0); // 흰2 파4 진주1
  s.players[0].tokens = toks({ white: 2, blue: 4, pearl: 1 });
  let r = act(s, buyPyr(2, 0));
  assert.deepStrictEqual([r.state.players[0].privileges, r.state.privilegeSupply], [1, 1]);
  assert.deepStrictEqual(r.events.find(e => e.t === 'gainPrivilege'), { t: 'gainPrivilege', p: 0, from: 'supply', reason: 'ability', turnNo: 1 });
  s.privilegeSupply = 0; s.players[0].privileges = 1; s.players[1].privileges = 2;
  r = act(s, buyPyr(2, 0));
  assert.deepStrictEqual([r.state.players[0].privileges, r.state.players[1].privileges], [2, 1]);
  s.players[0].privileges = 3; s.players[1].privileges = 0;
  r = act(s, buyPyr(2, 0));
  assert.deepStrictEqual([r.state.players[0].privileges, r.state.players[1].privileges, r.state.privilegeSupply], [3, 0, 0]);
  assert.strictEqual(r.events.find(e => e.t === 'gainPrivilege').from, 'none');
});

// ── 왕실 카드 ──
test('royal at the 3rd crown: pending choice, then its ability (steal → pending steal)', () => {
  const s = game();
  s.players[0].cards = ['1W2', '1U2']; // 왕관 2
  withCard(s, '1G2', 1, 0); // 왕관 1, 빨3
  s.players[0].tokens = toks({ red: 3 });
  s.players[1].tokens = toks({ white: 1 });
  let r = act(s, buyPyr(1, 0));
  assert.deepStrictEqual(r.state.pending, [{ kind: 'royal' }]);
  assert.deepStrictEqual(E.legalActions(r.state).map(a => a.id), ['R1', 'R2', 'R3', 'R4']);
  rej(r.state, { type: 'royal', id: 'R7' }, /왕실/);
  rej(r.state, { type: 'take', cells: [0] }, /왕실 카드/);
  const r2 = act(r.state, { type: 'royal', id: 'R1' });
  assert.deepStrictEqual(r2.state.players[0].royals, ['R1']);
  assert.deepStrictEqual(r2.state.royals, ['R2', 'R3', 'R4']);
  assert.deepStrictEqual(r2.state.pending, [{ kind: 'steal' }]);
  const r3 = act(r2.state, { type: 'steal', token: 'white' });
  assert.strictEqual(r3.state.players[0].tokens.white, 1);
  assert.strictEqual(r3.state.turn.player, 1);
  assert.strictEqual(E.stats(r3.state, 0).points, 2);
  // 상대에게 보석이 없으면 왕실 훔치기 건너뜀
  s.players[1].tokens = toks({ gold: 1 });
  const r4 = act(act(s, buyPyr(1, 0)).state, { type: 'royal', id: 'R1' });
  assert.deepStrictEqual(r4.state.pending, []);
  assert.strictEqual(r4.state.turn.player, 1);
});

test('royal abilities: privilege and extra turn; 3-point royal plain', () => {
  const s = game();
  s.players[0].cards = ['1W2', '1U2'];
  withCard(s, '1G2', 1, 0);
  s.players[0].tokens = toks({ red: 3 });
  const pend = act(s, buyPyr(1, 0)).state;
  let r = act(pend, { type: 'royal', id: 'R3' });
  assert.strictEqual(r.state.players[0].privileges, 1);
  assert.deepStrictEqual(r.events.find(e => e.t === 'gainPrivilege'), { t: 'gainPrivilege', p: 0, from: 'supply', reason: 'royal', turnNo: 1 });
  r = act(pend, { type: 'royal', id: 'R2' });
  assert.strictEqual(r.state.turn.player, 0);
  assert.ok(r.events.some(e => e.t === 'extraTurn' && e.source === 'royal' && e.id === 'R2'));
  r = act(pend, { type: 'royal', id: 'R4' });
  assert.strictEqual(r.state.turn.player, 1);
  assert.strictEqual(E.stats(r.state, 0).points, 3);
});

test('royal again at the 6th crown, not in between', () => {
  const s = game();
  s.players[0].cards = ['3W1', '3U1', '1W2']; // 왕관 5
  s.players[0].royals = ['R4'];
  s.royals = ['R1', 'R2', 'R3'];
  withCard(s, '1U2', 1, 0); // 초3 (초록 보너스 없음)
  withCard(s, '1K1', 1, 1); // 왕관 0
  s.players[0].tokens = toks({ green: 3, white: 1, blue: 1, red: 1 });
  let r = act(s, buyPyr(1, 0));
  assert.deepStrictEqual(r.state.pending, [{ kind: 'royal' }]);
  assert.deepStrictEqual(E.legalActions(r.state).map(a => a.id), ['R1', 'R2', 'R3']);
  // 왕관 4 → 5: 왕실 없음
  s.players[0].cards = ['3W1', '3U1'];
  r = act(s, buyPyr(1, 0));
  assert.deepStrictEqual(r.state.pending, []);
  // 왕관 변화 없음
  s.players[0].cards = ['3W1', '3U1', '1W2'];
  r = act(s, buyPyr(1, 1));
  assert.deepStrictEqual(r.state.pending, []);
});

test('ability then royal order: joker with crowns (3J2) → royal', () => {
  const s = game();
  s.players[0].cards = ['1K1'];
  withCard(s, '3J2', 3, 0); // 검8 → 7, 왕관 3
  s.players[0].tokens = toks({ black: 7 });
  const r = act(s, buyPyr(3, 0, { jokerColor: 'black' }));
  assert.deepStrictEqual(r.state.pending, [{ kind: 'royal' }]);
});

// ── 토큰 제한 ──
test('discard: more than 10 tokens (gold counts) → pending discard of the excess, back to the bag', () => {
  const s = game();
  s.board = board('blue', { 0: 'gold' });
  s.players[0].tokens = toks({ white: 5, red: 4, gold: 1 });
  let r = act(s, { type: 'reserve', source: { from: 'deck', level: 1 }, goldCell: 0 });
  assert.deepStrictEqual(r.state.pending, [{ kind: 'discard', count: 1 }]);
  assert.strictEqual(r.state.turn.player, 0);
  const opts = E.legalActions(r.state);
  assert.strictEqual(opts.length, 3); // 흰/빨/금 중 1개
  rej(r.state, { type: 'discard', tokens: { white: 2 } }, /정확히 1개/);
  rej(r.state, { type: 'discard', tokens: { blue: 1 } }, /많이 버릴 수 없어요/);
  rej(r.state, { type: 'discard', tokens: {} });
  rej(r.state, { type: 'take', cells: [1] }, /1개를 버려야/);
  const r2 = act(r.state, { type: 'discard', tokens: { gold: 1 } });
  assert.strictEqual(r2.state.players[0].tokens.gold, 1);
  assert.strictEqual(r2.state.bag.gold, 1);
  assert.strictEqual(r2.state.turn.player, 1);
  assert.deepStrictEqual(r2.events[0], { t: 'discard', p: 0, tokens: toks({ gold: 1 }), turnNo: 1 });
  // 정확히 10개면 버리지 않음
  s.players[0].tokens = toks({ white: 5, red: 4 });
  r = act(s, { type: 'reserve', source: { from: 'deck', level: 1 }, goldCell: 0 });
  assert.deepStrictEqual(r.state.pending, []);
});

test('discard options: distinct multisets of exactly count tokens, capped at 300 with variety', () => {
  const s = game();
  s.players[0].tokens = toks({ white: 2, blue: 1, pearl: 1 });
  s.pending = [{ kind: 'discard', count: 2 }];
  s.turn.mainDone = true;
  const opts = E.legalActions(s);
  const keys = opts.map(a => JSON.stringify(a.tokens));
  assert.strictEqual(new Set(keys).size, opts.length);
  // {흰2}, {흰1 파1}, {흰1 진1}, {파1 진1}
  assert.strictEqual(opts.length, 4);
  opts.forEach(a => {
    assert.strictEqual(sumT(a.tokens), 2);
    TOKENS.forEach(k => assert.ok(a.tokens[k] <= s.players[0].tokens[k]));
    act(s, a);
  });
  // 큰 경우: 300개 이하, 서로 다름, 여러 종류 포함
  s.players[0].tokens = toks({ white: 4, blue: 4, green: 4, red: 4, black: 4, pearl: 2, gold: 3 });
  s.pending = [{ kind: 'discard', count: 8 }];
  const big = E.legalActions(s);
  assert.ok(big.length <= 300 && big.length >= 250, 'count ' + big.length);
  assert.strictEqual(new Set(big.map(a => JSON.stringify(a.tokens))).size, big.length);
  TOKENS.forEach(k => assert.ok(big.some(a => a.tokens[k] > 0), 'variety ' + k));
  big.forEach(a => assert.strictEqual(sumT(a.tokens), 8));
  big.slice(0, 20).forEach(a => act(s, a));
});

// ── 승리 ──
test('victory: 20 points (cards + royals)', () => {
  const s = game();
  s.players[0].cards = ['3N1', '3W2', '3U2', '3G2']; // 18점
  withCard(s, '2W1', 2, 0); // 2점: 초2 빨2 검2 진1 → 초록 보너스 1
  s.players[0].tokens = toks({ green: 1, red: 2, black: 2, pearl: 1 });
  const r = act(s, buyPyr(2, 0));
  assert.deepStrictEqual(r.state.over, { winner: 0, reason: 'points' });
  assert.deepStrictEqual(E.legalActions(r.state), []);
  rej(r.state, { type: 'take', cells: [0] }, /끝났어요/);
  rej(r.state, { type: 'resign', player: 1 }, /끝났어요/);
  assert.ok(!r.events.some(e => e.t === 'turn'));
  // 왕실 점수도 포함: 17점 + 왕관 3번째 → R4(3점) = 20
  const t = game();
  t.players[0].cards = ['3N1', '3W1', '3U2', '3G2']; // 17점, 왕관 2
  withCard(t, '1W2', 1, 0); // 파3 → 2
  t.players[0].tokens = toks({ blue: 2 });
  const p1 = act(t, buyPyr(1, 0));
  assert.strictEqual(p1.state.over, null);
  const p2 = act(p1.state, { type: 'royal', id: 'R4' });
  assert.deepStrictEqual(p2.state.over, { winner: 0, reason: 'points' });
  assert.strictEqual(E.stats(p2.state, 0).points, 20);
});

test('victory: 10 crowns', () => {
  const s = game();
  s.players[0].cards = ['3W1', '3U1', '3G1', '3R1', '1W2']; // 왕관 9, 12점
  s.players[0].royals = ['R4', 'R1'];
  s.royals = ['R2', 'R3'];
  withCard(s, '1U2', 1, 0); // 초3 → 초록 보너스 1 → 2
  s.players[0].tokens = toks({ green: 2 });
  const r = act(s, buyPyr(1, 0));
  assert.deepStrictEqual(r.state.over, { winner: 0, reason: 'crowns' });
  assert.deepStrictEqual(r.events[r.events.length - 1], { t: 'win', p: 0, reason: 'crowns', turnNo: 1 });
});

test('victory: 10 points in one colour; no-bonus cards and royals count for no colour', () => {
  const s = game();
  s.players[0].cards = ['3W1', '3W2', '2W1']; // 흰 9점
  withCard(s, '1W5', 1, 0); // 흰 1점: 초2 빨3
  withCard(s, '1N1', 1, 1); // 보너스 없음 3점: 빨4 진1
  s.players[0].tokens = toks({ green: 2, red: 4, pearl: 1 });
  let r = act(s, buyPyr(1, 0));
  assert.deepStrictEqual(r.state.over, { winner: 0, reason: 'color', color: 'white' });
  r = act(s, buyPyr(1, 1));
  assert.strictEqual(r.state.over, null);
  const st = E.stats(r.state, 0);
  assert.strictEqual(st.colorPoints.white, 9);
  assert.strictEqual(st.points, 12);
  for (const k of ['points', 'crowns', 'colorPoints', 'bonuses', 'tokenCount', 'tokens', 'privileges']) assert.ok(k in st, k);
  // 왕실 점수는 색 점수가 아님
  s.players[0].royals = ['R4'];
  assert.deepStrictEqual(E.stats(s, 0).colorPoints, { white: 9, blue: 0, green: 0, red: 0, black: 0 });
  assert.strictEqual(E.stats(s, 0).points, 12);
});

test('victory is checked only at end of turn, after pending decisions and discards', () => {
  const s = game();
  s.board = board('white', { 0: 'blue', 1: 'blue', 2: 'blue' });
  s.players[0].cards = ['3N1', '3W1', '3U2', '3G2', '1W5']; // 18점, 왕관 2, 파랑 보너스 1
  s.players[0].tokens = toks({ white: 8, blue: 2 });      // 10개
  s.players[0].privileges = 3; s.players[1].privileges = 0; s.privilegeSupply = 0;
  s.players[1].tokens = toks({ red: 2 });
  withCard(s, '1W2', 1, 0); // 파3 → 2, 왕관 1
  let st = s;
  for (const c of [5, 6, 7]) st = act(st, { type: 'usePrivilege', cell: c }).state; // 13개
  let r = act(st, buyPyr(1, 0)); // 파2 지불 → 11개, 왕관 3
  assert.deepStrictEqual(r.state.pending, [{ kind: 'royal' }]);
  r = act(r.state, { type: 'royal', id: 'R1' }); // 2점 → 20점, 훔치기
  assert.strictEqual(r.state.over, null);
  r = act(r.state, { type: 'steal', token: 'red' }); // 12개
  assert.strictEqual(r.state.over, null);
  assert.deepStrictEqual(r.state.pending, [{ kind: 'discard', count: 2 }]);
  assert.strictEqual(E.stats(r.state, 0).points, 20);
  r = act(r.state, { type: 'discard', tokens: { white: 2 } });
  assert.deepStrictEqual(r.state.over, { winner: 0, reason: 'points' });
  assert.deepStrictEqual(r.events.map(e => e.t), ['discard', 'win']);
});

test('victory checks only the active player; a turn that earned an extra turn still ends in a win', () => {
  const s = game();
  s.players[1].cards = ['3N1', '3W2', '3U2', '3G2', '2W1']; // 상대가 20점이어도 내 턴에는 확인 안 함
  s.board = board('red');
  let r = act(s, { type: 'take', cells: [0] });
  assert.strictEqual(r.state.over, null);
  const t = game();
  t.players[0].cards = ['3N1', '3W2', '3U2', '3G2', '1W5', '1K5']; // 20점
  withCard(t, '1W3', 1, 0); // 한 턴 더
  t.players[0].tokens = toks({ blue: 1, green: 2, pearl: 1 });
  r = act(t, buyPyr(1, 0));
  assert.deepStrictEqual(r.state.over, { winner: 0, reason: 'points' });
  assert.ok(r.events.some(e => e.t === 'extraTurn'));
  assert.ok(!r.events.some(e => e.t === 'turn'));
});

// ── 강제 채우기 / 넘기기 ──
test('no main action possible: only replenish is offered; after it, main actions', () => {
  const s = game();
  s.board = board(null);
  s.bag = toks({ red: 2, gold: 1 });
  assert.strictEqual(E.mainActionPossible(s), false);
  assert.deepStrictEqual(E.legalActions(s), [{ type: 'replenish' }]);
  rej(s, { type: 'pass' }, /보드를 채워야/);
  rej(s, { type: 'take', cells: [12] });
  const r = act(s, { type: 'replenish' });
  assert.strictEqual(r.state.players[1].privileges, 2);
  assert.strictEqual(E.mainActionPossible(r.state), true);
  const types = new Set(E.legalActions(r.state).map(a => a.type));
  assert.deepStrictEqual([...types].sort(), ['reserve', 'take']);
  // 금만 있고 예약 3장이면 행동 불가
  const t = game();
  t.board = board(null, { 4: 'gold' });
  t.bag = toks({ white: 1 });
  t.players[0].reserved = [{ id: '3W1', fromDeck: true }, { id: '3U1', fromDeck: true }, { id: '3G1', fromDeck: true }];
  assert.deepStrictEqual(E.legalActions(t), [{ type: 'replenish' }]);
  t.players[0].reserved.pop();
  assert.strictEqual(E.mainActionPossible(t), true);
  // 살 수 있는 카드가 있으면 행동 가능
  const u = game();
  u.board = board(null);
  u.bag = toks({ white: 1 });
  u.players[0].reserved = [{ id: '1K1', fromDeck: true }];
  u.players[0].tokens = toks({ gold: 4 });
  assert.strictEqual(E.mainActionPossible(u), true);
  assert.deepStrictEqual([...new Set(E.legalActions(u).map(a => a.type))].sort(), ['buy', 'replenish']);
});

test('pass: only when no main action is possible and the bag is empty', () => {
  const s = game();
  rej(s, { type: 'pass' }, /넘길 수 없어요/);
  s.board = board(null);
  s.bag = toks({});
  assert.deepStrictEqual(E.legalActions(s), [{ type: 'pass' }]);
  const r = act(s, { type: 'pass' });
  assert.strictEqual(r.state.turn.player, 1);
  assert.deepStrictEqual(r.events.map(e => e.t), ['pass', 'turn']);
});

// ── 기권 / 턴 / 로그 ──
test('resign: either player, any time (even during pending decisions)', () => {
  const s = game();
  let r = act(s, { type: 'resign', player: 1 });
  assert.deepStrictEqual(r.state.over, { winner: 0, reason: 'resign' });
  assert.deepStrictEqual(r.events.map(e => [e.t, e.p]), [['resign', 1], ['win', 0]]);
  r = act(s, { type: 'resign', player: 0 });
  assert.deepStrictEqual(r.state.over, { winner: 1, reason: 'resign' });
  rej(s, { type: 'resign', player: 2 });
  const t = game();
  t.players[0].cards = ['1W2', '1U2'];
  withCard(t, '1G2', 1, 0);
  t.players[0].tokens = toks({ red: 3 });
  const pend = act(t, buyPyr(1, 0)).state;
  r = act(pend, { type: 'resign', player: 1 });
  assert.strictEqual(r.state.over.winner, 0);
  assert.deepStrictEqual(E.legalActions(r.state), []);
  assert.ok(!E.legalActions(s).some(a => a.type === 'resign'));
});

test('turn advance: opponent next, number +1, flags reset; events carry details', () => {
  const s = game({ first: 1 });
  s.board = board('green');
  const r = act(s, { type: 'take', cells: [1, 0] });
  assert.deepStrictEqual(r.state.turn, { player: 0, number: 2, replenished: false, mainDone: false, extraTurn: false });
  assert.deepStrictEqual(r.events, [
    { t: 'take', p: 1, cells: [0, 1], tokens: ['green', 'green'], penalty: false, turnNo: 1 },
    { t: 'turn', p: 0, number: 2, extra: false, turnNo: 2 }]);
  assert.deepStrictEqual(r.state.log, r.events);
});

test('invalid actions give Korean errors', () => {
  const s = game();
  for (const a of [null, {}, { type: 'fly' }, { type: 'royal', id: 'R1' }, { type: 'discard', tokens: {} }, { type: 'steal', token: 'red' },
    { type: 'bonusToken', cell: 0 }, { type: 'buy' }, { type: 'reserve' }, { type: 'usePrivilege', cell: 0 }]) {
    rej(s, a);
  }
  assert.strictEqual(E.apply(null, { type: 'pass' }).ok, false);
});

test('log keeps the last 60 events', () => {
  let s = game({ seed: 3 });
  const rnd = mulberry(3);
  let total = 0, all = [];
  while (total < 150 && !s.over) {
    const acts = E.legalActions(s);
    const r = act(s, acts[Math.floor(rnd() * acts.length)]);
    total += r.events.length;
    all = all.concat(r.events);
    s = r.state;
  }
  assert.ok(total > 60);
  assert.strictEqual(s.log.length, 60);
  assert.deepStrictEqual(s.log, all.slice(-60));
});

// ── legalActions ──
test('legalActions at game start: takes + reserves only; all apply ok; takes match brute force', () => {
  const s = game({ seed: 21 });
  const acts = E.legalActions(s);
  const byType = {};
  acts.forEach(a => { byType[a.type] = (byType[a.type] || 0) + 1; });
  assert.deepStrictEqual(Object.keys(byType).sort(), ['reserve', 'take']);
  assert.strictEqual(byType.reserve, 3 * 15);
  assert.strictEqual(acts.filter(a => a.type === 'take' && a.cells.length === 1).length, 22);
  assert.strictEqual(new Set(acts.map(a => JSON.stringify(a))).size, acts.length);
  acts.forEach(a => act(s, a));
  const brute = new Set();
  for (let i = 0; i < 25; i++) {
    if (E.validateTake(s, [i]).ok) brute.add(JSON.stringify([i]));
    for (let j = i + 1; j < 25; j++) {
      if (E.validateTake(s, [i, j]).ok) brute.add(JSON.stringify([i, j]));
      for (let k = j + 1; k < 25; k++) if (E.validateTake(s, [i, j, k]).ok) brute.add(JSON.stringify([i, j, k]));
    }
  }
  const listed = new Set(acts.filter(a => a.type === 'take').map(a => JSON.stringify([...a.cells].sort((x, y) => x - y))));
  assert.deepStrictEqual([...listed].sort(), [...brute].sort());
});

test('legalActions: privileges listed per gem/pearl cell; buy uses the default payment', () => {
  const s = game({ first: 1 });
  s.turn.player = 0; // 0번은 후공이라 특권 1
  s.board = board('blue', { 0: 'gold', 1: null });
  assert.strictEqual(E.legalActions(s).filter(a => a.type === 'usePrivilege').length, 23);
  withCard(s, '1W1', 1, 0);
  s.players[0].tokens = toks({ blue: 1, green: 1, red: 1, gold: 2 });
  const buy = E.legalActions(s).find(a => a.type === 'buy' && a.source.level === 1 && a.source.slot === 0);
  assert.deepStrictEqual(buy.payment, toks({ blue: 1, green: 1, red: 1, gold: 1 }));
});

test('legalActions is fast (< 5 ms on average)', () => {
  let s = game({ seed: 77 });
  const rnd = mulberry(77);
  let t = 0, n = 0;
  for (let i = 0; i < 300 && !s.over; i++) {
    const t0 = performance.now();
    const acts = E.legalActions(s);
    t += performance.now() - t0; n++;
    const buys = acts.filter(a => a.type === 'buy');
    const a = buys.length && rnd() < 0.5 ? buys[0] : acts[Math.floor(rnd() * acts.length)];
    s = act(s, a).state;
  }
  assert.ok(t / n < 5, 'avg ms ' + (t / n));
});
