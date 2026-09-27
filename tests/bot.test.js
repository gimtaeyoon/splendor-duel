// 연습 봇 테스트: 시드 고정 대국(보통 vs 쉬움, 보통 vs 보통), 대기 결정/강제 행동 상황, 시간 (node --test)
// 대국은 worker_threads로 나눠 돌립니다 (같은 파일을 워커로 다시 불러옴).
'use strict';
const { isMainThread, Worker, workerData, parentPort } = require('node:worker_threads');
const os = require('node:os');
const E = require('../js/engine.js');
const B = require('../js/bot.js');

const { TOKENS } = E.CONSTANTS;
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
const sumT = t => TOKENS.reduce((n, k) => n + (t[k] || 0), 0);
const emptyTok = () => ({ white: 0, blue: 0, green: 0, red: 0, black: 0, pearl: 0, gold: 0 });

// 한 판: levels[seat] 로 대국. 봇이 고른 행동은 모두 apply가 받아야 함.
// opts.keepStates: 보통 봇이 결정한 국면을 모아 둠 (시간 테스트에서 다시 돌려 봄. 엔진·봇은 state 를 바꾸지 않음)
function playGame(seed, levels, opts = {}) {
  const rnd = mulberry(seed * 2654435761);
  let s = E.newGame({ names: ['P0', 'P1'], first: seed % 2, seed });
  let actions = 0;
  const times = [];
  const states = [];
  while (!s.over && actions < ACTION_CAP) {
    const level = levels[s.turn.player];
    const before = opts.checkPure && actions % 7 === 0 ? JSON.stringify(s) : null;
    const t0 = process.hrtime.bigint();
    const a = B.chooseAction(s, { level, rng: rnd });
    const dt = Number(process.hrtime.bigint() - t0) / 1e6;
    if (level === 'normal') { times.push(dt); if (opts.keepStates) states.push(s); }
    if (before !== null && JSON.stringify(s) !== before) return { err: 'chooseAction mutated the state (action ' + actions + ')' };
    if (!a) return { err: 'no action returned (action ' + actions + ')' };
    const r = E.apply(s, a);
    if (!r.ok) return { err: 'bot action rejected: ' + JSON.stringify(a) + ' -> ' + r.error };
    s = r.state;
    actions++;
  }
  return {
    reason: s.over ? s.over.reason : 'cap',
    winner: s.over ? s.over.winner : null,
    actions, turns: s.turn.number, times, states
  };
}

// seat 배치를 번갈아 가며 A(levels[0]) vs B(levels[1])
function runChunk(seeds, levels) {
  const out = { games: 0, reasons: {}, errors: [], actions: 0, turns: 0, winsA: 0, winsB: 0, fallbacks: 0, lastError: null, nTimes: 0, sumTime: 0, maxTime: 0 };
  for (const seed of seeds) {
    const swap = seed % 4 >= 2; // first player과 좌석 조합을 섞기
    const seatLevels = swap ? [levels[1], levels[0]] : [levels[0], levels[1]];
    const g = playGame(seed, seatLevels, { checkPure: true });
    out.games++;
    if (g.err) { out.errors.push('seed ' + seed + ': ' + g.err); continue; }
    out.reasons[g.reason] = (out.reasons[g.reason] || 0) + 1;
    out.actions += g.actions; out.turns += g.turns;
    if (g.winner !== null) {
      const aSeat = swap ? 1 : 0;
      if (g.winner === aSeat) out.winsA++; else out.winsB++;
    }
    for (const t of g.times) { out.nTimes++; out.sumTime += t; if (t > out.maxTime) out.maxTime = t; }
  }
  out.fallbacks = B._debug.fallbacks;
  out.lastError = B._debug.lastError ? String(B._debug.lastError.stack || B._debug.lastError) : null;
  return out;
}

