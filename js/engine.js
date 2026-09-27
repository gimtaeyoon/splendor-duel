// 스플렌더 대결 규칙 엔진 — 순수 함수, JSON 직렬화 가능한 상태 (docs/SPEC.md §2–3, docs/RULES.md)
(function () {
  'use strict';

  var SDCards = (typeof module !== 'undefined' && module.exports) ? require('./cards.js') : window.SDCards;

  // ── 상수 ──
  var COLORS = ['white', 'blue', 'green', 'red', 'black'];
  var TOKENS = ['white', 'blue', 'green', 'red', 'black', 'pearl', 'gold'];
  var PAY_TYPES = ['white', 'blue', 'green', 'red', 'black', 'pearl']; // 금 제외 (비용 항목)
  var SPIRAL = [12, 17, 16, 11, 6, 7, 8, 13, 18, 23, 22, 21, 20, 15, 10, 5, 0, 1, 2, 3, 4, 9, 14, 19, 24];
  var PYRAMID_SIZES = { 1: 5, 2: 4, 3: 3 };
  var MAX_TOKENS = 10;
  var MAX_RESERVED = 3;
  var PRIVILEGES = 3;
  var ROYAL_CROWNS = [3, 6];
  var WIN_POINTS = 20, WIN_CROWNS = 10, WIN_COLOR_POINTS = 10;
  var LOG_MAX = 60;
  var TOKEN_NAMES_KO = { white: '흰색', blue: '파란색', green: '초록색', red: '빨간색', black: '검은색', pearl: '진주', gold: '금' };
  // 선 방향 (인덱스가 커지는 쪽): 오른쪽, 아래, 오른쪽 아래, 왼쪽 아래
  var DIRS = [[0, 1], [1, 0], [1, 1], [1, -1]];

  var CARD_MAP = {};
  SDCards.CARDS.forEach(function (c) { CARD_MAP[c.id] = c; });
  var ROYAL_MAP = {};
  SDCards.ROYALS.forEach(function (r) { ROYAL_MAP[r.id] = r; });

  // ── 유틸 ──
  function clone(x) {
    if (x === null || typeof x !== 'object') return x;
    var i, out;
    if (Array.isArray(x)) {
      out = new Array(x.length);
      for (i = 0; i < x.length; i++) out[i] = clone(x[i]);
      return out;
    }
    out = {};
    var keys = Object.keys(x);
    for (i = 0; i < keys.length; i++) {
      var v = x[keys[i]];
      if (v !== undefined) out[keys[i]] = clone(v);
    }
    return out;
  }
  function emptyTokens() { return { white: 0, blue: 0, green: 0, red: 0, black: 0, pearl: 0, gold: 0 }; }
  function isInt(n) { return typeof n === 'number' && Number.isInteger(n); }
  function isCell(n) { return isInt(n) && n >= 0 && n < 25; }
  function isGemOrPearl(t) { return t !== null && t !== undefined && t !== 'gold'; }
  function sumTokens(t) { var s = 0; for (var i = 0; i < TOKENS.length; i++) s += t[TOKENS[i]] || 0; return s; }
  function fail(error) { return { ok: false, error: error }; }

  // mulberry32 — 상태는 s.rng (uint32)에 보관
  function rand(s) {
    s.rng = (s.rng + 0x6D2B79F5) >>> 0;
    var t = s.rng;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  function shuffle(s, arr) {
    for (var i = arr.length - 1; i > 0; i--) {
      var j = Math.floor(rand(s) * (i + 1));
      var tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
    }
    return arr;
  }

  function cardById(id) { return CARD_MAP[id] || null; }
  function royalById(id) { return ROYAL_MAP[id] || null; }

  // ── 새 게임 ──
  function mkPlayer(name) {
    return { name: name, tokens: emptyTokens(), cards: [], jokerColor: {}, reserved: [], royals: [], privileges: 0 };
  }

  function newGame(opts) {
    opts = opts || {};
    var names = opts.names || [];
    var first = opts.first === 1 ? 1 : 0;
    var seed = opts.seed;
    if (typeof seed !== 'number' || !isFinite(seed)) seed = Math.floor(Math.random() * 4294967296);
    var s = {
      v: 1,
      rng: seed >>> 0,
      board: new Array(25).fill(null),
      bag: emptyTokens(),
      decks: { 1: [], 2: [], 3: [] },
      pyramid: { 1: [], 2: [], 3: [] },
      royals: SDCards.ROYALS.map(function (r) { return r.id; }),
      privilegeSupply: PRIVILEGES,
      players: [mkPlayer(String(names[0] || '플레이어 1')), mkPlayer(String(names[1] || '플레이어 2'))],
      turn: { player: first, number: 1, replenished: false, mainDone: false, extraTurn: false },
      pending: [],
      over: null,
      log: []
    };
    for (var level = 1; level <= 3; level++) {
      var ids = SDCards.CARDS.filter(function (c) { return c.level === level; }).map(function (c) { return c.id; });
      shuffle(s, ids);
      for (var k = 0; k < PYRAMID_SIZES[level]; k++) s.pyramid[level].push(ids.pop());
      s.decks[level] = ids;
    }
    var toks = [];
    COLORS.forEach(function (c) { for (var i = 0; i < 4; i++) toks.push(c); });
    toks.push('pearl', 'pearl', 'gold', 'gold', 'gold');
    shuffle(s, toks);
    for (var i = 0; i < toks.length; i++) s.board[SPIRAL[i]] = toks[i];
    // 후공이 특권 1개
    s.privilegeSupply -= 1;
    s.players[1 - first].privileges = 1;
    return s;
  }

  // ── 플레이어 계산 ──
  function bonusesOf(pl) {
    var b = { white: 0, blue: 0, green: 0, red: 0, black: 0 };
    for (var i = 0; i < pl.cards.length; i++) {
      var c = CARD_MAP[pl.cards[i]];
      if (!c || !c.bonus) continue;
      if (c.bonus === 'joker') {
        var jc = pl.jokerColor && pl.jokerColor[c.id];
        if (jc && b[jc] !== undefined) b[jc] += 1;
      } else {
        b[c.bonus] += c.bonusCount;
      }
    }
    return b;
  }
  function crownsOf(pl) {
    var n = 0;
    for (var i = 0; i < pl.cards.length; i++) { var c = CARD_MAP[pl.cards[i]]; if (c) n += c.crowns; }
    return n;
  }

  function stats(state, p) {
    var pl = state.players[p];
    var colorPoints = { white: 0, blue: 0, green: 0, red: 0, black: 0 };
    var points = 0, crowns = 0;
    for (var i = 0; i < pl.cards.length; i++) {
      var c = CARD_MAP[pl.cards[i]];
      if (!c) continue;
      points += c.points;
      crowns += c.crowns;
      var col = c.bonus === 'joker' ? (pl.jokerColor && pl.jokerColor[c.id]) : c.bonus;
      if (col && colorPoints[col] !== undefined) colorPoints[col] += c.points;
    }
    var royalPoints = 0;
    for (var r = 0; r < pl.royals.length; r++) { var ro = ROYAL_MAP[pl.royals[r]]; if (ro) royalPoints += ro.points; }
    points += royalPoints;
    return {
      points: points,
      crowns: crowns,
      colorPoints: colorPoints,
      bonuses: bonusesOf(pl),
      tokenCount: sumTokens(pl.tokens),
      tokens: clone(pl.tokens),
      privileges: pl.privileges,
      royalPoints: royalPoints
    };
  }

  // ── 비용과 결제 ──
  function effCost(pl, card) {
    var b = bonusesOf(pl);
    var e = {};
    for (var i = 0; i < COLORS.length; i++) {
      var c = COLORS[i];
      e[c] = Math.max(0, (card.cost[c] || 0) - b[c]);
    }
    e.pearl = card.cost.pearl || 0; // 진주는 할인 없음
    return e;
  }
  function effectiveCost(state, p, cardId) {
    var card = CARD_MAP[cardId];
    if (!card) return null;
    return effCost(state.players[p], card);
  }

  function defaultPayFor(pl, card) {
    var e = effCost(pl, card);
    var pay = emptyTokens();
    var short = 0;
    for (var i = 0; i < PAY_TYPES.length; i++) {
      var t = PAY_TYPES[i];
      var use = Math.min(e[t], pl.tokens[t] || 0);
      pay[t] = use;
      short += e[t] - use;
    }
    if (short > (pl.tokens.gold || 0)) return null;
    pay.gold = short;
    return pay;
  }
  function defaultPayment(state, p, cardId) {
    var card = CARD_MAP[cardId];
    if (!card) return null;
    return defaultPayFor(state.players[p], card);
  }

  function affordable(pl, card) {
    var e = effCost(pl, card);
    var short = 0;
    for (var i = 0; i < PAY_TYPES.length; i++) {
      var t = PAY_TYPES[i];
      short += Math.max(0, e[t] - (pl.tokens[t] || 0));
    }
    return short <= (pl.tokens.gold || 0);
  }

  function checkPayment(pl, card, payment) {
    if (!payment || typeof payment !== 'object') return '결제 내역이 올바르지 않아요.';
    var e = effCost(pl, card);
    var pay = emptyTokens();
    for (var i = 0; i < TOKENS.length; i++) {
      var t = TOKENS[i];
      var v = payment[t] === undefined ? 0 : payment[t];
      if (!isInt(v) || v < 0) return '결제 내역이 올바르지 않아요.';
      pay[t] = v;
    }
    for (i = 0; i < TOKENS.length; i++) {
      if (pay[TOKENS[i]] > (pl.tokens[TOKENS[i]] || 0)) return '가지고 있는 것보다 많은 토큰을 낼 수 없어요.';
    }
    var need = 0;
    for (i = 0; i < PAY_TYPES.length; i++) {
      var tt = PAY_TYPES[i];
      if (pay[tt] > e[tt]) return TOKEN_NAMES_KO[tt] + ' 토큰을 필요한 것보다 많이 낼 수 없어요.';
      need += e[tt] - pay[tt];
    }
    if (pay.gold > need) return '금 토큰을 필요한 것보다 많이 냈어요.';
    if (pay.gold < need) return '값이 모자라요. 부족한 만큼 금 토큰으로 채워 주세요.';
    return null;
  }
  function validatePayment(state, p, cardId, payment) {
    var card = CARD_MAP[cardId];
    if (!card) return fail('그런 카드는 없어요.');
    var err = checkPayment(state.players[p], card, payment);
    return err ? fail(err) : { ok: true };
  }

  function jokerOptionsFor(pl) {
    var b = bonusesOf(pl);
    return COLORS.filter(function (c) { return b[c] > 0; });
  }
  function jokerOptions(state, p) { return jokerOptionsFor(state.players[p]); }

  // ── 토큰 줄 규칙 ──
  function takeCheck(board, cells) {
    if (!Array.isArray(cells) || cells.length < 1 || cells.length > 3) return fail('토큰을 1~3개 골라 주세요.');
    for (var i = 0; i < cells.length; i++) {
      if (!isCell(cells[i])) return fail('보드 칸을 골라 주세요.');
    }
    var sorted = cells.slice().sort(function (a, b) { return a - b; });
    for (i = 1; i < sorted.length; i++) {
      if (sorted[i] === sorted[i - 1]) return fail('같은 칸을 두 번 고를 수 없어요.');
    }
    for (i = 0; i < sorted.length; i++) {
      var t = board[sorted[i]];
      if (t === null || t === undefined) return fail('빈 칸에는 가져올 토큰이 없어요.');
      if (t === 'gold') return fail('금 토큰은 가져올 수 없어요. 금은 카드를 예약할 때만 가져와요.');
    }
    if (sorted.length >= 2) {
      var r0 = Math.floor(sorted[0] / 5), c0 = sorted[0] % 5;
      var r1 = Math.floor(sorted[1] / 5), c1 = sorted[1] % 5;
      var dr = r1 - r0, dc = c1 - c0;
      if (Math.abs(dr) > 1 || Math.abs(dc) > 1) return fail('토큰은 한 줄로 붙어 있어야 해요.');
      if (sorted.length === 3) {
        var r2 = r1 + dr, c2 = c1 + dc;
        if (r2 < 0 || r2 > 4 || c2 < 0 || c2 > 4 || r2 * 5 + c2 !== sorted[2]) return fail('토큰은 한 줄로 붙어 있어야 해요.');
      }
    }
    var penalty = false;
    var toks = sorted.map(function (c) { return board[c]; });
    if (toks.length === 3 && toks[0] === toks[1] && toks[1] === toks[2]) penalty = true;
    if (toks.filter(function (t) { return t === 'pearl'; }).length >= 2) penalty = true;
    return { ok: true, privilegeToOpponent: penalty };
  }
  function validateTake(state, cells) { return takeCheck(state.board, cells); }

  function takeExtensions(state, cells) {
    cells = Array.isArray(cells) ? cells : [];
    if (cells.length >= 3) return [];
    if (cells.length > 0 && !takeCheck(state.board, cells).ok) return [];
    var out = [];
    for (var i = 0; i < 25; i++) {
      if (cells.indexOf(i) >= 0 || !isGemOrPearl(state.board[i])) continue;
      if (takeCheck(state.board, cells.concat([i])).ok) out.push(i);
    }
    return out;
  }

  // ── 가능성 판단 ──
  function boardHasGem(board) {
    for (var i = 0; i < 25; i++) if (isGemOrPearl(board[i])) return true;
    return false;
  }
  function boardHas(board, t) { return board.indexOf(t) >= 0; }
  function anyCardSource(s) {
    for (var l = 1; l <= 3; l++) {
      if (s.decks[l].length) return true;
      for (var k = 0; k < s.pyramid[l].length; k++) if (s.pyramid[l][k]) return true;
    }
    return false;
  }
  function canBuyCard(pl, card) {
    if (card.bonus === 'joker' && jokerOptionsFor(pl).length === 0) return false;
    return affordable(pl, card);
  }
  function mainPossibleFor(s, p) {
    if (boardHasGem(s.board)) return true;
    var pl = s.players[p];
    if (boardHas(s.board, 'gold') && pl.reserved.length < MAX_RESERVED && anyCardSource(s)) return true;
    for (var l = 1; l <= 3; l++) {
      for (var k = 0; k < s.pyramid[l].length; k++) {
        var id = s.pyramid[l][k];
        if (id && canBuyCard(pl, CARD_MAP[id])) return true;
      }
    }
    for (var r = 0; r < pl.reserved.length; r++) {
      if (canBuyCard(pl, CARD_MAP[pl.reserved[r].id])) return true;
    }
    return false;
  }
  function mainActionPossible(state) { return mainPossibleFor(state, state.turn.player); }

  // ── 상태 변경 (복제본에만) ──
  function emit(s, ev, e) { e.turnNo = s.turn.number; ev.push(e); return e; }

  // 특권 획득 규칙: 공급처 → 상대 → 없음
  function gainPrivilege(s, p, reason, ev) {
    var from;
    if (s.privilegeSupply > 0) { s.privilegeSupply--; s.players[p].privileges++; from = 'supply'; }
    else if (s.players[1 - p].privileges > 0) { s.players[1 - p].privileges--; s.players[p].privileges++; from = 'opponent'; }
    else from = 'none';
    emit(s, ev, { t: 'gainPrivilege', p: p, from: from, reason: reason });
  }

  function refillSlot(s, level, slot) {
    var d = s.decks[level];
    var id = d.length ? d.pop() : null;
    s.pyramid[level][slot] = id;
    return id;
  }

  function pendingMessage(head) {
    switch (head.kind) {
      case 'bonusToken': return '먼저 보드에서 ' + TOKEN_NAMES_KO[head.color] + ' 토큰 1개를 가져와야 해요.';
      case 'steal': return '먼저 상대에게서 토큰 1개를 가져와야 해요.';
      case 'royal': return '먼저 왕실 카드를 1장 골라야 해요.';
      case 'discard': return '먼저 토큰 ' + head.count + '개를 버려야 해요.';
    }
    return '먼저 해야 할 일이 남아 있어요.';
  }

  function doResign(s, action, ev) {
    var who = action.player === undefined ? s.turn.player : action.player;
    if (who !== 0 && who !== 1) return '누가 기권하는지 알 수 없어요.';
    emit(s, ev, { t: 'resign', p: who });
    s.over = { winner: 1 - who, reason: 'resign' };
    emit(s, ev, { t: 'win', p: 1 - who, reason: 'resign' });
    return null;
  }

  function doUsePrivilege(s, p, action, ev) {
    var pl = s.players[p];
    if (s.turn.replenished) return '보드를 채운 뒤에는 특권을 쓸 수 없어요.';
    if (pl.privileges <= 0) return '사용할 특권이 없어요.';
    var cell = action.cell;
    if (!isCell(cell)) return '보드 칸을 골라 주세요.';
    var t = s.board[cell];
    if (t === null) return '빈 칸에는 가져올 토큰이 없어요.';
    if (t === 'gold') return '특권으로는 금 토큰을 가져올 수 없어요.';
    pl.privileges--;
    s.privilegeSupply++;
    s.board[cell] = null;
    pl.tokens[t]++;
    emit(s, ev, { t: 'privilege', p: p, cell: cell, token: t });
    return null;
  }

  function doReplenish(s, p, ev) {
    if (s.turn.replenished) return '보드는 한 턴에 한 번만 채울 수 있어요.';
    var total = sumTokens(s.bag);
    if (total <= 0) return '주머니가 비어 있어서 보드를 채울 수 없어요.';
    var cells = [], toks = [];
    for (var i = 0; i < SPIRAL.length && total > 0; i++) {
      var cell = SPIRAL[i];
      if (s.board[cell] !== null) continue;
      var r = Math.floor(rand(s) * total);
      var pick = null;
      for (var k = 0; k < TOKENS.length; k++) {
        var n = s.bag[TOKENS[k]];
        if (r < n) { pick = TOKENS[k]; break; }
        r -= n;
      }
      s.bag[pick]--;
      total--;
      s.board[cell] = pick;
      cells.push(cell);
      toks.push(pick);
    }
    s.turn.replenished = true;
    emit(s, ev, { t: 'replenish', p: p, cells: cells, tokens: toks });
    gainPrivilege(s, 1 - p, 'replenish', ev);
    return null;
  }

  function doTake(s, p, action, ev) {
    var chk = takeCheck(s.board, action.cells);
    if (!chk.ok) return chk.error;
    var cells = action.cells.slice().sort(function (a, b) { return a - b; });
    var pl = s.players[p];
    var toks = cells.map(function (c) { var t = s.board[c]; s.board[c] = null; pl.tokens[t]++; return t; });
    emit(s, ev, { t: 'take', p: p, cells: cells, tokens: toks, penalty: chk.privilegeToOpponent });
    if (chk.privilegeToOpponent) gainPrivilege(s, 1 - p, 'penalty', ev);
    s.turn.mainDone = true;
    return null;
  }

  function sourceLevel(src) {
    var l = src.level;
    return (l === 1 || l === 2 || l === 3) ? l : null;
  }

  function doReserve(s, p, action, ev) {
    var pl = s.players[p];
    if (pl.reserved.length >= MAX_RESERVED) return '예약은 최대 3장까지만 할 수 있어요.';
    if (!boardHas(s.board, 'gold')) return '보드에 금 토큰이 없어서 예약할 수 없어요.';
    var goldCell = action.goldCell;
    if (goldCell === undefined || goldCell === null) {
      for (var i = 0; i < SPIRAL.length; i++) if (s.board[SPIRAL[i]] === 'gold') { goldCell = SPIRAL[i]; break; }
    }
    if (!isCell(goldCell) || s.board[goldCell] !== 'gold') return '금 토큰이 있는 칸을 골라 주세요.';
    var src = action.source || {};
    var level = sourceLevel(src);
    if (!level) return '예약할 카드를 골라 주세요.';
    var cardId, refill = null, fromDeck;
    if (src.from === 'pyramid') {
      var slot = src.slot;
      if (!isInt(slot) || slot < 0 || slot >= s.pyramid[level].length) return '예약할 카드를 골라 주세요.';
      cardId = s.pyramid[level][slot];
      if (!cardId) return '그 자리에는 카드가 없어요.';
      fromDeck = false;
    } else if (src.from === 'deck') {
      if (!s.decks[level].length) return '그 더미에는 카드가 남아 있지 않아요.';
      fromDeck = true;
    } else return '예약할 카드를 골라 주세요.';
    // 금 먼저 가져오고 카드 예약
    s.board[goldCell] = null;
    pl.tokens.gold++;
    if (fromDeck) {
      cardId = s.decks[level].pop();
    } else {
      refill = refillSlot(s, level, src.slot);
    }
    pl.reserved.push({ id: cardId, fromDeck: fromDeck });
    var source = fromDeck ? { from: 'deck', level: level } : { from: 'pyramid', level: level, slot: src.slot };
    emit(s, ev, { t: 'reserve', p: p, cardId: cardId, source: source, fromDeck: fromDeck, goldCell: goldCell, refill: refill });
    s.turn.mainDone = true;
    return null;
  }

  function doBuy(s, p, action, ev) {
    var pl = s.players[p];
    var src = action.source || {};
    var cardId, level = null, slot = null, index = null;
    if (src.from === 'pyramid') {
      level = sourceLevel(src);
      slot = src.slot;
      if (!level || !isInt(slot) || slot < 0 || slot >= s.pyramid[level].length) return '살 카드를 골라 주세요.';
      cardId = s.pyramid[level][slot];
      if (!cardId) return '그 자리에는 카드가 없어요.';
    } else if (src.from === 'reserved') {
      index = src.index;
      if (!isInt(index) || index < 0 || index >= pl.reserved.length) return '예약한 카드를 찾을 수 없어요.';
      cardId = pl.reserved[index].id;
    } else return '살 카드를 골라 주세요.';
    var card = CARD_MAP[cardId];
    if (!card) return '그런 카드는 없어요.';
    var jokerColor = null;
    if (card.bonus === 'joker') {
      var opts = jokerOptionsFor(pl);
      if (!opts.length) return '조커 카드는 보너스가 있는 카드를 먼저 가지고 있어야 살 수 있어요.';
      jokerColor = action.jokerColor;
      if (!jokerColor) return '조커 카드가 어떤 색이 될지 골라 주세요.';
      if (opts.indexOf(jokerColor) < 0) return '그 색의 보너스 카드가 없어서 고를 수 없어요.';
    }
    var payment = action.payment;
    if (payment === undefined || payment === null) {
      payment = defaultPayFor(pl, card);
      if (!payment) return '토큰이 모자라서 이 카드를 살 수 없어요.';
    }
    var perr = checkPayment(pl, card, payment);
    if (perr) {
      if (!affordable(pl, card)) return '토큰이 모자라서 이 카드를 살 수 없어요.';
      return perr;
    }
    var pay = emptyTokens();
    for (var i = 0; i < TOKENS.length; i++) {
      var t = TOKENS[i];
      var v = payment[t] || 0;
      pay[t] = v;
      pl.tokens[t] -= v;
      s.bag[t] += v;
    }
    var crownsBefore = crownsOf(pl);
    var refill = null, source;
    if (src.from === 'pyramid') {
      refill = refillSlot(s, level, slot);
      source = { from: 'pyramid', level: level, slot: slot };
    } else {
      var entry = pl.reserved.splice(index, 1)[0];
      source = { from: 'reserved', index: index, fromDeck: !!entry.fromDeck };
    }
    pl.cards.push(cardId);
    if (jokerColor) pl.jokerColor[cardId] = jokerColor;
    var e = { t: 'buy', p: p, cardId: cardId, source: source, payment: pay, refill: refill };
    if (jokerColor) e.jokerColor = jokerColor;
    emit(s, ev, e);

    // 1) 카드 능력
    if (card.ability === 'extra_turn') {
      s.turn.extraTurn = true;
      emit(s, ev, { t: 'extraTurn', p: p, source: 'card', cardId: cardId });
    } else if (card.ability === 'bonus_token') {
      var color = card.bonus === 'joker' ? jokerColor : card.bonus;
      s.pending.push({ kind: 'bonusToken', color: color });
    } else if (card.ability === 'steal') {
      s.pending.push({ kind: 'steal' });
    } else if (card.ability === 'privilege') {
      gainPrivilege(s, p, 'ability', ev);
    }
    // 2) 왕관 3개, 6개 → 왕실 카드
    var crownsAfter = crownsOf(pl);
    for (var r = 0; r < ROYAL_CROWNS.length; r++) {
      var th = ROYAL_CROWNS[r];
      if (crownsBefore < th && crownsAfter >= th) s.pending.push({ kind: 'royal' });
    }
    s.turn.mainDone = true;
    return null;
  }

  function doPass(s, p, ev) {
    if (mainPossibleFor(s, p)) return '할 수 있는 행동이 있어서 턴을 넘길 수 없어요.';
    if (sumTokens(s.bag) > 0 && !s.turn.replenished) return '먼저 보드를 채워야 해요.';
    emit(s, ev, { t: 'pass', p: p });
    s.turn.mainDone = true;
    return null;
  }

  function doPending(s, p, head, action, ev) {
    var pl = s.players[p], opp = s.players[1 - p];
    if (head.kind === 'bonusToken') {
      var cell = action.cell;
      if (!isCell(cell)) return '보드 칸을 골라 주세요.';
      if (s.board[cell] !== head.color) return '그 칸에는 ' + TOKEN_NAMES_KO[head.color] + ' 토큰이 없어요.';
      s.board[cell] = null;
      pl.tokens[head.color]++;
      s.pending.shift();
      emit(s, ev, { t: 'bonusToken', p: p, cell: cell, token: head.color });
      return null;
    }
    if (head.kind === 'steal') {
      var tok = action.token;
      if (tok === 'gold') return '금 토큰은 빼앗을 수 없어요.';
      if (PAY_TYPES.indexOf(tok) < 0) return '가져올 토큰을 골라 주세요.';
      if (!(opp.tokens[tok] > 0)) return '상대가 그 토큰을 가지고 있지 않아요.';
      opp.tokens[tok]--;
      pl.tokens[tok]++;
      s.pending.shift();
      emit(s, ev, { t: 'steal', p: p, token: tok, from: 1 - p });
      return null;
    }
    if (head.kind === 'royal') {
      var id = action.id;
      var idx = s.royals.indexOf(id);
      if (idx < 0) return '그 왕실 카드는 가져갈 수 없어요.';
      s.royals.splice(idx, 1);
      pl.royals.push(id);
      s.pending.shift();
      emit(s, ev, { t: 'royal', p: p, id: id });
      var ro = ROYAL_MAP[id];
      if (ro.ability === 'steal') s.pending.unshift({ kind: 'steal' });
      else if (ro.ability === 'privilege') gainPrivilege(s, p, 'royal', ev);
      else if (ro.ability === 'extra_turn') {
        s.turn.extraTurn = true;
        emit(s, ev, { t: 'extraTurn', p: p, source: 'royal', id: id });
      }
      return null;
    }
    if (head.kind === 'discard') {
      var d = action.tokens;
      if (!d || typeof d !== 'object') return '버릴 토큰을 골라 주세요.';
      var out = emptyTokens(), total = 0;
      for (var i = 0; i < TOKENS.length; i++) {
        var t = TOKENS[i];
        var v = d[t] === undefined ? 0 : d[t];
        if (!isInt(v) || v < 0) return '버릴 토큰을 골라 주세요.';
        if (v > pl.tokens[t]) return '가지고 있는 것보다 많이 버릴 수 없어요.';
        out[t] = v;
        total += v;
      }
      if (total !== head.count) return '토큰을 정확히 ' + head.count + '개 골라 버려 주세요.';
      for (i = 0; i < TOKENS.length; i++) {
        pl.tokens[TOKENS[i]] -= out[TOKENS[i]];
        s.bag[TOKENS[i]] += out[TOKENS[i]];
      }
      s.pending.shift();
      emit(s, ev, { t: 'discard', p: p, tokens: out });
      return null;
    }
    return '알 수 없는 행동이에요.';
  }

  function checkVictory(s, p) {
    var st = stats(s, p);
    if (st.points >= WIN_POINTS) return { winner: p, reason: 'points' };
    if (st.crowns >= WIN_CROWNS) return { winner: p, reason: 'crowns' };
    for (var i = 0; i < COLORS.length; i++) {
      if (st.colorPoints[COLORS[i]] >= WIN_COLOR_POINTS) return { winner: p, reason: 'color', color: COLORS[i] };
    }
    return null;
  }

  // 대기 결정 자동 건너뛰기 + 턴 마무리 (토큰 제한 → 승리 확인 → 다음 턴)
  function settle(s, ev) {
    for (;;) {
      if (s.over) return;
      var p = s.turn.player;
      while (s.pending.length) {
        var head = s.pending[0];
        if (head.kind === 'bonusToken' && !boardHas(s.board, head.color)) {
          s.pending.shift();
          emit(s, ev, { t: 'bonusToken', p: p, token: head.color, skipped: true });
        } else if (head.kind === 'steal' && !PAY_TYPES.some(function (t) { return s.players[1 - p].tokens[t] > 0; })) {
          s.pending.shift();
          emit(s, ev, { t: 'steal', p: p, from: 1 - p, skipped: true });
        } else if (head.kind === 'royal' && !s.royals.length) {
          s.pending.shift();
          emit(s, ev, { t: 'royal', p: p, skipped: true });
        } else break;
      }
      if (s.pending.length || !s.turn.mainDone) return;
      var count = sumTokens(s.players[p].tokens);
      if (count > MAX_TOKENS) {
        s.pending.push({ kind: 'discard', count: count - MAX_TOKENS });
        return;
      }
      var win = checkVictory(s, p);
      if (win) {
        s.over = win;
        var we = { t: 'win', p: p, reason: win.reason };
        if (win.color) we.color = win.color;
        emit(s, ev, we);
        return;
      }
      var extra = s.turn.extraTurn;
      var next = extra ? p : 1 - p;
      s.turn = { player: next, number: s.turn.number + 1, replenished: false, mainDone: false, extraTurn: false };
      emit(s, ev, { t: 'turn', p: next, number: s.turn.number, extra: extra });
      return;
    }
  }

  function dispatch(s, action, ev) {
    var type = action.type;
    if (type === 'resign') return doResign(s, action, ev);
    var p = s.turn.player;
    if (s.pending.length) {
      var head = s.pending[0];
      if (type !== head.kind) return pendingMessage(head);
      return doPending(s, p, head, action, ev);
    }
    switch (type) {
      case 'usePrivilege':
      case 'replenish':
      case 'take':
      case 'reserve':
      case 'buy':
      case 'pass':
        if (s.turn.mainDone) return '이번 턴의 행동은 이미 끝났어요.';
        break;
      case 'bonusToken': case 'steal': case 'royal': case 'discard':
        return '지금은 그 행동을 할 수 없어요.';
      default:
        return '알 수 없는 행동이에요.';
    }
    if (type === 'usePrivilege') return doUsePrivilege(s, p, action, ev);
    if (type === 'replenish') return doReplenish(s, p, ev);
    if (type === 'take') return doTake(s, p, action, ev);
    if (type === 'reserve') return doReserve(s, p, action, ev);
    if (type === 'buy') return doBuy(s, p, action, ev);
    return doPass(s, p, ev);
  }

  function apply(state, action) {
    if (!state || typeof state !== 'object' || !state.turn) return fail('게임 상태가 올바르지 않아요.');
    if (!action || typeof action !== 'object' || typeof action.type !== 'string') return fail('알 수 없는 행동이에요.');
    if (state.over) return fail('게임이 이미 끝났어요.');
    var s = clone(state);
    var ev = [];
    var err = dispatch(s, action, ev);
    if (err) return fail(err);
    settle(s, ev);
    var log = s.log.concat(ev);
    s.log = log.length > LOG_MAX ? log.slice(log.length - LOG_MAX) : log;
    return { ok: true, state: s, events: clone(ev) };
  }

  // ── 가능한 모든 행동 ──
  function discardOptions(tokens, count) {
    var out = [];
    var cur = emptyTokens();
    (function rec(i, left) {
      if (i === TOKENS.length) {
        if (left === 0) out.push(clone(cur));
        return;
      }
      var t = TOKENS[i];
      var max = Math.min(left, tokens[t] || 0);
      for (var k = max; k >= 0; k--) {
        cur[t] = k;
        rec(i + 1, left - k);
      }
      cur[t] = 0;
    })(0, count);
    if (out.length <= 300) return out;
    // 300개로 줄이되 고르게 뽑아 다양성 유지
    var picked = [];
    for (var j = 0; j < 300; j++) picked.push(out[Math.floor(j * out.length / 300)]);
    return picked;
  }

  function takeOptions(board) {
    var out = [];
    for (var i = 0; i < 25; i++) {
      if (!isGemOrPearl(board[i])) continue;
      out.push({ type: 'take', cells: [i] });
      var r = Math.floor(i / 5), c = i % 5;
      for (var d = 0; d < DIRS.length; d++) {
        var r1 = r + DIRS[d][0], c1 = c + DIRS[d][1];
        if (r1 < 0 || r1 > 4 || c1 < 0 || c1 > 4) continue;
        var j = r1 * 5 + c1;
        if (!isGemOrPearl(board[j])) continue;
        out.push({ type: 'take', cells: [i, j] });
        var r2 = r1 + DIRS[d][0], c2 = c1 + DIRS[d][1];
        if (r2 < 0 || r2 > 4 || c2 < 0 || c2 > 4) continue;
        var k = r2 * 5 + c2;
        if (!isGemOrPearl(board[k])) continue;
        out.push({ type: 'take', cells: [i, j, k] });
      }
    }
    return out;
  }

  function buyOptions(pl, card, source) {
    if (!affordable(pl, card)) return [];
    var pay = defaultPayFor(pl, card);
    if (card.bonus === 'joker') {
      return jokerOptionsFor(pl).map(function (col) {
        return { type: 'buy', source: clone(source), payment: clone(pay), jokerColor: col };
      });
    }
    return [{ type: 'buy', source: source, payment: pay }];
  }

  function legalActions(state) {
    var s = state;
    if (!s || s.over) return [];
    var p = s.turn.player, pl = s.players[p], opp = s.players[1 - p];
    var out = [], i;
    if (s.pending.length) {
      var head = s.pending[0];
      if (head.kind === 'bonusToken') {
        for (i = 0; i < 25; i++) if (s.board[i] === head.color) out.push({ type: 'bonusToken', cell: i });
      } else if (head.kind === 'steal') {
        PAY_TYPES.forEach(function (t) { if (opp.tokens[t] > 0) out.push({ type: 'steal', token: t }); });
      } else if (head.kind === 'royal') {
        s.royals.forEach(function (id) { out.push({ type: 'royal', id: id }); });
      } else if (head.kind === 'discard') {
        discardOptions(pl.tokens, head.count).forEach(function (t) { out.push({ type: 'discard', tokens: t }); });
      }
      return out;
    }
    if (s.turn.mainDone) return [];
    if (!mainPossibleFor(s, p)) {
      if (!s.turn.replenished && sumTokens(s.bag) > 0) return [{ type: 'replenish' }];
      return [{ type: 'pass' }];
    }
    if (!s.turn.replenished) {
      if (pl.privileges > 0) {
        for (i = 0; i < 25; i++) if (isGemOrPearl(s.board[i])) out.push({ type: 'usePrivilege', cell: i });
      }
      if (sumTokens(s.bag) > 0) out.push({ type: 'replenish' });
    }
    out.push.apply(out, takeOptions(s.board));
    if (pl.reserved.length < MAX_RESERVED) {
      var sources = [];
      for (var l = 1; l <= 3; l++) {
        for (var k = 0; k < s.pyramid[l].length; k++) if (s.pyramid[l][k]) sources.push({ from: 'pyramid', level: l, slot: k });
        if (s.decks[l].length) sources.push({ from: 'deck', level: l });
      }
      for (i = 0; i < 25; i++) {
        if (s.board[i] !== 'gold') continue;
        for (var q = 0; q < sources.length; q++) out.push({ type: 'reserve', source: clone(sources[q]), goldCell: i });
      }
    }
    for (var lv = 1; lv <= 3; lv++) {
      for (var sl = 0; sl < s.pyramid[lv].length; sl++) {
        var id = s.pyramid[lv][sl];
        if (id) out.push.apply(out, buyOptions(pl, CARD_MAP[id], { from: 'pyramid', level: lv, slot: sl }));
      }
    }
    for (var ri = 0; ri < pl.reserved.length; ri++) {
      out.push.apply(out, buyOptions(pl, CARD_MAP[pl.reserved[ri].id], { from: 'reserved', index: ri }));
    }
    return out;
  }

  var SDEngine = {
    newGame: newGame,
    apply: apply,
    legalActions: legalActions,
    stats: stats,
    cardById: cardById,
    royalById: royalById,
    validateTake: validateTake,
    takeExtensions: takeExtensions,
    effectiveCost: effectiveCost,
    defaultPayment: defaultPayment,
    validatePayment: validatePayment,
    jokerOptions: jokerOptions,
    mainActionPossible: mainActionPossible,
    CONSTANTS: {
      COLORS: COLORS, TOKENS: TOKENS, SPIRAL: SPIRAL, PYRAMID_SIZES: PYRAMID_SIZES,
      MAX_TOKENS: MAX_TOKENS, MAX_RESERVED: MAX_RESERVED, PRIVILEGES: PRIVILEGES,
      ROYAL_CROWNS: ROYAL_CROWNS, WIN_POINTS: WIN_POINTS, WIN_CROWNS: WIN_CROWNS, WIN_COLOR_POINTS: WIN_COLOR_POINTS,
      LOG_MAX: LOG_MAX, TOKEN_NAMES_KO: TOKEN_NAMES_KO
    }
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = SDEngine;
  else window.SDEngine = SDEngine;
})();
