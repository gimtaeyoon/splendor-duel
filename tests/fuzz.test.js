// 규칙 엔진 퍼즈 테스트: 시드 고정 무작위 대국 수천 판, 매 행동마다 불변식 확인 (node --test)
// 속도를 위해 worker_threads로 나눠 돌립니다 (같은 파일을 워커로 다시 불러옴).
'use strict';
const { isMainThread, Worker, workerData, parentPort } = require('node:worker_threads');
const os = require('node:os');
const E = require('../js/engine.js');
const { CARDS, ROYALS } = require('../js/cards.js');

const { COLORS, TOKENS, PYRAMID_SIZES } = E.CONSTANTS;
const TOTAL = { white: 4, blue: 4, green: 4, red: 4, black: 4, pearl: 2, gold: 3 };
const ALL_CARD_IDS = CARDS.map(c => c.id).sort();
const ALL_ROYAL_IDS = ROYALS.map(r => r.id).sort();
const ACTION_CAP = 600;

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
const sumT = t => TOKENS.reduce((n, k) => n + t[k], 0);

// 불변식 검사: 문제가 있으면 문자열 반환
function checkInvariants(s) {
  if (s.turn.player !== 0 && s.turn.player !== 1) return 'bad turn player';
  if (!Array.isArray(s.board) || s.board.length !== 25) return 'bad board';
  // 토큰 보존
  const cnt = {};
  TOKENS.forEach(k => { cnt[k] = s.bag[k] + s.players[0].tokens[k] + s.players[1].tokens[k]; });
  for (const t of s.board) {
    if (t === null) continue;
    if (!(t in cnt)) return 'unknown token on board ' + t;
    cnt[t]++;
  }
  for (const k of TOKENS) {
    if (cnt[k] !== TOTAL[k]) return 'token conservation ' + k + ' ' + cnt[k];
    if (!(s.bag[k] >= 0) || !Number.isInteger(s.bag[k])) return 'bad bag count ' + k;
    for (const pl of s.players) if (!(pl.tokens[k] >= 0) || !Number.isInteger(pl.tokens[k])) return 'bad player token ' + k;
  }
  // 특권 보존
  const privs = [s.privilegeSupply, s.players[0].privileges, s.players[1].privileges];
  if (privs.some(n => !(n >= 0) || !Number.isInteger(n))) return 'negative privileges';
  if (privs[0] + privs[1] + privs[2] !== 3) return 'privilege conservation ' + privs;
  // 카드 보존
  const ids = [];
  for (const l of [1, 2, 3]) {
    if (s.pyramid[l].length !== PYRAMID_SIZES[l]) return 'pyramid size ' + l;
    if (s.decks[l].length && s.pyramid[l].some(x => x === null)) return 'empty pyramid slot with non-empty deck ' + l;
    for (const id of s.decks[l]) { if (E.cardById(id).level !== l) return 'deck level ' + id; ids.push(id); }
    for (const id of s.pyramid[l]) if (id !== null) { if (E.cardById(id).level !== l) return 'pyramid level ' + id; ids.push(id); }
  }
  for (const pl of s.players) {
    if (pl.reserved.length > 3) return 'too many reserved';
    pl.cards.forEach(id => ids.push(id));
    pl.reserved.forEach(r => ids.push(r.id));
    // 조커 색 = 가진 조커 카드마다 정확히 하나
    const jokers = pl.cards.filter(id => E.cardById(id).bonus === 'joker').sort();
    if (JSON.stringify(Object.keys(pl.jokerColor).sort()) !== JSON.stringify(jokers)) return 'jokerColor keys';
    for (const id of jokers) if (!COLORS.includes(pl.jokerColor[id])) return 'joker colour';
    if (pl.royals.length > 2) return 'more than 2 royals';
  }
  if (ids.length !== 67 || JSON.stringify(ids.slice().sort()) !== JSON.stringify(ALL_CARD_IDS)) return 'card conservation (' + ids.length + ')';
  const royals = s.royals.concat(s.players[0].royals, s.players[1].royals).sort();
  if (JSON.stringify(royals) !== JSON.stringify(ALL_ROYAL_IDS)) return 'royal conservation';
  if (s.log.length > 60) return 'log too long';
  if (!(s.rng >= 0 && s.rng <= 0xFFFFFFFF && Number.isInteger(s.rng))) return 'bad rng';
  return null;
}