if (!isMainThread) {
  parentPort.postMessage(runChunk(workerData.seeds, workerData.levels));
} else {
  const test = require('node:test');
  const assert = require('node:assert');

  function runParallel(seeds, levels) {
    const n = Math.max(1, Math.min(8, (os.availableParallelism ? os.availableParallelism() : os.cpus().length) - 1));
    const chunks = Array.from({ length: n }, () => []);
    seeds.forEach((s, i) => chunks[i % n].push(s));
    return Promise.all(chunks.filter(c => c.length).map(c => new Promise((resolve, reject) => {
      const w = new Worker(__filename, { workerData: { seeds: c, levels } });
      w.once('message', resolve);
      w.once('error', reject);
    }))).then(parts => parts.reduce((acc, p) => {
      for (const k of ['games', 'actions', 'turns', 'winsA', 'winsB', 'fallbacks', 'nTimes', 'sumTime']) acc[k] += p[k];
      acc.maxTime = Math.max(acc.maxTime, p.maxTime);
      acc.errors.push(...p.errors);
      if (p.lastError) acc.lastErrors.push(p.lastError);
      Object.keys(p.reasons).forEach(k => { acc.reasons[k] = (acc.reasons[k] || 0) + p.reasons[k]; });
      return acc;
    }, { games: 0, reasons: {}, errors: [], lastErrors: [], actions: 0, turns: 0, winsA: 0, winsB: 0, fallbacks: 0, nTimes: 0, sumTime: 0, maxTime: 0 }));
  }

  function report(t, label, r) {
    const line = label + ': ' + r.games + ' games, A wins ' + r.winsA + ' (' + (100 * r.winsA / r.games).toFixed(1) + '%), B wins ' + r.winsB +
      ', end reasons ' + JSON.stringify(r.reasons) +
      ', avg ' + (r.actions / Math.max(1, r.games)).toFixed(1) + ' actions / ' + (r.turns / Math.max(1, r.games)).toFixed(1) + ' turns per game' +
      ', normal decision avg ' + (r.sumTime / Math.max(1, r.nTimes)).toFixed(2) + ' ms (max ' + r.maxTime.toFixed(1) + ' ms, parallel load)';
    t.diagnostic(line);
    console.log(line);
  }

  function assertCleanRun(r, n) {
    assert.deepStrictEqual(r.errors.slice(0, 10), []);
    assert.strictEqual(r.games, n);
    assert.strictEqual(r.reasons.cap || 0, 0, 'games hit the ' + ACTION_CAP + '-action cap');
    assert.strictEqual(r.reasons.resign || 0, 0);
    assert.strictEqual(r.winsA + r.winsB, n, 'every game ends with a winner');
    assert.strictEqual(r.fallbacks, 0, 'bot needed its safety fallback: ' + r.lastErrors.join('\n'));
    assert.deepStrictEqual(r.lastErrors, []);
  }

  test('300 seeded games: normal vs easy (normal wins >= 70%)', async (t) => {
    const seeds = Array.from({ length: 300 }, (_, i) => 1 + i);
    const r = await runParallel(seeds, ['normal', 'easy']);
    report(t, 'normal(A) vs easy(B)', r);
    assertCleanRun(r, 300);
    assert.ok(r.winsA >= 0.7 * r.games, 'normal won only ' + r.winsA + ' / ' + r.games);
  });

  test('100 seeded games: normal vs normal', async (t) => {
    const seeds = Array.from({ length: 100 }, (_, i) => 5000 + i);
    const r = await runParallel(seeds, ['normal', 'normal']);
    report(t, 'normal(A) vs normal(B)', r);
    assertCleanRun(r, 100);
  });

  // ── 만든 상황들 ──
  // 기본 국면에서 필요한 부분만 바꿔 씀 (JSON 복제본)
  function base(seed = 42) { return JSON.parse(JSON.stringify(E.newGame({ names: ['A', 'B'], first: 0, seed }))); }
  function removeCard(s, id) {
    for (const l of [1, 2, 3]) {
      s.decks[l] = s.decks[l].filter(x => x !== id);
      s.pyramid[l] = s.pyramid[l].map(x => (x === id ? null : x));
    }
  }
  // 카드를 피라미드 level 슬롯 0에 놓기 (원래 카드는 더미로)
  function putInPyramid(s, id) {
    const l = E.cardById(id).level;
    removeCard(s, id);
    const old = s.pyramid[l][0];
    if (old) s.decks[l].unshift(old);
    s.pyramid[l][0] = id;
    for (let k = 0; k < s.pyramid[l].length; k++) if (s.pyramid[l][k] === null) s.pyramid[l][k] = s.decks[l].pop();
  }
  function giveCards(s, p, ids) {
    for (const id of ids) {
      removeCard(s, id);
      s.players[p].cards.push(id);
    }
    for (const l of [1, 2, 3]) for (let k = 0; k < s.pyramid[l].length; k++) if (s.pyramid[l][k] === null) s.pyramid[l][k] = s.decks[l].pop();
  }
  // 보드에서 토큰을 치워 주머니로 (토큰 보존 유지)
  function clearBoard(s, keep = () => false) {
    for (let i = 0; i < 25; i++) {
      const t = s.board[i];
      if (t && !keep(t, i)) { s.board[i] = null; s.bag[t]++; }
    }
  }
  // 주머니/보드에서 토큰을 옮겨 플레이어에게
  function giveTokens(s, p, tok) {
    for (const k of Object.keys(tok)) {
      for (let n = 0; n < tok[k]; n++) {
        if (s.bag[k] > 0) s.bag[k]--;
        else { const i = s.board.indexOf(k); assert.ok(i >= 0, 'no ' + k + ' token left to give'); s.board[i] = null; }
        s.players[p].tokens[k]++;
      }
    }
  }
  const LEVELS = ['easy', 'normal'];
  function choose(s, level, seed = 7) {
    const before = JSON.stringify(s);
    const a = B.chooseAction(s, { level, rng: mulberry(seed) });
    assert.strictEqual(JSON.stringify(s), before, 'state must not be mutated');
    assert.ok(a, 'an action is returned');
    const r = E.apply(s, a);
    assert.ok(r.ok, level + ' action rejected: ' + JSON.stringify(a) + ' -> ' + r.error);
    return { a, r };
  }

  test('pending bonusToken: takes a token of that color', () => {
    const s = base();
    s.turn.mainDone = true;
    s.pending = [{ kind: 'bonusToken', color: 'red' }];
    for (const level of LEVELS) {
      const { a } = choose(s, level);
      assert.strictEqual(a.type, 'bonusToken');
      assert.strictEqual(s.board[a.cell], 'red');
    }
  });

  test('pending steal: steals a gem or pearl the opponent holds, never gold', () => {
    const s = base();
    giveTokens(s, 1, { gold: 2, red: 1, pearl: 1 });
    s.turn.mainDone = true;
    s.pending = [{ kind: 'steal' }];
    for (const level of LEVELS) {
      for (let seed = 1; seed <= 5; seed++) {
        const { a } = choose(s, level, seed);
        assert.strictEqual(a.type, 'steal');
        assert.ok(a.token === 'red' || a.token === 'pearl', 'stole ' + a.token);
      }
    }
  });

  test('pending royal: picks an available royal; a royal steal chains into a steal decision', () => {
    const s = base();
    s.royals = ['R1', 'R4'];
    s.turn.mainDone = true;
    s.pending = [{ kind: 'royal' }];
    giveTokens(s, 1, { blue: 2 });
    for (const level of LEVELS) {
      const { a } = choose(s, level);
      assert.strictEqual(a.type, 'royal');
      assert.ok(s.royals.includes(a.id));
    }
    // R1(빼앗기)만 남은 경우 → 다음은 steal
    const s2 = JSON.parse(JSON.stringify(s));
    s2.royals = ['R1'];
    for (const level of LEVELS) {
      const { r } = choose(s2, level);
      assert.deepStrictEqual(r.state.pending, [{ kind: 'steal' }]);
      const { a } = choose(r.state, level);
      assert.deepStrictEqual(a, { type: 'steal', token: 'blue' });
    }
  });

  test('pending discard: returns exactly the excess and keeps gold when possible', () => {
    const s = base();
    giveTokens(s, 0, { white: 3, blue: 3, green: 2, red: 1, pearl: 1, gold: 2 }); // 12개
    s.turn.mainDone = true;
    s.pending = [{ kind: 'discard', count: 2 }];
    for (const level of LEVELS) {
      const { a, r } = choose(s, level);
      assert.strictEqual(a.type, 'discard');
      assert.strictEqual(sumT(a.tokens), 2);
      assert.strictEqual(a.tokens.gold || 0, 0, level + ' discarded gold');
      assert.strictEqual(sumT(r.state.players[0].tokens), 10);
      assert.strictEqual(r.state.turn.player, 1, 'turn passes after the discard');
    }
  });

  test('forced replenish: no gem/pearl/gold on the board and nothing affordable', () => {
    const s = base();
    clearBoard(s);
    assert.deepStrictEqual(E.legalActions(s), [{ type: 'replenish' }]);
    for (const level of LEVELS) {
      const { a, r } = choose(s, level);
      assert.deepStrictEqual(a, { type: 'replenish' });
      assert.ok(r.state.turn.replenished);
      // 이어서 주 행동도 고를 수 있어야 함
      const next = choose(r.state, level);
      assert.ok(['take', 'reserve', 'buy'].includes(next.a.type), 'main action after replenish: ' + next.a.type);
    }
  });

  test('forced pass: empty board, empty bag, nothing affordable', () => {
    const s = base();
    // 모든 토큰을 상대에게 (규칙상 드문 구석 상황이지만 엔진은 pass만 허용)
    for (let i = 0; i < 25; i++) { const t = s.board[i]; if (t) { s.players[1].tokens[t]++; s.board[i] = null; } }
    s.turn.replenished = true;
    assert.deepStrictEqual(E.legalActions(s), [{ type: 'pass' }]);
    for (const level of LEVELS) {
      const { a } = choose(s, level);
      assert.deepStrictEqual(a, { type: 'pass' });
    }
  });

  test('game over: returns null', () => {
    const s = base();
    const r = E.apply(s, { type: 'resign', player: 1 });
    assert.strictEqual(B.chooseAction(r.state, { level: 'normal' }), null);
    assert.strictEqual(B.chooseAction(r.state, { level: 'easy' }), null);
  });

  // 17점(흰·초록·빨강·검정 4점씩 + 파랑 1점) 가진 플레이어 + 피라미드의 5점 카드 2N1 (파랑 6 + 진주 1)
  // 파랑 보너스가 2라서 파랑 4 + 진주 1이면 살 수 있고, 사면 22점으로 승리
  function nearWin(p) {
    const s = base(99);
    giveCards(s, p, ['3W2', '3G2', '3R2', '3K2', '2U4']);
    putInPyramid(s, '2N1');
    s.turn.player = p;
    return s;
  }

  test('normal takes an immediate win', () => {
    const s = nearWin(0);
    giveTokens(s, 0, { blue: 4, pearl: 1 });
    for (let seed = 1; seed <= 3; seed++) {
      const { r } = choose(s, 'normal', seed);
      assert.ok(r.state.over && r.state.over.winner === 0, 'normal should win at once');
    }
  });

  test('normal uses a privilege when it enables a winning purchase', () => {
    const s = nearWin(0);
    giveTokens(s, 0, { blue: 4 });
    s.players[0].privileges = 1; s.players[1].privileges = 0; s.privilegeSupply = 2;
    // 보드에 진주가 있어야 함
    if (!s.board.includes('pearl')) { const i = s.board.indexOf('white'); s.board[i] = 'pearl'; s.bag.pearl--; s.bag.white++; }
    const { a, r } = choose(s, 'normal');
    assert.strictEqual(a.type, 'usePrivilege');
    assert.strictEqual(s.board[a.cell], 'pearl');
    const next = choose(r.state, 'normal');
    assert.ok(next.r.state.over && next.r.state.over.winner === 0, 'then buys and wins');
  });

  test('normal blocks the opponent\'s only winning card', () => {
    const s = nearWin(1);
    giveTokens(s, 1, { blue: 4, pearl: 1 });
    s.turn.player = 0;
    // 확인: 상대는 2N1로만 바로 이길 수 있음
    const oppView = JSON.parse(JSON.stringify(s)); oppView.turn.player = 1;
    const wins = E.legalActions(oppView).filter(a => a.type === 'buy' && E.apply(oppView, a).state.over);
    assert.ok(wins.length >= 1 && wins.every(a => a.source.from === 'pyramid' && oppView.pyramid[a.source.level][a.source.slot] === '2N1'));
    assert.ok(s.board.includes('gold'), 'gold on board so reserving is possible');
    for (let seed = 1; seed <= 3; seed++) {
      let { r } = choose(s, 'normal', seed);
      let st = r.state, guard = 0;
      while (!st.over && st.turn.player === 0 && guard++ < 6) st = choose(st, 'normal', seed).r.state;
      assert.ok(!st.over, 'game should not be over');
      assert.ok(!st.pyramid[2].includes('2N1'), 'the winning card must be taken away from the opponent');
    }
  });

  test('normal buys an affordable high-value card over taking tokens', () => {
    const s = base(5);
    giveCards(s, 0, ['1W1', '1U1']);
    putInPyramid(s, '3N1'); // 6점, 흰색 8 → 흰 보너스 1이라 7개
    giveTokens(s, 0, { white: 4, gold: 3 });
    const { a } = choose(s, 'normal');
    assert.strictEqual(a.type, 'buy');
    assert.strictEqual(s.pyramid[3][a.source.slot], '3N1');
  });

  test('easy buys when it can most of the time and never returns an illegal action', () => {
    let bought = 0, chances = 0;
    for (let seed = 1; seed <= 60; seed++) {
      const s = base(seed);
      giveTokens(s, 0, { white: 2, blue: 2, green: 2, red: 2, black: 2 });
      const canBuy = E.legalActions(s).some(a => a.type === 'buy');
      const { a } = choose(s, 'easy', seed);
      if (!canBuy) { assert.notStrictEqual(a.type, 'buy'); continue; }
      chances++;
      if (a.type === 'buy') bought++;
    }
    assert.ok(chances >= 20, 'test setup: too few buy chances (' + chances + ')');
    assert.ok(bought >= 0.8 * chances, 'easy bought only ' + bought + ' / ' + chances + ' times');
  });

  // ── 시간 ──
  // 벽시계가 아니라 이 스레드의 CPU 시간으로 잽니다. 다른 테스트 파일·프로그램이 CPU 를 나눠 쓰면 벽시계는
  // 몇 배로 늘어나지만(기다린 시간까지 들어감) CPU 시간은 거의 그대로예요.
  // Windows 는 CPU 시간이 약 16 ms 단위로만 올라가므로 결정 하나씩이 아니라 수백 번을 한꺼번에 잽니다.
  const threadCpuMs = () => {
    const u = typeof process.threadCpuUsage === 'function' ? process.threadCpuUsage() : process.cpuUsage();
    return (u.user + u.system) / 1000;
  };
  let calibSink = 0;
  // 기준 작업 한 덩어리: 봇과 비슷한 일(작은 객체 만들기, JSON 복제, 정렬, 정수 계산). 이 PC 에서 ≈ 1.7 ms
  function calibChunk() {
    let h = 0;
    for (let r = 0; r < 100; r++) {
      const o = [];
      for (let i = 0; i < 40; i++) o.push({ i, t: { white: i & 3, blue: (i >> 2) & 3, gold: (i + r) % 5 }, k: 'c' + (i % 7) });
      const c = JSON.parse(JSON.stringify(o));
      for (const x of c) h = (h * 31 + x.t.white + x.t.blue * 3 + x.t.gold * 7 + x.k.length) | 0;
      c.sort((a, b) => (a.t.gold - b.t.gold) || (b.i - a.i));
      h ^= c[0].i;
    }
    return h;
  }
  // 기준 덩어리 하나의 CPU 시간 (ms). 먼저 몇 번 돌려 JIT 를 데운 뒤 잼
  function calibrate(chunks) {
    for (let k = 0; k < 5; k++) calibSink ^= calibChunk();
    const c0 = threadCpuMs();
    for (let k = 0; k < chunks; k++) calibSink ^= calibChunk();
    return (threadCpuMs() - c0) / chunks;
  }

  test('timing: normal decisions stay fast (CPU time, calibrated in the same run)', (t) => {
    // 이 PC(Ryzen 5 7500F, Node 24) 기준: 평균 ≈ 1.9 ms, 기준 덩어리 ≈ 1.7 ms(비율 ≈ 1.1), 가장 느린 국면 ≈ 5–7 ms.
    // 상한들은 모두 지금 값의 10배보다 낮아서, 봇이 10배 느려지면 부하와 상관없이 실패해요 (비율은 5배부터).
    // 무거운 병렬 부하(논리 CPU 12개에 바쁜 프로세스 36개)에서도 CPU 평균 ≈ 2.7 ms, 비율 ≈ 1.1 이었어요.
    const HARD_AVG_MS = 12; // 평균 결정 CPU 시간의 절대 상한 (예전 벽시계 기준 40 ms 보다 엄격)
    const MAX_RATIO = 5; // 평균 결정 / 기준 덩어리 — 느린 PC 에서도 같은 잣대
    const HARD_WORST_MS = 40; // 가장 느렸던 국면들을 다시 돌렸을 때의 CPU 시간 상한 (예전 벽시계 기준 150 ms)
    const calBefore = calibrate(120);
    const times = [];
    const states = [];
    const cpu0 = threadCpuMs();
    const wall0 = process.hrtime.bigint();
    for (let g = 0; g < 12; g++) {
      const r = playGame(900 + g, ['normal', 'normal'], { keepStates: true });
      assert.ok(!r.err, r.err);
      times.push(...r.times);
      states.push(...r.states);
    }
    // 대국 전체의 CPU 시간 (apply 도 들어가지만 결정에 비하면 아주 작음 → 약간 보수적)
    const cpuMs = threadCpuMs() - cpu0;
    const wallMs = Number(process.hrtime.bigint() - wall0) / 1e6;
    const calAfter = calibrate(120);
    const cal = (calBefore + calAfter) / 2;
    const n = times.length;
    assert.ok(n > 200, 'too few normal decisions measured: ' + n);
    const avg = cpuMs / n;
    const ratio = avg / Math.max(cal, 1e-3);

    // 가장 오래 걸린(벽시계) 국면 3개를 다시 돌려 CPU 시간으로 잼. 부하 때문에 고른 국면이 진짜 가장 느린 게
    // 아닐 수는 있어도(검사가 약해질 뿐), CPU 시간이라 부하로 실패하지는 않아요.
    const slowest = times.map((ms, i) => [ms, i]).sort((a, b) => b[0] - a[0]).slice(0, 3).map((x) => x[1]);
    let worst = 0;
    for (const i of slowest) {
      let reps = 0;
      const c0 = threadCpuMs();
      let spent = 0;
      do {
        const a = B.chooseAction(states[i], { level: 'normal', rng: mulberry(1000 + reps) });
        assert.ok(a, 'no action on replay');
        reps++;
        spent = threadCpuMs() - c0;
      } while (spent < 80 && reps < 60);
      worst = Math.max(worst, spent / reps);
    }

    const sorted = times.slice().sort((a, b) => a - b);
    const line = 'normal decisions: ' + n + ', CPU avg ' + avg.toFixed(2) + ' ms (cap ' + HARD_AVG_MS + '), calibration chunk ' + cal.toFixed(2) +
      ' ms (before ' + calBefore.toFixed(2) + ', after ' + calAfter.toFixed(2) + ') -> ratio ' + ratio.toFixed(2) + ' (cap ' + MAX_RATIO + ')' +
      ', slowest replayed ' + worst.toFixed(1) + ' ms CPU (cap ' + HARD_WORST_MS + ')' +
      '; wall avg ' + (wallMs / n).toFixed(2) + ' ms, p95 ' + sorted[Math.floor(n * 0.95)].toFixed(1) + ' ms, max ' + sorted[n - 1].toFixed(1) +
      ' ms, wall/CPU ' + (wallMs / Math.max(cpuMs, 1)).toFixed(2);
    t.diagnostic(line);
    console.log(line);
    assert.ok(avg < HARD_AVG_MS, 'average CPU time per normal decision too high: ' + line);
    assert.ok(ratio < MAX_RATIO, 'normal decisions too slow relative to the calibration loop: ' + line);
    assert.ok(worst < HARD_WORST_MS, 'slowest normal decisions too slow: ' + line);
  });
}
