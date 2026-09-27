// 연습 모드 봇 — SDBot.chooseAction(state, { level: 'easy' | 'normal' }) (docs/SPEC.md "Bot")
// state를 절대 바꾸지 않고, 항상 SDEngine.apply가 받아 주는 행동 하나를 돌려줘요.
(function () {
  'use strict';

  var E = (typeof module !== 'undefined' && module.exports) ? require('./engine.js') : window.SDEngine;
  var K = E.CONSTANTS;
  var COLORS = K.COLORS, TOKENS = K.TOKENS;
  var PAY = COLORS.concat(['pearl']); // 비용 항목 (금 제외)
  var MAX_TOKENS = K.MAX_TOKENS;
  var WIN_POINTS = K.WIN_POINTS, WIN_CROWNS = K.WIN_CROWNS, WIN_COLOR = K.WIN_COLOR_POINTS;

  // 디버그용 (테스트가 확인): 안전장치로 다른 행동을 고른 횟수
  var debug = { fallbacks: 0, lastError: null };

  // 시간 측정 (브라우저/Node 공통)
  var now = (typeof performance !== 'undefined' && performance.now) ? function () { return performance.now(); } : function () { return Date.now(); };
  var BUDGET_MS = 60; // 이 시간을 넘기면 추가 탐색(보드 채우기 표본 등)을 생략

  // 평가 가중치 (자기 대국으로 조정)
  var W = {
    tokGem: 0.27, tokPearl: 0.675, tokGold: 0.24, priv: 0.75, over10: 0.36, reserved3: 0.36,
    crown: 0.9, bestCP: 0.21, prog: 2.16, royalNear: 0.216,
    potMove: 0.288, potWait: 0.108, pot2: 0.162, pot3: 0.12, decay: 0.223, resBoost: 0.396,
    bwBase: 1.013, bwDemand: 0.198,
    cvCrown: 1.462, cvRoyal: 1.152, cvColor: 0.029, abExtra: 0.84, abSteal: 0.216, abPriv: 0.216, abBonus: 0.36,
    deckRes: 0.072, winSoon: 0.54, tempo: 0.75,
    repOn: 1, repMargin: 0.18, repGems: 10
  };

  // ── 작은 유틸 ──
  function lite(state) {
    var s = {};
    for (var k in state) if (Object.prototype.hasOwnProperty.call(state, k)) s[k] = state[k];
    s.log = []; // apply가 복제할 양을 줄임 (원본은 건드리지 않음)
    return s;
  }
  function sim(s, a) {
    var r = E.apply(s, a);
    if (!r.ok) return null;
    r.state.log = [];
    return r.state; // 새 복제본이라 마음대로 고쳐도 됨
  }
  function sumT(t) { var n = 0; for (var i = 0; i < TOKENS.length; i++) n += t[TOKENS[i]] || 0; return n; }
  function pick(arr, rnd) { return arr[Math.floor(rnd() * arr.length)]; }
  function weightedPick(items, weight, rnd) {
    var tot = 0, i, w = [];
    for (i = 0; i < items.length; i++) { w.push(Math.max(0, weight(items[i]))); tot += w[i]; }
    if (tot <= 0) return pick(items, rnd);
    var r = rnd() * tot;
    for (i = 0; i < items.length; i++) { r -= w[i]; if (r < 0) return items[i]; }
    return items[items.length - 1];
  }
  function isMain(a) { return a.type === 'take' || a.type === 'reserve' || a.type === 'buy'; }
  function boardGemCount(s) { var n = 0; for (var i = 0; i < 25; i++) if (s.board[i] && s.board[i] !== 'gold') n++; return n; }
  function cardOfSource(s, p, src) {
    if (src.from === 'pyramid') return s.pyramid[src.level][src.slot];
    if (src.from === 'reserved') return s.players[p].reserved[src.index].id;
    return null;
  }
  function maxRoyalPoints(s) {
    var m = 0;
    for (var i = 0; i < s.royals.length; i++) m = Math.max(m, E.royalById(s.royals[i]).points);
    return m;
  }

  // ── 플레이어 요약 ──
  function info(s, p) {
    var pl = s.players[p];
    var b = { white: 0, blue: 0, green: 0, red: 0, black: 0 };
    var cp = { white: 0, blue: 0, green: 0, red: 0, black: 0 };
    var pts = 0, crowns = 0, i;
    for (i = 0; i < pl.cards.length; i++) {
      var c = E.cardById(pl.cards[i]);
      pts += c.points;
      crowns += c.crowns;
      var col = c.bonus === 'joker' ? pl.jokerColor[c.id] : c.bonus;
      if (col && b[col] !== undefined) {
        b[col] += c.bonus === 'joker' ? 1 : c.bonusCount;
        cp[col] += c.points;
      }
    }
    for (i = 0; i < pl.royals.length; i++) pts += E.royalById(pl.royals[i]).points;
    var bestCP = 0, bestColor = null, jokerColor = null, jokerKey = -1;
    for (i = 0; i < COLORS.length; i++) {
      var cc = COLORS[i];
      if (cp[cc] > bestCP) { bestCP = cp[cc]; bestColor = cc; }
      if (b[cc] > 0) {
        var key = cp[cc] * 10 + b[cc];
        if (key > jokerKey) { jokerKey = key; jokerColor = cc; }
      }
    }
    return { p: p, pl: pl, tok: pl.tokens, b: b, cp: cp, pts: pts, crowns: crowns, bestCP: bestCP, bestColor: bestColor, jokerColor: jokerColor };
  }

  // 게임 진행도 (가장 가까운 승리 조건 기준, 0..1+)
  function progressOf(I) { return Math.max(I.pts / WIN_POINTS, I.crowns / WIN_CROWNS, I.bestCP / WIN_COLOR); }

  // 색별 보너스 가치: 보이는 카드(피라미드 + 내 예약)에서 그 색이 얼마나 필요한지
  function bonusWeights(s, I) {
    var demand = { white: 0, blue: 0, green: 0, red: 0, black: 0 }, max = 0.001;
    function add(id) {
      var c = E.cardById(id);
      var w = 1 + (c.points + c.crowns) / 3;
      for (var i = 0; i < COLORS.length; i++) {
        var col = COLORS[i];
        if (c.cost[col] - I.b[col] > 0) demand[col] += w;
      }
    }
    for (var l = 1; l <= 3; l++) for (var k = 0; k < s.pyramid[l].length; k++) if (s.pyramid[l][k]) add(s.pyramid[l][k]);
    for (var r = 0; r < I.pl.reserved.length; r++) add(I.pl.reserved[r].id);
    COLORS.forEach(function (c) { if (demand[c] > max) max = demand[c]; });
    var late = Math.max(0.35, 1 - 0.8 * progressOf(I));
    var out = {};
    COLORS.forEach(function (c) { out[c] = (W.bwBase + W.bwDemand * demand[c] / max) * late; });
    return out;
  }

  // 카드 하나가 이 플레이어에게 주는 가치 (+ 사면 바로 이기는지)
  function cardValue(s, I, bw, card) {
    var joker = card.bonus === 'joker';
    var col = joker ? I.jokerColor : card.bonus;
    var v = card.points;
    var np = I.pts + card.points, nc = I.crowns + card.crowns;
    if (s.royals.length && ((I.crowns < 3 && nc >= 3) || (I.crowns < 6 && nc >= 6))) {
      v += W.cvRoyal;
      np += maxRoyalPoints(s);
    }
    var win = np >= WIN_POINTS || nc >= WIN_CROWNS || (!!col && I.cp[col] + card.points >= WIN_COLOR);
    v += card.crowns * W.cvCrown;
    if (col) {
      v += (joker ? 1 : card.bonusCount) * bw[col];
      if (card.points && I.cp[col] > 0) v += W.cvColor * card.points * I.cp[col];
    }
    if (card.ability === 'extra_turn') v += W.abExtra;
    else if (card.ability === 'steal') v += W.abSteal;
    else if (card.ability === 'privilege') v += W.abPriv;
    else if (card.ability === 'bonus_token') v += W.abBonus;
    return { v: v, win: win };
  }

  // 목표 카드 하나: 효과 비용, 모자란 수(금 반영), 가치
  function target(s, I, bw, id, reserved) {
    var card = E.cardById(id);
    var need = {}, miss = 0;
    for (var i = 0; i < PAY.length; i++) {
      var t = PAY[i];
      var e = t === 'pearl' ? card.cost.pearl : Math.max(0, card.cost[t] - I.b[t]);
      need[t] = e;
      miss += Math.max(0, e - (I.tok[t] || 0));
    }
    var cv = cardValue(s, I, bw, card);
    return {
      id: id, card: card, need: need, reserved: reserved,
      short: Math.max(0, miss - (I.tok.gold || 0)),
      blocked: card.bonus === 'joker' && !I.jokerColor,
      v: cv.v, win: cv.win
    };
  }
  function targetsOf(s, I, bw) {
    var out = [];
    for (var l = 1; l <= 3; l++) for (var k = 0; k < s.pyramid[l].length; k++) if (s.pyramid[l][k]) out.push(target(s, I, bw, s.pyramid[l][k], false));
    for (var r = 0; r < I.pl.reserved.length; r++) out.push(target(s, I, bw, I.pl.reserved[r].id, true));
    return out;
  }
  function targetQ(t) { return t.blocked ? 0 : t.v * Math.pow(W.decay, t.short) * (t.reserved ? W.resBoost : 1); }

  // 한 플레이어의 점수 (toMove = 다음에 둘 사람)
  function playerScore(s, p, toMove) {
    var I = info(s, p);
    var bw = bonusWeights(s, I);
    var prog = progressOf(I);
    var S = I.pts + I.crowns * W.crown + I.bestCP * W.bestCP + W.prog * prog * prog * prog;
    // 왕실 카드 기회: 왕관 3·6개 문턱에 가까울수록
    if (s.royals.length && (I.crowns === 2 || I.crowns === 5)) S += W.royalNear;
    for (var i = 0; i < COLORS.length; i++) S += I.b[COLORS[i]] * bw[COLORS[i]];
    var tok = I.tok;
    S += W.tokGem * (tok.white + tok.blue + tok.green + tok.red + tok.black) + W.tokPearl * tok.pearl + W.tokGold * tok.gold;
    var n = sumT(tok);
    if (n > MAX_TOKENS) S -= W.over10 * (n - MAX_TOKENS);
    S += W.priv * I.pl.privileges;
    if (I.pl.reserved.length >= 3) S -= W.reserved3;
    // 곧 살 수 있는 카드들
    var ts = targetsOf(s, I, bw);
    var qs = [], canWin = false, winSoon = false;
    var privs = p === toMove ? I.pl.privileges : 0;
    for (i = 0; i < ts.length; i++) {
      var t = ts[i];
      qs.push(targetQ(t));
      if (t.win && !t.blocked) {
        if (t.short <= privs) canWin = true;
        if (t.short <= 2) winSoon = true;
      }
    }
    qs.sort(function (a, b) { return b - a; });
    var w = p === toMove ? W.potMove : W.potWait;
    S += w * ((qs[0] || 0) + W.pot2 * (qs[1] || 0) + W.pot3 * (qs[2] || 0));
    return { S: S, canWin: canWin, winSoon: winSoon };
  }

  // 국면 평가 (me 기준, 클수록 좋음)
  function evaluate(s, me) {
    if (s.over) return s.over.winner === me ? 10000 : -10000;
    var tm = s.turn.player;
    var A = playerScore(s, me, tm), B = playerScore(s, 1 - me, tm);
    var v = A.S - B.S;
    if (tm !== me) {
      if (B.canWin) v -= 300;
      if (A.winSoon) v += W.winSoon;
    } else {
      if (A.canWin) v += 300;
      v += W.tempo; // 추가 턴
    }
    return v;
  }

  // ── 대기 결정 (평가 기반) ──
  function greedyDiscard(s, p, count) {
    var I = info(s, p), bw = bonusWeights(s, I);
    var ts = targetsOf(s, I, bw).filter(function (t) { return !t.blocked; });
    ts.sort(function (a, b) { return targetQ(b) - targetQ(a); });
    var use = { white: 0, blue: 0, green: 0, red: 0, black: 0, pearl: 0, gold: 99 };
    for (var i = 0; i < Math.min(3, ts.length); i++) {
      for (var k = 0; k < PAY.length; k++) use[PAY[k]] = Math.max(use[PAY[k]], ts[i].need[PAY[k]]);
    }
    var base = { white: 1, blue: 1, green: 1, red: 1, black: 1, pearl: 2, gold: 5 };
    var tok = {}, out = {};
    TOKENS.forEach(function (t) { tok[t] = I.tok[t] || 0; out[t] = 0; });
    for (var n = 0; n < count; n++) {
      var best = null, bestKey = Infinity;
      for (var j = 0; j < TOKENS.length; j++) {
        var t = TOKENS[j];
        if (tok[t] <= 0) continue;
        var key = (tok[t] > use[t] ? 0 : 10) + base[t] - tok[t] * 0.01;
        if (key < bestKey) { bestKey = key; best = t; }
      }
      tok[best]--; out[best]++;
    }
    return out;
  }

  // 시뮬레이션 안에서 내 대기 결정을 빠르게 처리
  function settleSim(s, me) {
    var guard = 0;
    while (s && !s.over && s.pending.length && s.turn.player === me && guard++ < 10) {
      var head = s.pending[0], a;
      if (head.kind === 'discard') a = { type: 'discard', tokens: greedyDiscard(s, me, head.count) };
      else if (head.kind === 'bonusToken') a = { type: 'bonusToken', cell: s.board.indexOf(head.color) };
      else a = bestPendingByEval(s, me, E.legalActions(s)).action;
      if (!a) return s;
      var ns = sim(s, a);
      if (!ns) return s;
      s = ns;
    }
    return s;
  }
  function bestPendingByEval(s, me, opts) {
    var best = null, bestV = -Infinity;
    for (var i = 0; i < opts.length; i++) {
      var ns = sim(s, opts[i]);
      if (!ns) continue;
      var v = evaluate(settleSim(ns, me), me);
      if (v > bestV) { bestV = v; best = opts[i]; }
    }
    return { action: best, value: bestV };
  }

  // ── 보통 봇: 주 행동 평가 ──
  function hideRefill(ns, a) {
    // 공정성: 방금 더미에서 새로 나온 카드는 모르는 것으로 취급
    var src = a.source;
    if (src && src.from === 'pyramid') ns.pyramid[src.level][src.slot] = null;
  }
  // 주 행동 하나를 시뮬레이션해서 {v: 평가값, st: 결과 국면}
  function scoreMain(s, a, me, rnd) {
    if (a.type === 'reserve' && a.source.from === 'deck') {
      // 더미 맨 위 카드는 모르니, 남은 더미에서 몇 장을 뽑아 평균
      var deck = s.decks[a.source.level];
      var n = Math.min(3, deck.length), tot = 0, cnt = 0, first = null;
      for (var i = 0; i < n; i++) {
        var ns = sim(s, a);
        if (!ns) return { v: -Infinity, st: null };
        var res = ns.players[me].reserved;
        res[res.length - 1].id = deck[Math.floor(rnd() * deck.length)];
        ns = settleSim(ns, me);
        if (!first) first = ns;
        tot += evaluate(ns, me);
        cnt++;
      }
      return cnt ? { v: tot / cnt - W.deckRes, st: first } : { v: -Infinity, st: null };
    }
    var ns2 = sim(s, a);
    if (!ns2) return { v: -Infinity, st: null };
    if (!ns2.over) hideRefill(ns2, a);
    ns2 = settleSim(ns2, me);
    return { v: evaluate(ns2, me), st: ns2 };
  }

  // 가능한 주 행동을 모두 평가해서 가장 좋은 것
  function bestMain(s, me, rnd) {
    var legal = E.legalActions(s);
    var goldCell = -1, best = null;
    for (var i = 0; i < legal.length; i++) {
      var a = legal[i];
      if (!isMain(a)) continue;
      if (a.type === 'reserve') {
        // 금 칸 선택은 평가에 영향이 거의 없어서 첫 금 칸만 봄
        if (goldCell < 0) goldCell = a.goldCell;
        if (a.goldCell !== goldCell) continue;
      }
      var r = scoreMain(s, a, me, rnd);
      var c = { action: a, value: r.v + rnd() * 0.01, st: r.st };
      if (!best || c.value > best.value) best = c;
    }
    return { action: best ? best.action : null, value: best ? best.value : -Infinity, st: best ? best.st : null };
  }

  // 특권을 써서 바로 살 수 있게 되는 카드가 있으면 그 계획들 (첫 행동 = 특권 사용)
  function privilegePlans(s, me, rnd) {
    var pl = s.players[me], out = [];
    if (s.turn.replenished || pl.privileges <= 0 || s.turn.mainDone) return out;
    var I = info(s, me), bw = bonusWeights(s, I);
    var ts = targetsOf(s, I, bw);
    for (var i = 0; i < ts.length; i++) {
      var t = ts[i];
      if (t.blocked || t.short < 1 || t.short > pl.privileges) continue;
      // 모자란 토큰이 보드에 있는 칸 고르기 (진주 먼저)
      var cells = [], used = {};
      var order = ['pearl'].concat(COLORS);
      for (var o = 0; o < order.length && cells.length < t.short; o++) {
        var tt = order[o];
        var deficit = t.need[tt] - (I.tok[tt] || 0);
        for (var c = 0; c < 25 && deficit > 0 && cells.length < t.short; c++) {
          if (s.board[c] === tt && !used[c]) { used[c] = true; cells.push(c); deficit--; }
        }
      }
      if (cells.length < t.short) continue;
      var ns = s;
      for (var k = 0; k < cells.length && ns; k++) ns = sim(ns, { type: 'usePrivilege', cell: cells[k] });
      if (!ns) continue;
      var src = null;
      if (t.reserved) {
        ns.players[me].reserved.forEach(function (r, j) { if (r.id === t.id) src = { from: 'reserved', index: j }; });
      } else {
        for (var l = 1; l <= 3 && !src; l++) {
          var slot = ns.pyramid[l].indexOf(t.id);
          if (slot >= 0) src = { from: 'pyramid', level: l, slot: slot };
        }
      }
      if (!src) continue;
      var jcs = t.card.bonus === 'joker' ? E.jokerOptions(ns, me) : [undefined];
      for (var q = 0; q < jcs.length; q++) {
        var buy = { type: 'buy', source: src };
        if (jcs[q]) buy.jokerColor = jcs[q];
        var r = scoreMain(ns, buy, me, rnd);
        if (r.st) out.push({ action: { type: 'usePrivilege', cell: cells[0] }, value: r.v, st: r.st });
      }
    }
    return out;
  }

  // 보드 채우기: 무작위 결과를 몇 번 표본으로 뽑아(엔진 rng 대신 새 난수) 평균을 봄
  function replenishValue(s, me, rnd, samples) {
    var tot = 0, n = 0;
    for (var i = 0; i < samples; i++) {
      var s2 = lite(s);
      s2.rng = Math.floor(rnd() * 4294967296) >>> 0;
      var ns = sim(s2, { type: 'replenish' });
      if (!ns) return -Infinity;
      var b = bestMain(ns, me, rnd);
      if (!b.action) return -Infinity;
      tot += b.value; n++;
    }
    return n ? tot / n : -Infinity;
  }

  function normalMain(s, me, rnd, t0) {
    var main = bestMain(s, me, rnd);
    var best = main;
    if (!s.turn.replenished) {
      // 특권으로 바로 살 수 있게 되는 카드
      var pp = privilegePlans(s, me, rnd);
      for (var i = 0; i < pp.length; i++) if (pp[i].value > best.value + 0.05) best = pp[i];
      // 보드가 빈약하면 채우기를 고려
      if (W.repOn && sumT(s.bag) >= 3 && best.value < 200 && now() - t0 < BUDGET_MS) {
        var poor = boardGemCount(s) <= W.repGems || !main.action || (main.action.type === 'take' && main.action.cells.length < 3);
        if (poor) {
          var rv = replenishValue(s, me, rnd, 2);
          if (rv > best.value + W.repMargin) return { type: 'replenish' };
        }
      }
    }
    return best.action;
  }

  function normalChoose(s, rnd, t0) {
    var me = s.turn.player;
    if (s.pending.length) {
      var head = s.pending[0];
      var opts = E.legalActions(s);
      if (head.kind === 'discard') {
        var g = { type: 'discard', tokens: greedyDiscard(s, me, head.count) };
        var cand = opts.length <= 300 ? opts.concat([g]) : [g];
        return bestPendingByEval(s, me, cand).action || g;
      }
      return bestPendingByEval(s, me, opts).action;
    }
    var legal = E.legalActions(s);
    if (legal.length === 1 && (legal[0].type === 'replenish' || legal[0].type === 'pass')) return legal[0];
    return normalMain(s, me, rnd, t0);
  }

  // ── 쉬운 봇 ──
  // 쉬운 봇의 목표: 가장 덜 모자란 카드 하나 (가끔은 목표 없이)
  function easyGoal(s, me, rnd) {
    if (rnd() < 0.3) return null;
    var I = info(s, me), bw = bonusWeights(s, I);
    var ts = targetsOf(s, I, bw).filter(function (t) { return !t.blocked; });
    if (!ts.length) return null;
    var min = Math.min.apply(null, ts.map(function (t) { return t.short; }));
    var close = ts.filter(function (t) { return t.short <= min + 1; });
    var goal = weightedPick(close, function (t) { return 1 + t.card.points; }, rnd);
    var want = {};
    PAY.forEach(function (k) { want[k] = Math.max(0, goal.need[k] - (I.tok[k] || 0)); });
    return want;
  }
  function takeWeight(s, me, a, want) {
    var toks = a.cells.map(function (c) { return s.board[c]; });
    var w = a.cells.length === 3 ? 20 : a.cells.length === 2 ? 2 : 0.3;
    if (want) {
      var left = {}, hits = 0;
      for (var k in want) left[k] = want[k];
      toks.forEach(function (t) { if (left[t] > 0) { left[t]--; hits++; } });
      w *= 1 + 1.5 * hits;
    }
    var penalty = (toks.length === 3 && toks[0] === toks[1] && toks[1] === toks[2]) ||
      toks.filter(function (t) { return t === 'pearl'; }).length >= 2;
    if (penalty) w *= 0.5;
    if (sumT(s.players[me].tokens) + a.cells.length > MAX_TOKENS) w *= 0.2;
    return w;
  }
  function easyChoose(s, rnd) {
    var me = s.turn.player, pl = s.players[me];
    var legal = E.legalActions(s);
    if (!legal.length) return null;
    if (s.pending.length) {
      var head = s.pending[0];
      if (head.kind === 'discard') return { type: 'discard', tokens: greedyDiscard(s, me, head.count) };
      if (head.kind === 'royal') {
        if (rnd() < 0.6) {
          return legal.reduce(function (a, b) { return E.royalById(b.id).points > E.royalById(a.id).points ? b : a; });
        }
        return pick(legal, rnd);
      }
      if (head.kind === 'steal') {
        var pearl = legal.filter(function (a) { return a.token === 'pearl'; });
        return pearl.length && rnd() < 0.7 ? pearl[0] : pick(legal, rnd);
      }
      return pick(legal, rnd);
    }
    if (legal.length === 1) return legal[0];
    var buys = legal.filter(function (a) { return a.type === 'buy'; });
    if (buys.length && rnd() < 0.95) {
      return weightedPick(buys, function (a) {
        var c = E.cardById(cardOfSource(s, me, a.source));
        return Math.pow(1 + c.points + 0.3 * c.crowns, 3);
      }, rnd);
    }
    if (pl.privileges >= 3 && rnd() < 0.5) {
      var privs = legal.filter(function (a) { return a.type === 'usePrivilege'; });
      if (privs.length) return pick(privs, rnd);
    }
    var takes = legal.filter(function (a) { return a.type === 'take'; });
    var big = takes.some(function (a) { return a.cells.length >= 2; });
    if (!big && !s.turn.replenished && sumT(s.bag) >= 3 && rnd() < 0.5) {
      var rep = legal.filter(function (a) { return a.type === 'replenish'; });
      if (rep.length) return rep[0];
    }
    var reserves = legal.filter(function (a) { return a.type === 'reserve' && a.source.from === 'pyramid'; });
    if (reserves.length && (rnd() < 0.06 || !takes.length)) {
      var g0 = reserves[0].goldCell;
      reserves = reserves.filter(function (a) { return a.goldCell === g0; });
      return weightedPick(reserves, function (a) { return 1 + E.cardById(cardOfSource(s, me, a.source)).points; }, rnd);
    }
    if (takes.length) {
      var want = easyGoal(s, me, rnd);
      return weightedPick(takes, function (a) { return takeWeight(s, me, a, want); }, rnd);
    }
    var mains = legal.filter(isMain);
    return pick(mains.length ? mains : legal, rnd);
  }

  // ── 공개 API ──
  function chooseAction(state, opts) {
    opts = opts || {};
    if (!state || !state.turn || state.over) return null;
    var rnd = typeof opts.rng === 'function' ? opts.rng : Math.random;
    var level = opts.level === 'easy' ? 'easy' : 'normal';
    var s = lite(state);
    var t0 = now();
    var a = null;
    try {
      a = level === 'easy' ? easyChoose(s, rnd) : normalChoose(s, rnd, t0);
    } catch (err) {
      debug.lastError = err;
      a = null;
    }
    if (a && E.apply(s, a).ok) return a;
    // 안전장치: 가능한 행동 중 실제로 적용되는 것
    debug.fallbacks++;
    var legal = E.legalActions(s);
    for (var i = 0; i < legal.length; i++) if (E.apply(s, legal[i]).ok) return legal[i];
    return null;
  }

  var SDBot = { chooseAction: chooseAction, _debug: debug };

  if (typeof module !== 'undefined' && module.exports) module.exports = SDBot;
  else window.SDBot = SDBot;
})();