function turnStartCheck(s) {
  if (s.pending.length || s.turn.mainDone || s.turn.replenished) return 'turn does not start clean';
  for (let p = 0; p < 2; p++) {
    const n = sumT(s.players[p].tokens);
    if (n > 10) return 'player ' + p + ' holds ' + n + ' tokens at turn start';
  }
  return null;
}

// 무작위 정책 (구매 쪽으로 치우침)
function randomPick(acts, rnd) {
  const buys = acts.filter(a => a.type === 'buy');
  if (buys.length && rnd() < 0.6) return buys[Math.floor(rnd() * buys.length)];
  return acts[Math.floor(rnd() * acts.length)];
}
// 욕심쟁이 정책: 살 수 있는 가장 높은 점수 카드, 아니면 3개 가져오기
function greedyPick(s, acts, rnd) {
  if (s.pending.length) return acts[Math.floor(rnd() * acts.length)];
  const buys = acts.filter(a => a.type === 'buy');
  if (buys.length) {
    const pts = a => {
      const id = a.source.from === 'pyramid' ? s.pyramid[a.source.level][a.source.slot] : s.players[s.turn.player].reserved[a.source.index].id;
      const c = E.cardById(id);
      return c.points * 10 + c.crowns * 3 + c.bonusCount;
    };
    const best = Math.max(...buys.map(pts));
    const top = buys.filter(a => pts(a) === best);
    return top[Math.floor(rnd() * top.length)];
  }
  const t3 = acts.filter(a => a.type === 'take' && a.cells.length === 3);
  if (t3.length) return t3[Math.floor(rnd() * t3.length)];
  return acts[Math.floor(rnd() * acts.length)];
}

function playGame(seed, mode) {
  const rnd = mulberry(seed ^ 0x9E3779B9);
  let s = E.newGame({ names: ['P0', 'P1'], first: seed % 2, seed });
  const greedySide = mode === 'greedy' ? (seed >> 1) % 2 : -1;
  let err = checkInvariants(s) || turnStartCheck(s);
  if (err) return { err: 'setup: ' + err };
  let actions = 0, checked = 0;
  while (!s.over && actions < ACTION_CAP) {
    const acts = E.legalActions(s);
    if (!acts.length) return { err: 'no legal actions (turn ' + s.turn.number + ')' };
    // 가능한 행동 전부가 실제로 적용되는지 (로그만 비운 상태로 빠르게)
    const lite = Object.assign({}, s, { log: [] });
    for (const a of acts) {
      const r = E.apply(lite, a);
      checked++;
      if (!r.ok) return { err: 'legal action rejected: ' + JSON.stringify(a) + ' -> ' + r.error };
    }
    const main = acts.some(a => a.type === 'take' || a.type === 'reserve' || a.type === 'buy');
    if (!s.pending.length && !s.turn.mainDone && main !== E.mainActionPossible(s)) return { err: 'mainActionPossible mismatch' };
    // 가끔 기권도 섞기
    let a;
    if (rnd() < 0.0005) a = { type: 'resign', player: rnd() < 0.5 ? 0 : 1 };
    else a = s.turn.player === greedySide ? greedyPick(s, acts, rnd) : randomPick(acts, rnd);
    const r = E.apply(s, a);
    if (!r.ok) return { err: 'chosen action rejected: ' + JSON.stringify(a) + ' -> ' + r.error };
    const prev = s;
    s = r.state;
    actions++;
    err = checkInvariants(s);
    if (err) return { err: err + ' after ' + JSON.stringify(a) };
    if (s.turn.number !== prev.turn.number && !s.over) {
      err = turnStartCheck(s);
      if (err) return { err };
      if (!r.events.some(e => e.t === 'turn')) return { err: 'turn changed without a turn event' };
    }
    if (s.turn.number < prev.turn.number) return { err: 'turn number went back' };
    if (actions % 97 === 0) {
      const rt = JSON.parse(JSON.stringify(s));
      if (JSON.stringify(E.legalActions(rt)) !== JSON.stringify(E.legalActions(s))) return { err: 'JSON round-trip changed legal actions' };
    }
  }
  if (s.over) {
    if (E.legalActions(s).length) return { err: 'actions offered after game over' };
    if (E.apply(s, { type: 'pass' }).ok || E.apply(s, { type: 'resign', player: 0 }).ok) return { err: 'apply accepted after game over' };
    const w = s.over.winner;
    if (s.over.reason !== 'resign') {
      const st = E.stats(s, w);
      const okReason = (s.over.reason === 'points' && st.points >= 20) || (s.over.reason === 'crowns' && st.crowns >= 10) ||
        (s.over.reason === 'color' && st.colorPoints[s.over.color] >= 10);
      if (!okReason) return { err: 'win reason not satisfied ' + JSON.stringify(s.over) };
      if (sumT(s.players[w].tokens) > 10) return { err: 'winner holds more than 10 tokens' };
      if (s.pending.length) return { err: 'game over with pending decisions' };
    }
  }
  return {
    reason: s.over ? s.over.reason : 'cap',
    winner: s.over ? s.over.winner : null,
    greedySide,
    actions, checked, turns: s.turn.number
  };
}

function runChunk(seeds, mode) {
  const out = { games: 0, reasons: {}, errors: [], actions: 0, checked: 0, turns: 0, greedyWins: 0, greedyDecided: 0 };
  for (const seed of seeds) {
    const g = playGame(seed, mode);
    out.games++;
    if (g.err) { out.errors.push('seed ' + seed + ': ' + g.err); continue; }
    out.reasons[g.reason] = (out.reasons[g.reason] || 0) + 1;
    out.actions += g.actions; out.checked += g.checked; out.turns += g.turns;
    if (mode === 'greedy' && g.winner !== null && g.reason !== 'resign') {
      out.greedyDecided++;
      if (g.winner === g.greedySide) out.greedyWins++;
    }
  }
  return out;
}

if (!isMainThread) {
  parentPort.postMessage(runChunk(workerData.seeds, workerData.mode));
} else {
  const test = require('node:test');
  const assert = require('node:assert');

  function runParallel(seeds, mode) {
    const n = Math.max(1, Math.min(8, (os.availableParallelism ? os.availableParallelism() : os.cpus().length) - 1));
    const chunks = Array.from({ length: n }, () => []);
    seeds.forEach((s, i) => chunks[i % n].push(s));
    return Promise.all(chunks.filter(c => c.length).map(c => new Promise((resolve, reject) => {
      const w = new Worker(__filename, { workerData: { seeds: c, mode } });
      w.once('message', resolve);
      w.once('error', reject);
    }))).then(parts => parts.reduce((acc, p) => {
      acc.games += p.games; acc.actions += p.actions; acc.checked += p.checked; acc.turns += p.turns;
      acc.greedyWins += p.greedyWins; acc.greedyDecided += p.greedyDecided;
      acc.errors.push(...p.errors);
      Object.keys(p.reasons).forEach(k => { acc.reasons[k] = (acc.reasons[k] || 0) + p.reasons[k]; });
      return acc;
    }, { games: 0, reasons: {}, errors: [], actions: 0, checked: 0, turns: 0, greedyWins: 0, greedyDecided: 0 }));
  }

  function report(t, label, r) {
    const line = label + ': ' + r.games + ' games, end reasons ' + JSON.stringify(r.reasons) +
      ', avg ' + (r.actions / Math.max(1, r.games)).toFixed(1) + ' actions / ' + (r.turns / Math.max(1, r.games)).toFixed(1) + ' turns per game' +
      ', ' + r.checked + ' legal actions applied';
    t.diagnostic(line);
    console.log(line);
  }

  test('fuzz: 3000 seeded random games, invariants after every action', async (t) => {
    const seeds = Array.from({ length: 3000 }, (_, i) => i + 1);
    const r = await runParallel(seeds, 'random');
    report(t, 'random', r);
    assert.deepStrictEqual(r.errors.slice(0, 10), []);
    assert.strictEqual(r.games, 3000);
    const capped = r.reasons.cap || 0;
    assert.ok(capped <= 30, 'too many games hit the ' + ACTION_CAP + '-action cap: ' + capped);
    assert.ok((r.reasons.points || 0) > 0 && (r.reasons.crowns || 0) > 0 && (r.reasons.color || 0) > 0, 'every victory path reached');
  });

  test('fuzz: 200 games greedy vs random', async (t) => {
    const seeds = Array.from({ length: 200 }, (_, i) => 100000 + i);
    const r = await runParallel(seeds, 'greedy');
    report(t, 'greedy', r);
    const g = 'greedy won ' + r.greedyWins + ' / ' + r.greedyDecided;
    t.diagnostic(g);
    console.log(g);
    assert.deepStrictEqual(r.errors.slice(0, 10), []);
    assert.strictEqual(r.games, 200);
    assert.ok((r.reasons.cap || 0) <= 2, 'cap hits: ' + (r.reasons.cap || 0));
    assert.ok(r.greedyWins > r.greedyDecided / 2, 'greedy should beat random: ' + g);
  });
}
