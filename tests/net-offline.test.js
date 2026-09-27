// SDNet 오프라인 테스트: 순수 함수 + 메모리 속 가짜 MQTT 브로커로 동기화 로직 검사 (네트워크 없음)
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const SDNet = require('../js/net.js');
const E = require('../js/engine.js');

const I = SDNet._internal;
const ROOM = 'ABC234';

function mkDoc(seq, nonce, extra) {
  return Object.assign({ app: 'sdkr1', room: ROOM, seq, nonce, by: 'x', at: 1, seats: [null, null], game: null, prevLoser: null }, extra);
}
// 올바른 모양의 게임 상태 (players 2명) + 구분용 값
const G = (x) => ({ players: [{}, {}], x });
const body = (x, extra) => Object.assign({ seats: [null, null], game: G(x), prevLoser: null }, extra);
const SEATS = [{ deviceId: 'a', name: 'A' }, { deviceId: 'b', name: 'B' }];

// ---------- 순수 함수 ----------

test('isNewer: seq 가 크면 새것, 같으면 nonce 로 결정', () => {
  assert.equal(I.isNewer(mkDoc(2, 'a'), mkDoc(1, 'z')), true);
  assert.equal(I.isNewer(mkDoc(1, 'z'), mkDoc(2, 'a')), false);
  assert.equal(I.isNewer(mkDoc(3, 'b'), mkDoc(3, 'a')), true);
  assert.equal(I.isNewer(mkDoc(3, 'a'), mkDoc(3, 'b')), false);
  assert.equal(I.isNewer(mkDoc(3, 'a'), mkDoc(3, 'a')), false, '같은 문서는 새것 아님');
  assert.equal(I.isNewer(mkDoc(1, 'a'), null), true);
  assert.equal(I.isNewer(null, mkDoc(1, 'a')), false);
  // 결정적: 두 기기가 같은 쌍을 보면 같은 쪽을 고름
  const x = mkDoc(5, '9f00'), y = mkDoc(5, 'a100');
  assert.notEqual(I.isNewer(x, y), I.isNewer(y, x));
  assert.equal(I.sameDoc(mkDoc(4, 'q'), mkDoc(4, 'q')), true);
  assert.equal(I.sameDoc(mkDoc(4, 'q'), mkDoc(4, 'r')), false);
});

test('lineage: 조상 목록(anc/parent)으로 이어받은 문서인지 판단', () => {
  const d3 = mkDoc(3, 'c', { parent: { seq: 2, nonce: 'b' }, anc: ['2:b', '1:a'] });
  const d4 = mkDoc(4, 'd', { parent: { seq: 3, nonce: 'c' }, anc: ['3:c', '2:b', '1:a'] });
  const y4 = mkDoc(4, 'y', { parent: { seq: 3, nonce: 'c' }, anc: ['3:c', '2:b', '1:a'] });
  const t5 = mkDoc(5, 't', { parent: { seq: 3, nonce: 'c' }, anc: ['3:c', '2:b', '1:a'] }); // jump 2
  assert.equal(I.lineage(d4, d3), 1);
  assert.equal(I.lineage(d4, d4), 1);
  assert.equal(I.lineage(y4, d4), 0, '같은 seq 다른 문서');
  assert.equal(I.lineage(t5, d4), 0, 'd4 를 건너뛴 문서 (4 를 지났는데 d4 가 조상에 없음)');
  assert.equal(I.lineage(t5, d3), 1);
  assert.equal(I.lineage(mkDoc(9, 'z'), d3), -1, '조상 정보 없는 예전 문서는 모름');
  assert.equal(I.lineage(mkDoc(9, 'z', { parent: null }), d3), 0, '첫 문서인데 seq 가 큼 → 다른 역사');
  assert.deepEqual(I.ancestorsOf(mkDoc(2, 'x', { parent: { seq: 1, nonce: 'p' } })), [{ seq: 1, nonce: 'p' }]);
  assert.deepEqual(I.ancestorsOf(mkDoc(2, 'x', { anc: ['bad', 7, '1:p'] })), [{ seq: 1, nonce: 'p' }]);
});

test('newRoomCode: 6글자, 헷갈리는 글자(0,O,1,I) 없음', () => {
  assert.equal(SDNet.ROOM_ALPHABET, 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789');
  const seen = new Set();
  for (let i = 0; i < 2000; i++) {
    const c = SDNet.newRoomCode();
    assert.equal(c.length, 6);
    assert.match(c, /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/);
    assert.equal(SDNet.isRoomCode(c), true);
    for (const ch of c) seen.add(ch);
  }
  assert.equal(seen.size, 32, '모든 글자가 나옴');
  assert.equal(SDNet.isRoomCode('ABCD1O'), false);
  assert.equal(SDNet.isRoomCode('ABC23'), false);
  assert.equal(SDNet.normalizeRoom(' abc-234 '), 'ABC234');
  assert.equal(SDNet.normalizeRoom('a/b+c#'), 'ABC');
});

test('parseDoc: 잘못된 JSON, 다른 앱/방, 지우기 표시, 너무 큰 것은 무시', () => {
  const good = JSON.stringify(mkDoc(1, 'n1'));
  assert.equal(I.parseDoc(good, ROOM).seq, 1);
  assert.equal(I.parseDoc(Buffer.from(good), ROOM).nonce, 'n1');
  assert.equal(I.parseDoc(new Uint8Array(Buffer.from(good)), ROOM).nonce, 'n1');
  assert.equal(I.parseDoc('{not json', ROOM), null);
  assert.equal(I.parseDoc('{}', ROOM), null);
  assert.equal(I.parseDoc('', ROOM), null);
  assert.equal(I.parseDoc(Buffer.alloc(0), ROOM), null);
  assert.equal(I.parseDoc('null', ROOM), null);
  assert.equal(I.parseDoc('[1,2]', ROOM), null);
  assert.equal(I.parseDoc(JSON.stringify(mkDoc(1, 'n', { app: 'other' })), ROOM), null);
  assert.equal(I.parseDoc(JSON.stringify(mkDoc(1, 'n', { room: 'ZZZ999' })), ROOM), null);
  assert.equal(I.parseDoc(JSON.stringify(mkDoc(0, 'n')), ROOM), null);
  assert.equal(I.parseDoc(JSON.stringify(mkDoc(1.5, 'n')), ROOM), null);
  assert.equal(I.parseDoc(JSON.stringify(mkDoc('2', 'n')), ROOM), null);
  assert.equal(I.parseDoc(JSON.stringify(mkDoc(2, '')), ROOM), null);
  assert.equal(I.parseDoc(JSON.stringify(mkDoc(2, 7)), ROOM), null);
  const big = JSON.stringify(mkDoc(1, 'n', { pad: 'x'.repeat(I.MAX_PAYLOAD) }));
  assert.equal(I.parseDoc(big, ROOM), null);
  assert.equal(I.parseDoc(Buffer.from(big), ROOM), null);
  const bigKo = JSON.stringify(mkDoc(1, 'n', { pad: '가'.repeat(80 * 1024) })); // 문자 수는 작아도 바이트는 큼
  assert.equal(I.parseDoc(bigKo, ROOM), null);
  const okKo = JSON.stringify(mkDoc(1, 'n', { name: '윤이', pad: 'x'.repeat(50 * 1024) }));
  assert.equal(I.parseDoc(Buffer.from(okKo), ROOM).name, '윤이');
});

test('validDoc: 방을 잠그거나 망가뜨리는 문서 거절 (seq 상한, seats/game 모양)', () => {
  const ok = (extra) => I.validDoc(mkDoc(3, 'n', extra), ROOM);
  assert.equal(ok({}), true);
  assert.equal(ok({ seats: SEATS, game: E.newGame({ names: ['A', 'B'], first: 0, seed: 1 }) }), true, '실제 게임 상태');
  // seq 상한
  assert.equal(I.validDoc(mkDoc(Number.MAX_SAFE_INTEGER, 'n'), ROOM), false, 'seq = 2^53-1');
  assert.equal(I.validDoc(mkDoc(1e9 + 1, 'n'), ROOM), false);
  assert.equal(I.validDoc(mkDoc(1e9, 'n'), ROOM), true);
  // seats
  assert.equal(ok({ seats: undefined }), false, 'seats 없음');
  assert.equal(ok({ seats: null }), false);
  assert.equal(ok({ seats: [null] }), false, '1칸');
  assert.equal(ok({ seats: [null, null, null] }), false, '3칸');
  assert.equal(ok({ seats: [7, null] }), false);
  assert.equal(ok({ seats: [{ deviceId: '', name: 'A' }, null] }), false, '빈 deviceId');
  assert.equal(ok({ seats: [{ deviceId: 'x'.repeat(65), name: 'A' }, null] }), false, 'deviceId 65자');
  assert.equal(ok({ seats: [{ deviceId: 'x'.repeat(64), name: 'A' }, null] }), true);
  assert.equal(ok({ seats: [{ deviceId: 'a', name: 'n'.repeat(25) }, null] }), false, '이름 25자');
  assert.equal(ok({ seats: [{ deviceId: 'a', name: 'n'.repeat(24) }, null] }), true);
  assert.equal(ok({ seats: [{ deviceId: 'a' }, null] }), false, '이름 없음');
  assert.equal(ok({ seats: [{ deviceId: 5, name: 'A' }, null] }), false);
  // game
  assert.equal(ok({ game: undefined }), false, 'game 없음');
  assert.equal(ok({ game: 'g1' }), false);
  assert.equal(ok({ game: [1, 2] }), false);
  assert.equal(ok({ game: {} }), false, 'players 없음');
  assert.equal(ok({ game: { players: [{}] } }), false, 'players 1명');
  assert.equal(ok({ game: { players: [{}, {}, {}] } }), false);
  assert.equal(ok({ game: G(1) }), true);
});

test('parsePresence / parseEmote / presenceFresh', () => {
  assert.deepEqual(I.parsePresence('{"online":true,"name":"A","seat":1,"at":5}'), { online: true, name: 'A', seat: 1, at: 5, seen: null });
  assert.deepEqual(I.parsePresence('{"online":true,"name":"A","seat":1,"at":5,"seen":{"seq":3,"nonce":"q"}}').seen, { seq: 3, nonce: 'q' });
  assert.equal(I.parsePresence('{"online":true,"at":5,"seen":{"seq":"3","nonce":"q"}}').seen, null);
  assert.equal(I.parsePresence('{}'), null);
  assert.equal(I.parsePresence('garbage'), undefined);
  assert.equal(I.parsePresence('{"name":"x"}'), undefined);
  assert.equal(I.parsePresence('{"online":false}').online, false);
  assert.equal(I.parsePresence('{"online":true,"seat":7,"at":1}').seat, null);
  assert.equal(I.parseEmote('{"from":"a","emote":"👍","at":1}').emote, '👍');
  assert.equal(I.parseEmote('{"from":"a","emote":""}'), null);
  assert.equal(I.parseEmote('{"emote":"hi"}'), null);
  assert.equal(I.parseEmote(JSON.stringify({ from: 'a', emote: 'x'.repeat(100) })), null);
  const now = 1_000_000;
  assert.equal(I.presenceFresh({ online: true, at: now - 10_000 }, now, 70_000), true);
  assert.equal(I.presenceFresh({ online: true, at: now - 71_000 }, now, 70_000), false);
  assert.equal(I.presenceFresh({ online: false, at: now }, now, 70_000), false);
  // 상대 시계가 2분 늦어도 실시간 신호로 추정한 차이로 보정
  assert.equal(I.presenceFresh({ online: true, at: now - 120_000 }, now, 70_000, 119_000), true);
});

test('brokerName / 기본 타이밍', () => {
  assert.deepEqual(SDNet.BROKERS.map(I.brokerName), ['emqx', 'coreflux', 'hivemq']);
  assert.equal(I.DEFAULT_TIMING.keepalive, 20);
});

test('join: 방 코드가 없으면 오류', () => {
  assert.throws(() => SDNet.join({ room: '', deviceId: 'a', mqtt: fakeMqtt({}) }));
});

// ---------- 가짜 MQTT 브로커 ----------

function topicMatch(pattern, topic) {
  const p = pattern.split('/'), t = topic.split('/');
  for (let i = 0; i < p.length; i++) {
    if (p[i] === '#') return true;
    if (i >= t.length) return false;
    if (p[i] !== '+' && p[i] !== t[i]) return false;
  }
  return p.length === t.length;
}

class FakeBroker {
  constructor(name) {
    this.name = name;
    this.mode = 'up'; // 'up' | 'down'(바로 실패) | 'hang'(응답 없음)
    this.connectDelay = 0; // 핸드셰이크(CONNACK) 까지 걸리는 시간
    this.ackDelay = 0; // PUBACK 이 늦게 오는 느린 브로커 흉내 (메시지 처리는 바로)
    this.noEcho = false; // true 면 보낸 클라이언트에게는 되돌려 주지 않음 (PUBACK 만으로 확인되는지 검사)
    this.retained = new Map();
    this.clients = new Set();
    this.log = []; // {topic, payload, retain}
    this.inflight = 0; // 진행 중인 연결 시도 수 (모든 클라이언트 합)
    this.maxInflight = 0;
  }
  _inflight(n) {
    this.inflight += n;
    this.maxInflight = Math.max(this.maxInflight, this.inflight);
  }
  publish(topic, payload, retain, from) {
    const text = Buffer.isBuffer(payload) ? payload.toString() : String(payload);
    this.log.push({ topic, payload: text, retain });
    if (retain) {
      if (text.length === 0) this.retained.delete(topic);
      else this.retained.set(topic, text);
    }
    for (const c of this.clients) if (!(this.noEcho && c === from)) c._deliver(topic, text, false);
  }
  docPublishes() {
    return this.log.filter((m) => m.topic.endsWith('/doc')).map((m) => JSON.parse(m.payload));
  }
  retainedDoc(room = ROOM) {
    const t = this.retained.get(`sdkr1/${room}/doc`);
    return t ? JSON.parse(t) : null;
  }
  presence(id, p) {
    this.publish(`sdkr1/${ROOM}/presence/${id}`, JSON.stringify(Object.assign({ online: true, name: id.toUpperCase(), seat: null, at: Date.now() }, p)), true);
  }
  // 네트워크 끊김 흉내: 모든 연결을 비정상 종료 (LWT 발송)
  dropAll() {
    for (const c of [...this.clients]) c._drop();
  }
}

// mqtt.js 5 를 흉내: reconnect() 는 진행 중인 시도를 닫지 않고 두 번째 시도를 시작하고, 두 시도가 모두 붙으면
// 브로커가 앞의 것을 끊음 (같은 clientId). end() 는 이미 disconnecting 이면 아무것도 안 함.
class FakeClient extends EventEmitter {
  constructor(broker, options, lib) {
    super();
    this.broker = broker;
    this.options = options;
    this.lib = lib;
    this.connected = false;
    this.disconnecting = false;
    this.reconnecting = false;
    this.zombie = false; // true: 연결된 것처럼 보이지만 아무것도 오가지 않음 (반쯤 열린 소켓)
    this.subs = [];
    this.timer = null;
    this.attempts = new Set();
    this.stream = { destroy: () => this._destroy() };
    setImmediate(() => this._attempt());
  }
  _attempt() {
    this.timer = null;
    if (this.disconnecting || this.connected) return;
    const b = this.broker;
    const att = {};
    this.attempts.add(att);
    if (b) b._inflight(1);
    const go = () => {
      if (!this.attempts.has(att)) return; // end() 로 취소됨
      this.attempts.delete(att);
      if (b) b._inflight(-1);
      if (this.disconnecting) return;
      if (!b || b.mode === 'down' || this.lib.offline) {
        this.emit('error', new Error('connect failed'));
        this.emit('close');
        this._scheduleReconnect();
        return;
      }
      if (b.mode === 'hang') {
        this._scheduleReconnect();
        return;
      }
      if (this.connected) {
        // 같은 clientId 로 두 번째 연결이 붙음 → 브로커가 앞의 연결을 끊음
        this._drop();
        return;
      }
      this.connected = true;
      this.reconnecting = false;
      this.subs = [];
      b.clients.add(this);
      this.emit('connect', {});
    };
    if (b && b.connectDelay) setTimeout(go, b.connectDelay);
    else go();
  }
  _scheduleReconnect() {
    if (this.disconnecting || this.timer) return;
    this.reconnecting = true;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.emit('reconnect');
      this._attempt();
    }, this.options.reconnectPeriod || 30);
  }
  _deliver(topic, text, retain) {
    if (!this.connected || this.zombie) return;
    if (!this.subs.some((s) => topicMatch(s, topic))) return;
    setImmediate(() => this.connected && !this.zombie && this.emit('message', topic, Buffer.from(text), { retain }));
  }
  subscribe(obj, cb) {
    if (this.zombie) return;
    setImmediate(() => {
      if (this.zombie) return;
      if (!this.connected || this.disconnecting) return cb && cb(new Error('not connected'));
      const topics = Object.keys(obj);
      this.subs.push(...topics);
      cb && cb(null, topics.map((t) => ({ topic: t, qos: obj[t].qos })));
      for (const [t, text] of this.broker.retained) if (topics.some((s) => topicMatch(s, t))) this._deliver(t, text, true);
    });
  }
  publish(topic, payload, opts, cb) {
    if (typeof opts === 'function') (cb = opts), (opts = {});
    if (this.zombie) return; // 보낸 것이 사라지고 PUBACK 도 없음
    if (this.disconnecting) return setImmediate(() => cb && cb(new Error('client disconnecting')));
    if (!this.connected) return setImmediate(() => cb && cb(new Error('not connected')));
    const b = this.broker;
    setImmediate(() => {
      b.publish(topic, payload, !!(opts && opts.retain), this);
      if (!cb) return;
      if (b.ackDelay) setTimeout(() => cb(null), b.ackDelay);
      else cb(null);
    });
  }
  _lost(sendWill) {
    const was = this.connected;
    this.connected = false;
    this.broker.clients.delete(this);
    if (was && sendWill && this.options.will) {
      const w = this.options.will;
      this.broker.publish(w.topic, w.payload, w.retain);
    }
  }
  _cancelAttempts() {
    for (const a of this.attempts) if (this.broker) this.broker._inflight(-1);
    this.attempts.clear();
  }
  _drop() {
    this._lost(true);
    this.emit('offline');
    this.emit('close');
    this._scheduleReconnect();
  }
  _destroy() {
    clearTimeout(this.timer);
    this.timer = null;
    this._cancelAttempts();
    if (!this.connected) return;
    this._lost(true);
    setImmediate(() => this.emit('close'));
  }
  end(force, opts, cb) {
    if (typeof force === 'function') (cb = force), (force = false);
    if (typeof opts === 'function') cb = opts;
    if (this.disconnecting) {
      if (cb) setImmediate(cb);
      return this; // mqtt.js 처럼: 이미 disconnecting 이면 아무것도 안 함 (소켓도 그대로)
    }
    this.disconnecting = true;
    clearTimeout(this.timer);
    this.timer = null;
    this._cancelAttempts();
    this._lost(!!force);
    setImmediate(() => {
      this.emit('close');
      cb && cb();
    });
    return this;
  }
  reconnect() {
    this.lib.reconnectCalls++;
    this.disconnecting = false;
    clearTimeout(this.timer);
    this.timer = null;
    this.emit('reconnect');
    setImmediate(() => this._attempt()); // 진행 중인 시도는 그대로 둠 (실제 mqtt.js 와 같음)
    return this;
  }
}

function fakeMqtt(map) {
  const lib = { clients: [], reconnectCalls: 0, offline: false };
  lib.connect = (url, options) => {
    const c = new FakeClient(map[url], options, lib);
    lib.clients.push(c);
    return c;
  };
  // 이 기기만 네트워크가 끊김 / 다시 붙음
  lib.goOffline = () => {
    lib.offline = true;
    for (const c of lib.clients) if (c.connected) c._drop();
  };
  lib.goOnline = () => {
    lib.offline = false;
  };
  return lib;
}

const URLS = ['wss://one/mqtt', 'wss://two/mqtt', 'wss://three/mqtt'];
const FAST = {
  healWait: 60,
  presenceEvery: 120,
  tick: 20,
  peerStale: 400,
  repushGap: 50,
  reconnectPeriod: 30,
  resumeDebounce: 30,
  resumeMinGap: 300,
  healthTimeout: 500,
  watchdogStale: 400,
  hiddenCheck: 100,
  announceDebounce: 20,
};

function net(brokers) {
  const map = {};
  URLS.forEach((u, i) => (map[u] = brokers[i]));
  return fakeMqtt(map);
}

function downBroker(name) {
  const b = new FakeBroker(name);
  b.mode = 'down';
  return b;
}

function memStorage(init) {
  const m = new Map(Object.entries(init || {}));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), map: m };
}

function fakeEnv() {
  const win = new EventTarget();
  const doc = new EventTarget();
  doc.visibilityState = 'visible';
  const fire = (t, name) => t.dispatchEvent(new Event(name));
  return {
    win,
    doc,
    online: () => fire(win, 'online'),
    pageshow: () => fire(win, 'pageshow'),
    visible: () => ((doc.visibilityState = 'visible'), fire(doc, 'visibilitychange')),
    hidden: () => ((doc.visibilityState = 'hidden'), fire(doc, 'visibilitychange')),
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 3000, what = 'condition') {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (fn()) return;
    await sleep(10);
  }
  assert.fail('시간 초과: ' + what);
}

function mkRoom(lib, deviceId, extra) {
  const r = { docs: [], peers: null, status: null, statusLog: [], emotes: [], conflicts: [], deliveries: [] };
  const x = Object.assign({}, extra);
  if (x.timing) x.timing = Object.assign({}, FAST, x.timing);
  r.h = SDNet.join(
    Object.assign(
      {
        room: ROOM,
        deviceId,
        name: deviceId.toUpperCase(),
        mqtt: lib,
        brokers: URLS,
        timing: FAST,
        storage: memStorage(),
        onDoc: (d, info) => r.docs.push({ d, source: info.source }),
        onPeers: (p) => (r.peers = p),
        onStatus: (s) => {
          r.status = s;
          r.statusLog.push(s);
        },
        onEmote: (e) => r.emotes.push(e),
        onConflict: (c) => r.conflicts.push(c),
        onDelivery: (d) => r.deliveries.push(d),
      },
      x
    )
  );
  allRooms.push(r);
  return r;
}

const allRooms = [];
test.after(() => Promise.all(allRooms.map((r) => r.h.leave())));

const connectedAll = (...rs) => rs.every((r) => r.status && r.status.connected === r.status.total && r.status.total > 0);
const readyAll = (...rs) => rs.every((r) => r.h._brokers().every((b) => b.ready));

// ---------- 가짜 브로커로 동작 검사 ----------

test('commit → 상대가 받음, 세 브로커 모두 retained, 로컬 저장', async () => {
  const b1 = new FakeBroker('1'), b2 = new FakeBroker('2'), b3 = new FakeBroker('3');
  const lib = net([b1, b2, b3]);
  const storeA = memStorage();
  const A = mkRoom(lib, 'a', { storage: storeA });
  const B = mkRoom(lib, 'b');
  await until(() => connectedAll(A, B), 3000, 'connect');
  assert.equal(A.status.total, 3, '세 브로커를 처음부터 모두 씀');
  await until(() => readyAll(A, B), 3000, 'healed');
  const d = A.h.commit({ seats: [{ deviceId: 'a', name: 'A' }, null], game: G({ hello: 1 }), prevLoser: null });
  assert.equal(d.seq, 1);
  assert.equal(d.by, 'a');
  assert.equal(d.app, 'sdkr1');
  assert.equal(d.room, ROOM);
  assert.equal(d.parent, null, '첫 문서의 parent 는 null');
  assert.equal(A.docs.at(-1).source, 'local');
  assert.equal(A.h.doc, d);
  assert.equal(JSON.parse(storeA.map.get('sd.room.' + ROOM)).nonce, d.nonce);
  await until(() => B.h.doc && B.h.doc.seq === 1, 3000, 'B receives');
  assert.equal(B.docs.at(-1).source, 'remote');
  assert.equal(B.docs.filter((x) => x.source === 'remote').length, 1, '세 브로커로 와도 한 번만 알림');
  for (const b of [b1, b2, b3]) assert.equal(b.retainedDoc().nonce, d.nonce);
  // B 가 seq 2
  const d2 = B.h.commit(Object.assign({}, B.h.doc, { game: G({ hello: 2 }) }));
  assert.equal(d2.seq, 2);
  assert.deepEqual(d2.parent, { seq: 1, nonce: d.nonce });
  assert.deepEqual(d2.anc, ['1:' + d.nonce]);
  await until(() => A.h.doc.seq === 2, 3000, 'A receives seq 2');
  assert.deepEqual(A.h.doc.game, G({ hello: 2 }));
  assert.equal(A.conflicts.length + B.conflicts.length, 0, '충돌 없음');
  await Promise.all([A.h.leave(), B.h.leave()]);
  for (const b of [b1, b2, b3]) for (const m of b.log) assert.ok(m.payload.length > 0, '빈 페이로드 금지');
});

test('commit: 잘못된 모양은 오류, jump 는 1..5', async () => {
  const lib = net([new FakeBroker('1'), new FakeBroker('2'), new FakeBroker('3')]);
  const A = mkRoom(lib, 'a');
  assert.throws(() => A.h.commit({ game: 'g1' }), /모양/);
  assert.equal(A.h.doc, null, '실패한 commit 은 흔적 없음');
  assert.equal(A.h.commit(body(1)).seq, 1);
  assert.equal(A.h.commit(body(2), { jump: 2 }).seq, 3);
  assert.equal(A.h.commit(body(3), { jump: 9 }).seq, 8, '최대 5');
  assert.equal(A.h.commit(body(4), { jump: 0 }).seq, 9, '최소 1');
  assert.equal(A.h.commit(body(5), { jump: 1.5 }).seq, 10, '정수가 아니면 1');
  await A.h.leave();
});

test('동시에 같은 seq 로 커밋해도 같은 문서로 수렴 (진 쪽은 superseded + onConflict)', async () => {
  const b1 = new FakeBroker('1'), b2 = new FakeBroker('2'), b3 = new FakeBroker('3');
  const lib = net([b1, b2, b3]);
  const A = mkRoom(lib, 'a', { seat: 0 });
  const B = mkRoom(lib, 'b', { seat: 1 });
  await until(() => connectedAll(A, B) && readyAll(A, B), 3000, 'connect');
  for (let round = 0; round < 5; round++) {
    const base = A.h.doc ? A.h.doc.seq : 0;
    const ca = A.conflicts.length, cb = B.conflicts.length;
    const da = A.h.commit(body({ who: 'A', round }));
    const db = B.h.commit(body({ who: 'B', round }));
    await until(() => A.h.doc.seq === base + 1 && B.h.doc.seq === base + 1 && A.h.doc.nonce === B.h.doc.nonce, 3000, 'converge');
    await sleep(150);
    assert.equal(A.h.doc.nonce, B.h.doc.nonce);
    for (const b of [b1, b2, b3]) assert.equal(b.retainedDoc().nonce, A.h.doc.nonce, `broker ${b.name} healed to winner`);
    const [W, L, dw, dl, cl] = da.nonce > db.nonce ? [A, B, da, db, cb] : [B, A, db, da, ca];
    assert.equal(W.h.doc.nonce, dw.nonce);
    // 진 쪽: superseded + onConflict({lost:[내 것], winner})
    assert.equal(L.h.delivery.state, 'superseded');
    assert.equal(L.conflicts.length, cl + 1, '진 쪽에 onConflict 한 번');
    assert.deepEqual(L.conflicts.at(-1).lost.map((x) => x.nonce), [dl.nonce]);
    assert.equal(L.conflicts.at(-1).winner.nonce, dw.nonce);
    assert.ok(L.deliveries.some((x) => x.nonce === dl.nonce && x.state === 'superseded'), 'onDelivery 로도 알림');
    // 이긴 쪽: 진 쪽이 받아서 seen 으로 알려 주면 delivered
    await until(() => W.h.delivery.state === 'delivered', 3000, 'winner delivered');
  }
  await Promise.all([A.h.leave(), B.h.leave()]);
});

test('느린 브로커의 늦은 PUBACK 이 진 커밋을 relayed 로 되돌리지 않고, 그 브로커를 승자로 고침', async () => {
  const b1 = new FakeBroker('1'), b2 = new FakeBroker('2'), b3 = new FakeBroker('3');
  b3.ackDelay = 250; // 실제 hivemq 처럼 느림
  const lib = net([b1, b2, b3]);
  const A = mkRoom(lib, 'a', { seat: 0 });
  const B = mkRoom(lib, 'b', { seat: 1 });
  await until(() => connectedAll(A, B) && readyAll(A, B), 3000, 'connect');
  for (let round = 0; round < 3; round++) {
    const da = A.h.commit(body({ who: 'A', round }));
    const db = B.h.commit(body({ who: 'B', round }));
    const [W, L, dw, dl] = da.nonce > db.nonce ? [A, B, da, db] : [B, A, db, da];
    await until(() => A.h.doc.nonce === dw.nonce && B.h.doc.nonce === dw.nonce, 3000, 'converge');
    await sleep(b3.ackDelay + 200); // 진 커밋의 늦은 PUBACK 이 도착
    assert.equal(L.h.delivery.nonce, dl.nonce);
    assert.equal(L.h.delivery.state, 'superseded', '늦은 PUBACK 으로 relayed 가 되면 안 됨');
    assert.equal(W.h.delivery.state === 'superseded', false);
    for (const b of [b1, b2, b3]) await until(() => b.retainedDoc().nonce === dw.nonce, 3000, 'broker ' + b.name + ' = winner');
  }
  await Promise.all([A.h.leave(), B.h.leave()]);
});

test('캐시 먼저 → 브로커가 옛것이면 우리 것을 다시 올림 (self-healing)', async () => {
  const b1 = new FakeBroker('1'), b2 = new FakeBroker('2'), b3 = new FakeBroker('3');
  b1.retained.set(`sdkr1/${ROOM}/doc`, JSON.stringify(mkDoc(2, 'old')));
  // b2, b3 에는 문서가 없음
  const lib = net([b1, b2, b3]);
  const cached = mkDoc(7, 'cached', { game: G(1) });
  const A = mkRoom(lib, 'a', { storage: memStorage({ ['sd.room.' + ROOM]: JSON.stringify(cached) }) });
  assert.equal(A.h.doc.seq, 7, 'join 직후 캐시가 room.doc');
  await sleep(0);
  assert.equal(A.docs[0].source, 'cache');
  await until(() => [b1, b2, b3].every((b) => b.retainedDoc() && b.retainedDoc().seq === 7), 3000, 'heal all');
  assert.equal(A.docs.length, 1, '옛 문서로 바뀌지 않음');
  assert.equal(A.conflicts.length, 0);
  // 옛 캐시(seq 1)는 브로커 문서에 밀림
  const B = mkRoom(lib, 'b', { storage: memStorage({ ['sd.room.' + ROOM]: JSON.stringify(mkDoc(1, 'zzz')) }) });
  await until(() => B.h.doc.seq === 7, 3000, 'B takes broker doc');
  assert.deepEqual(B.docs.map((x) => x.source), ['cache', 'remote']);
  await sleep(150);
  for (const b of [b1, b2, b3]) assert.equal(b.retainedDoc().seq, 7, '옛 캐시가 브로커를 덮지 않음');
  assert.equal(b1.docPublishes().filter((d) => d.seq === 1).length, 0);
  await Promise.all([A.h.leave(), B.h.leave()]);
});

test('망가진 저장소(localStorage 예외)도 괜찮음', async () => {
  const lib = net([new FakeBroker('1'), new FakeBroker('2'), new FakeBroker('3')]);
  const bad = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('full'); } };
  const A = mkRoom(lib, 'a', { storage: bad });
  const B = mkRoom(lib, 'b', { storage: null });
  await until(() => connectedAll(A, B), 3000, 'connect');
  A.h.commit(body(1)); // 연결 직후 (retained 확인 전) 커밋 → 확인 뒤 올라감
  await until(() => B.h.doc && B.h.doc.seq === 1, 3000, 'recv');
  await Promise.all([A.h.leave(), B.h.leave()]);
});

test('한 브로커만 새 문서를 알면 다른 브로커로 옮겨 줌', async () => {
  const b1 = new FakeBroker('1'), b2 = new FakeBroker('2'), b3 = new FakeBroker('3');
  const lib = net([b1, b2, b3]);
  const A = mkRoom(lib, 'a');
  await until(() => connectedAll(A) && readyAll(A), 3000, 'connect');
  // 누군가 b1 에만 seq 4 를 올림 (예: 그쪽만 붙어 있던 상대)
  b1.publish(`sdkr1/${ROOM}/doc`, JSON.stringify(mkDoc(4, 'only1')), true);
  await until(() => A.h.doc && A.h.doc.seq === 4, 3000, 'A gets it');
  await until(() => [b2, b3].every((b) => b.retainedDoc() && b.retainedDoc().nonce === 'only1'), 3000, 'relayed to b2, b3');
  await A.h.leave();
});

test('옛 seq, 잘못된 문서, 지우기 표시는 무시하고 브로커를 고침', async () => {
  const b1 = new FakeBroker('1'), b2 = new FakeBroker('2');
  const lib = net([b1, b2, new FakeBroker('3')]);
  const A = mkRoom(lib, 'a');
  await until(() => connectedAll(A) && readyAll(A), 3000, 'connect');
  A.h.commit(body('g1'));
  A.h.commit(body('g2'));
  A.h.commit(body('g3'));
  await until(() => b1.retainedDoc() && b1.retainedDoc().seq === 3, 3000, 'published');
  const n = A.docs.length;
  const T = `sdkr1/${ROOM}/doc`;
  await sleep(80);
  b1.publish(T, JSON.stringify(mkDoc(2, 'zzzz')), true);
  b2.publish(T, '{broken', true);
  b2.publish(T, JSON.stringify(mkDoc(99, 'x', { room: 'OTHER1' })), true);
  b2.publish(T, JSON.stringify(mkDoc(99, 'x', { app: 'nope' })), true);
  b2.publish(T, JSON.stringify(mkDoc(99, 'x', { seats: [null] })), true);
  b2.publish(T, JSON.stringify(mkDoc(99, 'x', { game: 'bad' })), true);
  b2.publish(T, JSON.stringify(mkDoc(Number.MAX_SAFE_INTEGER, 'x')), true);
  b2.publish(T, '{}', true);
  await sleep(200);
  assert.equal(A.docs.length, n, '어떤 것도 받아들이지 않음');
  assert.equal(A.h.doc.seq, 3);
  assert.equal(b1.retainedDoc().seq, 3, 'stale 문서를 우리 것으로 덮음');
  await A.h.leave();
});

test('seq 가 500 넘게 앞선 문서는 무시 (방 잠그기 방지), 캐시가 오래됐으면 받아들임', async () => {
  const b1 = new FakeBroker('1');
  const lib = net([b1, downBroker('2'), downBroker('3')]);
  const A = mkRoom(lib, 'a');
    await until(() => A.h._brokers()[0].ready, 3000, 'ready');
  const d1 = A.h.commit(body(1));
  await until(() => b1.retainedDoc() && b1.retainedDoc().seq === 1, 3000, 'published');
  const T = `sdkr1/${ROOM}/doc`;
  b1.publish(T, JSON.stringify(mkDoc(1e9, 'lock')), true);
  b1.publish(T, JSON.stringify(mkDoc(d1.seq + 501, 'far')), true);
  await sleep(150);
  assert.equal(A.h.doc.nonce, d1.nonce, '너무 앞선 문서는 받지 않음');
  // 커밋은 계속 됨 (1e9 위로 올라가서 막히지 않음)
  const d2 = A.h.commit(body(2));
  assert.equal(d2.seq, 2);
  await until(() => b1.retainedDoc().nonce === d2.nonce, 3000, 'commit still works');
  b1.publish(T, JSON.stringify(mkDoc(d2.seq + 500, 'near')), true);
  await until(() => A.h.doc.nonce === 'near', 3000, '+500 까지는 받음');
  await A.h.leave();
  // 하루 넘게 묵은 캐시는 많이 앞선 진짜 문서를 받아들임
  const c1 = new FakeBroker('1');
  c1.retained.set(T, JSON.stringify(mkDoc(900, 'real', { at: Date.now() })));
  const B = mkRoom(net([c1, downBroker('2'), downBroker('3')]), 'b', {
    storage: memStorage({ ['sd.room.' + ROOM]: JSON.stringify(mkDoc(3, 'old', { at: Date.now() - 2 * 86400e3 })) }),
  });
  await until(() => B.h.doc.nonce === 'real', 3000, 'stale cache accepts far-ahead doc');
  await B.h.leave();
});

test('세 브로커를 처음부터 모두 씀: #1 이 죽어도, #1/#2 를 잃어도 #3 으로 계속', async () => {
  {
    const b1 = downBroker('1'), b2 = new FakeBroker('2'), b3 = new FakeBroker('3');
    const lib = net([b1, b2, b3]);
    const A = mkRoom(lib, 'a');
    assert.equal(lib.clients.length, 3, 'join 하자마자 세 클라이언트');
    assert.equal(A.h.status.total, 3);
    assert.deepEqual(A.h.status.brokers.map((b) => b.name), ['one', 'two', 'three']);
    await until(() => A.status && A.status.total === 3 && A.status.connected === 2, 3000, '#2, #3 connected');
    assert.equal(A.status.brokers[0].state, 'offline');
    assert.equal(A.status.brokers[2].url, URLS[2]);
    await A.h.leave();
  }
  {
    const b1 = new FakeBroker('1'), b2 = new FakeBroker('2'), b3 = new FakeBroker('3');
    const lib = net([b1, b2, b3]);
    const A = mkRoom(lib, 'a', { seat: 0 });
    const B = mkRoom(lib, 'b', { seat: 1 });
    await until(() => connectedAll(A, B) && readyAll(A, B), 3000, 'all up');
    await until(() => A.peers && A.peers.b && A.peers.b.online, 3000, 'A sees B');
    const ids = Object.keys(A.peers);
    assert.deepEqual(ids.sort(), ['a', 'b'], '세 브로커로 와도 접속 표시는 기기당 하나');
    // #1, #2 가 동시에 죽음
    b1.mode = b2.mode = 'down';
    b1.dropAll();
    b2.dropAll();
    await until(() => A.status.connected === 1 && B.status.connected === 1, 3000, 'only #3 left');
    assert.equal(A.status.brokers[2].state, 'connected');
    const d = A.h.commit(body('via3'));
    await until(() => B.h.doc && B.h.doc.nonce === d.nonce, 3000, 'B gets it via #3');
    assert.equal(b3.retainedDoc().nonce, d.nonce);
    await until(() => A.h.delivery.state === 'delivered', 3000, 'delivered via #3');
    A.h.emote('💎');
    await until(() => B.emotes.length === 1, 3000, 'emote via #3');
    assert.equal(B.peers.a.online, true, '#1/#2 의 LWT 가 와도 #3 으로 온라인');
    await Promise.all([A.h.leave(), B.h.leave()]);
  }
});

test('연결이 없을 때 커밋 → 다시 붙으면 올림 (상대의 더 새 문서는 덮지 않음)', async () => {
  const b1 = downBroker('1'), b2 = downBroker('2'), b3 = downBroker('3');
  const A = mkRoom(net([b1, b2, b3]), 'a');
  await sleep(80);
  const d = A.h.commit(body('offline'));
  assert.equal(A.h.doc, d);
  assert.equal(A.h.delivery.state, 'pending');
  await sleep(50);
  b1.mode = 'up';
  b2.mode = 'up';
  await until(() => b1.retainedDoc() && b2.retainedDoc(), 3000, 'published after reconnect');
  assert.equal(b1.retainedDoc().nonce, d.nonce);
  await until(() => A.h.delivery.state === 'relayed', 3000, 'relayed');
  // 상대가 그사이 더 새 문서를 올려 둔 경우
  await A.h.leave();
  const c1 = downBroker('1'), c2 = downBroker('2'), c3 = downBroker('3');
  const newer = mkDoc(5, 'peer');
  c1.retained.set(`sdkr1/${ROOM}/doc`, JSON.stringify(newer));
  const B = mkRoom(net([c1, c2, c3]), 'b');
  await sleep(50);
  B.h.commit(body('mine')); // seq 1
  c1.mode = c2.mode = c3.mode = 'up';
  await until(() => B.h.doc.seq === 5, 3000, 'takes newer');
  await until(() => [c2, c3].every((c) => c.retainedDoc() && c.retainedDoc().nonce === 'peer'), 3000, 'relays newer to c2, c3');
  await sleep(150);
  assert.equal(c1.retainedDoc().nonce, 'peer', '옛 커밋으로 덮지 않음');
  for (const c of [c1, c2, c3]) assert.equal(c.docPublishes().filter((x) => x.by === 'b').length, 0, '내 옛 커밋은 어디에도 안 올라감');
  assert.equal(B.conflicts.length, 1, '버려진 커밋을 알림');
  assert.equal(B.h.delivery.state, 'superseded');
  await B.h.leave();
});

test('오프라인 가지: 상대의 기권(seq 4) 이 있으면 내 오프라인 커밋(seq 4, 5)은 버리고 기권을 따름', async () => {
  const b1 = new FakeBroker('1'), b2 = new FakeBroker('2'), b3 = new FakeBroker('3');
  const libX = net([b1, b2, b3]);
  const libY = net([b1, b2, b3]);
  const storeX = memStorage();
  const X = mkRoom(libX, 'x', { seat: 0, storage: storeX });
  const Y = mkRoom(libY, 'y', { seat: 1 });
  await until(() => connectedAll(X, Y) && readyAll(X, Y), 3000, 'connect');
  const seats = [{ deviceId: 'x', name: 'X' }, { deviceId: 'y', name: 'Y' }];
  for (let i = 1; i <= 3; i++) {
    const R = i % 2 ? X : Y;
    R.h.commit(body('move' + i, { seats }));
    await until(() => X.h.doc && Y.h.doc && X.h.doc.seq === i && Y.h.doc.seq === i && X.h.doc.nonce === Y.h.doc.nonce, 3000, 'seq ' + i);
  }
  await until(() => X.h.delivery && X.h.delivery.state !== 'pending', 3000, 'X seq3 confirmed');
  // X 만 네트워크가 끊김
  libX.goOffline();
  await until(() => X.status.connected === 0, 3000, 'X offline');
  assert.equal(X.h.synced, false, '모두 끊기면 synced=false');
  const resign = Y.h.commit(body('resign', { seats }));
  assert.equal(resign.seq, 4);
  const x4 = X.h.commit(body('x-offline-4', { seats }));
  const x5 = X.h.commit(body('x-offline-5', { seats }));
  assert.equal(x5.seq, 5);
  await sleep(50);
  libX.goOnline();
  await until(() => X.h.doc.nonce === resign.nonce, 3000, 'X adopts the resign even though its seq is lower');
  assert.equal(X.docs.at(-1).source, 'remote');
  assert.equal(X.conflicts.length, 1);
  assert.deepEqual(X.conflicts[0].lost.map((d) => d.nonce), [x4.nonce, x5.nonce], 'lost = 버린 가지 (오래된 것부터)');
  assert.equal(X.conflicts[0].winner.nonce, resign.nonce);
  assert.equal(X.h.delivery.state, 'superseded');
  await sleep(250);
  assert.equal(Y.h.doc.nonce, resign.nonce, 'Y 도 기권 그대로');
  for (const b of [b1, b2, b3]) {
    assert.equal(b.retainedDoc().nonce, resign.nonce);
    assert.equal(b.docPublishes().filter((d) => d.nonce === x4.nonce || d.nonce === x5.nonce).length, 0, '버린 커밋은 올라가지 않음');
  }
  assert.equal(Y.conflicts.length, 0);
  // X 가 다시 둔 수는 정상적으로 기권 위에 이어짐
  const x5b = X.h.commit(body('after', { seats }));
  assert.deepEqual(x5b.parent, { seq: 4, nonce: resign.nonce });
  await until(() => Y.h.doc.nonce === x5b.nonce, 3000, 'Y receives');
  await Promise.all([X.h.leave(), Y.h.leave()]);
});

test('오프라인 가지는 새로고침(다시 join) 해도 기억해서 버림', async () => {
  const b1 = new FakeBroker('1'), b2 = new FakeBroker('2'), b3 = new FakeBroker('3');
  const libX = net([b1, b2, b3]);
  const storeX = memStorage();
  const X = mkRoom(libX, 'x', { storage: storeX });
  const Y = mkRoom(net([b1, b2, b3]), 'y');
  await until(() => connectedAll(X, Y) && readyAll(X, Y), 3000, 'connect');
  X.h.commit(body(1));
  await until(() => Y.h.doc && Y.h.doc.seq === 1 && X.h.delivery.state !== 'pending', 3000, 'seq1');
  libX.goOffline();
  await until(() => X.status.connected === 0, 3000, 'X offline');
  const y2 = Y.h.commit(body('y2'));
  const x2 = X.h.commit(body('x2-offline'));
  await X.h.leave();
  // 오프라인 상태에서 새로고침
  const X2 = mkRoom(libX, 'x', { storage: storeX });
  assert.equal(X2.h.doc.nonce, x2.nonce, '캐시');
  assert.equal(X2.h.delivery.state, 'pending', '확인 안 된 커밋이 있으면 pending');
  libX.goOnline();
  await until(() => X2.h.doc.nonce === y2.nonce, 3000, 'Y 의 커밋이 이김 (내 것은 확인 전이었음)');
  assert.equal(X2.conflicts.length, 1);
  assert.equal(X2.conflicts[0].lost.at(-1).nonce, x2.nonce);
  await sleep(150);
  for (const b of [b1, b2, b3]) assert.equal(b.retainedDoc().nonce, y2.nonce);
  await Promise.all([X2.h.leave(), Y.h.leave()]);
});

test('자리 이어받기(jump 2)는 옛 폰이 동시에 둔 seq+1 을 이김', async () => {
  const b1 = new FakeBroker('1'), b2 = new FakeBroker('2'), b3 = new FakeBroker('3');
  const lib = net([b1, b2, b3]);
  const OLD = mkRoom(lib, 'old', { seat: 0 });
  const NEW = mkRoom(lib, 'new');
  const Y = mkRoom(lib, 'y', { seat: 1 });
  await until(() => connectedAll(OLD, NEW, Y) && readyAll(OLD, NEW, Y), 3000, 'connect');
  const seats = [{ deviceId: 'old', name: 'X' }, { deviceId: 'y', name: 'Y' }];
  const base = OLD.h.commit(body('start', { seats }));
  await until(() => NEW.h.doc && Y.h.doc && NEW.h.doc.nonce === base.nonce && Y.h.doc.nonce === base.nonce, 3000, 'base');
  // 같은 순간: 옛 폰은 수를 두고(seq+1), 새 폰은 자리를 이어받음(jump 2 → seq+2)
  const stale = OLD.h.commit(body('old-move', { seats }));
  const take = NEW.h.commit(body('start', { seats: [{ deviceId: 'new', name: 'X' }, seats[1]] }), { jump: 2 });
  assert.equal(stale.seq, base.seq + 1);
  assert.equal(take.seq, base.seq + 2);
  await until(() => [OLD, NEW, Y].every((r) => r.h.doc.nonce === take.nonce), 3000, 'all on takeover');
  for (const b of [b1, b2, b3]) await until(() => b.retainedDoc().nonce === take.nonce, 3000, 'broker ' + b.name);
  assert.equal(OLD.conflicts.length, 1, '옛 폰에 알림');
  assert.deepEqual(OLD.conflicts[0].lost.map((d) => d.nonce), [stale.nonce]);
  assert.equal(OLD.h.delivery.state, 'superseded');
  assert.equal(NEW.conflicts.length, 0);
  await Promise.all([OLD.h.leave(), NEW.h.leave(), Y.h.leave()]);
});

test('delivery: pending → relayed(PUBACK) → delivered(상대 presence seen)', async () => {
  const bs = [new FakeBroker('1'), new FakeBroker('2'), new FakeBroker('3')];
  for (const b of bs) b.noEcho = true; // 되돌아오는 메시지 없이 PUBACK 만으로 relayed 가 되는지
  const [b1] = bs;
  const lib = net(bs);
  const A = mkRoom(lib, 'a', { seat: 0 });
  await until(() => connectedAll(A) && readyAll(A), 3000, 'connect');
  assert.equal(A.h.delivery, null);
  const d = A.h.commit(body(1, { seats: SEATS }));
  assert.deepEqual(A.h.delivery && { seq: A.h.delivery.seq, nonce: A.h.delivery.nonce, state: A.h.delivery.state }, { seq: d.seq, nonce: d.nonce, state: 'pending' });
  await until(() => A.h.delivery.state === 'relayed', 3000, 'relayed on PUBACK');
  assert.equal(typeof A.h.delivery.since, 'number');
  // 옛 문서를 본 상대, 내 자리(0)의 다른 기기, 자리 없는 구경꾼은 delivered 가 아님
  b1.presence('b', { seat: 1, seen: { seq: 0 + 1, nonce: 'other' } });
  b1.presence('a2', { seat: 0, seen: { seq: d.seq, nonce: d.nonce } });
  b1.presence('watcher', { seat: null, seen: { seq: d.seq, nonce: d.nonce } });
  await sleep(100);
  assert.equal(A.h.delivery.state, 'relayed');
  // 상대(1번 자리)가 이 문서를 가졌다고 알림
  b1.presence('b', { seat: 1, seen: { seq: d.seq, nonce: d.nonce } });
  await until(() => A.h.delivery.state === 'delivered', 3000, 'delivered');
  assert.deepEqual(A.deliveries.map((x) => x.state), ['pending', 'relayed', 'delivered']);
  assert.deepEqual(A.peers.b.seen, { seq: d.seq, nonce: d.nonce }, 'peers 에도 seen');
  // 실제 상대 기기: 받으면 presence seen 을 다시 알림
  const B = mkRoom(lib, 'b', { seat: 1 });
  const d2 = A.h.commit(body(2, { seats: SEATS }));
  await until(() => B.h.doc && B.h.doc.nonce === d2.nonce, 3000, 'B receives');
  await until(() => A.h.delivery.state === 'delivered' && A.h.delivery.nonce === d2.nonce, 3000, 'delivered by real peer');
  await until(() => JSON.parse(b1.retained.get(`sdkr1/${ROOM}/presence/b`)).seen.nonce === d2.nonce, 3000, 'B presence seen');
  await Promise.all([A.h.leave(), B.h.leave()]);
});

test('delivery: 상대가 없는 브로커에서만 확인되면 relayed 에 머묾 (delivered 아님)', async () => {
  const b1 = new FakeBroker('1'), b2 = new FakeBroker('2'), b3 = new FakeBroker('3');
  const A = mkRoom(net([b1, downBroker('x2'), downBroker('x3')]), 'a', { seat: 0 }); // A 는 #1 에만
  const B = mkRoom(net([downBroker('y1'), b2, b3]), 'b', { seat: 1 }); // B 는 #2, #3 에만
  await until(() => A.status && A.status.connected === 1 && B.status && B.status.connected === 2, 3000, 'connect');
  await until(() => A.h._brokers()[0].ready, 3000, 'A ready');
  const d = A.h.commit(body(1, { seats: SEATS }));
  await until(() => A.h.delivery.state === 'relayed', 3000, 'relayed');
  // B 의 오래된 접속 표시가 #1 에 남아 있음 (seen 은 옛것)
  b1.presence('b', { seat: 1, seen: null });
  await sleep(400);
  assert.equal(A.h.delivery.state, 'relayed', '보냈지만 상대가 받았다는 증거 없음');
  assert.equal(B.h.doc, null);
  assert.ok(!A.deliveries.some((x) => x.nonce === d.nonce && x.state === 'delivered'));
  await Promise.all([A.h.leave(), B.h.leave()]);
});

test('presence: 접속, 이름/자리, LWT 로 오프라인, 오래되면 오프라인, leave', async () => {
  const b1 = new FakeBroker('1'), b2 = new FakeBroker('2');
  const lib = net([b1, b2, new FakeBroker('3')]);
  // presenceEvery(120) 대비 peerStale 을 넉넉히 (부하가 커도 흔들리지 않게)
  const timing = { peerStale: 1200 };
  const A = mkRoom(lib, 'a', { seat: 0, timing });
  const B = mkRoom(lib, 'b', { timing });
  await until(() => B.peers && B.peers.a && B.peers.a.online, 3000, 'B sees A');
  assert.equal(B.peers.a.name, 'A');
  assert.equal(B.peers.a.seat, 0);
  assert.equal(B.peers.a.self, false);
  assert.equal(B.peers.b.self, true);
  assert.equal(B.peers.b.online, true);
  A.h.setPresence({ name: '에이', seat: 1 });
  await until(() => B.peers.a.name === '에이' && B.peers.a.seat === 1, 3000, 'rename');
  // 한 브로커만 끊겨도 다른 브로커로 여전히 온라인
  for (const c of [...b1.clients]) if (c.options.will.topic.endsWith('/a')) c._drop();
  await sleep(60);
  assert.equal(B.peers.a.online, true, '한 브로커 LWT 만으로는 오프라인 아님');
  await until(() => A.status.connected === 3, 3000, 'A reconnects');
  // 비정상 종료 → 모든 브로커에서 LWT
  A.h._crash();
  await until(() => B.peers.a.online === false, 3000, 'LWT offline');
  assert.equal(B.peers.a.name, '에이', 'LWT 에도 이름이 남음');
  // presence 가 멈춘 기기: online:true 로 남아 있지만 at 이 오래됨 (retained 로 받음)
  const T = `sdkr1/${ROOM}/presence/ghost`;
  b1.retained.set(T, JSON.stringify({ online: true, name: 'G', seat: null, at: Date.now() - 10_000 }));
  const E2 = mkRoom(lib, 'e', { timing });
  await until(() => E2.peers && E2.peers.ghost && E2.peers.b && E2.peers.b.online, 3000, 'E sees ghost + B');
  assert.equal(E2.peers.ghost.online, false, 'peerStale 보다 오래된 at');
  await E2.h.leave();
  const C = mkRoom(lib, 'c', { timing });
  await until(() => B.peers.c && B.peers.c.online, 3000, 'C online');
  await C.h.leave();
  await until(() => B.peers.c.online === false, 3000, 'C offline after leave');
  assert.equal(JSON.parse(b1.retained.get(`sdkr1/${ROOM}/presence/c`)).online, false);
  // 신호가 멈추면 peerStale 뒤 오프라인 (소켓은 붙어 있는 것처럼 보이지만 아무것도 안 나감)
  const D = mkRoom(lib, 'd', { timing });
  await until(() => B.peers.d && B.peers.d.online, 3000, 'D online');
  for (const c of lib.clients) if (c.options.will.topic.endsWith('/d')) c.zombie = true;
  await until(() => B.peers.d.online === false, 3 * timing.peerStale + 3000, 'stale → offline');
  D.h._crash(); // 소켓이 죽어 있어 leave 의 오프라인 알림은 3초 기다리게 됨
  await B.h.leave();
});

test('예전 연결의 LWT 가 나를 오프라인으로 덮으면 다시 알림', async () => {
  const b1 = new FakeBroker('1'), b2 = new FakeBroker('2');
  const lib = net([b1, b2, new FakeBroker('3')]);
  const A = mkRoom(lib, 'a');
  await until(() => connectedAll(A), 3000, 'connect');
  await sleep(30);
  const T = `sdkr1/${ROOM}/presence/a`;
  b1.publish(T, JSON.stringify({ online: false, name: 'A', seat: null, at: 1 }), true);
  await until(() => JSON.parse(b1.retained.get(T)).online === true, 3000, 're-announced');
  await A.h.leave();
});

test('emote: 세 브로커로 와도 한 번, 내 것은 무시', async () => {
  const b1 = new FakeBroker('1'), b2 = new FakeBroker('2'), b3 = new FakeBroker('3');
  const lib = net([b1, b2, b3]);
  const A = mkRoom(lib, 'a');
  const B = mkRoom(lib, 'b');
  await until(() => connectedAll(A, B), 3000, 'connect');
  await sleep(30);
  A.h.emote('👍');
  A.h.emote('');
  await until(() => B.emotes.length === 1, 3000, 'emote');
  await sleep(60);
  assert.equal(B.emotes.length, 1);
  assert.equal(B.emotes[0].from, 'a');
  assert.equal(B.emotes[0].emote, '👍');
  assert.equal(typeof B.emotes[0].at, 'number');
  assert.equal(A.emotes.length, 0);
  for (const b of [b1, b2, b3]) {
    const em = b.log.filter((m) => m.topic.endsWith('/emote'));
    assert.equal(em.length, 1, '모든 브로커에 한 번씩');
    assert.equal(em[0].retain, false);
  }
  await Promise.all([A.h.leave(), B.h.leave()]);
});

test('resume: 끊긴 클라이언트를 새로 만들어 연결하고 접속을 다시 알림', async () => {
  const b1 = new FakeBroker('1'), b2 = new FakeBroker('2');
  const lib = net([b1, b2, new FakeBroker('3')]);
  const A = mkRoom(lib, 'a', { timing: { reconnectPeriod: 60_000 } });
  await until(() => connectedAll(A), 3000, 'connect');
  b1.dropAll();
  await until(() => A.status.connected === 2, 3000, 'dropped');
  const before = b2.log.filter((m) => m.topic.endsWith('/presence/a')).length;
  A.h.resume();
  await until(() => A.status.connected === 3, 3000, 'reconnected by resume');
  assert.ok(b2.log.filter((m) => m.topic.endsWith('/presence/a')).length > before, 're-announced on b2');
  assert.equal(lib.reconnectCalls, 0, 'reconnect() 는 쓰지 않음');
  await A.h.leave();
});

test('resume: 핸드셰이크 중에는 건드리지 않음 — reconnect() 없음, 브로커당 동시 시도 ≤ 1', async () => {
  const bs = [new FakeBroker('1'), new FakeBroker('2'), new FakeBroker('3')];
  for (const b of bs) b.connectDelay = 250;
  const env = fakeEnv();
  const lib = net(bs);
  // resume 만 검사: 부하로 타이머가 늦어져도 watchdog/상태 확인이 끼어들지 않게 넉넉히
  const A = mkRoom(lib, 'a', { _window: env.win, _document: env.doc, timing: { resumeMinGap: 0, healthTimeout: 5000, watchdogStale: 60_000 } });
  // 새로고침 직후처럼: pageshow/online/visibilitychange 가 연결 도중에 여러 번
  for (let i = 0; i < 4; i++) {
    env.pageshow();
    env.online();
    env.visible();
    A.h.resume();
    await sleep(60);
  }
  await until(() => connectedAll(A), 3000, 'connect');
  assert.equal(lib.reconnectCalls, 0, 'reconnect() 호출 없음');
  assert.equal(lib.clients.length, 3, '진행 중인 시도를 버리고 새로 만들지 않음');
  for (const b of bs) assert.ok(b.maxInflight <= 1, `broker ${b.name}: 동시 시도 ${b.maxInflight}`);
  assert.ok(A.h._stats().resumeRuns >= 2);
  // 끊긴 뒤 mqtt 가 다시 붙는 중(핸드셰이크 진행 중)에 폰을 켬
  bs[0].dropAll();
  await until(() => A.h._brokers()[0].connecting, 3000, 'mqtt reconnect attempt in flight');
  env.visible();
  env.online();
  await sleep(100);
  assert.equal(lib.reconnectCalls, 0);
  assert.equal(lib.clients.length, 3, '핸드셰이크 중인 클라이언트는 그대로');
  await until(() => connectedAll(A), 3000, 'reconnected');
  for (const b of bs) assert.ok(b.maxInflight <= 1, `broker ${b.name}: 동시 시도 ${b.maxInflight}`);
  await sleep(150);
  assert.equal(A.status.connected, 3, '연결이 서로를 끊지 않음');
  await A.h.leave();
});

test('resume: online+visibilitychange+pageshow 가 한꺼번에 와도 한 번만 실행, 3초(여기선 짧게) 안에는 접속 표시만', async () => {
  const b1 = new FakeBroker('1');
  const env = fakeEnv();
  const lib = net([b1, new FakeBroker('2'), new FakeBroker('3')]);
  const A = mkRoom(lib, 'a', { _window: env.win, _document: env.doc, timing: { resumeMinGap: 1000, healthTimeout: 5000 } });
  await until(() => connectedAll(A) && readyAll(A), 3000, 'connect');
  const s0 = A.h._stats();
  env.online();
  env.visible();
  env.pageshow();
  await sleep(150);
  const s1 = A.h._stats();
  assert.equal(s1.resumeRuns - s0.resumeRuns, 1, '정확히 한 번');
  assert.equal(s1.recreates, s0.recreates, '멀쩡한 연결은 새로 만들지 않음');
  assert.equal(lib.clients.length, 3);
  // 곧바로 또 → 실행은 건너뛰고 접속 표시만 다시
  const pres = b1.log.filter((m) => m.topic.endsWith('/presence/a')).length;
  env.visible();
  env.pageshow();
  await sleep(100);
  const s2 = A.h._stats();
  assert.equal(s2.resumeRuns, s1.resumeRuns);
  assert.equal(s2.resumeSkipped, s1.resumeSkipped + 1);
  assert.ok(b1.log.filter((m) => m.topic.endsWith('/presence/a')).length > pres, '접속 표시는 다시');
  // 숨겨질 때는 실행하지 않음
  env.hidden();
  await sleep(100);
  assert.equal(A.h._stats().resumeRuns, s1.resumeRuns);
  await A.h.leave();
});

test('watchdog: connected + disconnecting 으로 굳은 클라이언트를 새로 만듦', async () => {
  const b1 = new FakeBroker('1');
  const lib = net([b1, new FakeBroker('2'), new FakeBroker('3')]);
  const A = mkRoom(lib, 'a');
  await until(() => connectedAll(A) && readyAll(A), 3000, 'connect');
  const wedged = lib.clients.find((c) => c.broker === b1);
  wedged.disconnecting = true; // mqtt.js 에서 reconnect() 가 섞이면 생기는 상태: 모든 publish 가 실패
  await until(() => lib.clients.length === 4 && A.status.connected === 3, 3000, 'recreated by watchdog');
  assert.ok(A.h._stats().recreates >= 1);
  assert.ok(!b1.clients.has(wedged), '굳은 소켓은 닫힘');
  const d = A.h.commit(body('after-wedge'));
  await until(() => b1.retainedDoc() && b1.retainedDoc().nonce === d.nonce, 3000, 'new client publishes');
  assert.equal(lib.reconnectCalls, 0);
  await A.h.leave();
});

test('반쯤 죽은 소켓(zombie): resume 뒤 PUBACK 이 없으면 새로 만들고 밀린 문서를 올림', async () => {
  const bs = [new FakeBroker('1'), new FakeBroker('2'), new FakeBroker('3')];
  const lib = net(bs);
  const A = mkRoom(lib, 'a');
  await until(() => connectedAll(A) && readyAll(A), 3000, 'connect');
  for (const c of lib.clients) c.zombie = true; // Wi-Fi ↔ LTE 전환: 소켓은 열린 척하지만 아무것도 안 감
  const d = A.h.commit(body('lost-in-zombie'));
  await sleep(100);
  assert.ok(bs.every((b) => !b.retainedDoc()), '아직 아무 브로커에도 없음');
  assert.equal(A.h.delivery.state, 'pending');
  const t0 = Date.now();
  A.h.resume();
  await until(() => bs.every((b) => b.retainedDoc() && b.retainedDoc().nonce === d.nonce), 5000, 'published after recreate');
  assert.ok(Date.now() - t0 < 5000);
  assert.ok(A.h._stats().recreates >= 3);
  await until(() => A.h.delivery.state === 'relayed', 3000, 'relayed');
  assert.equal(lib.reconnectCalls, 0);
  await A.h.leave();
});

test('오래 숨겨졌다가 켜자마자 commit → 그 자리에서 상태 확인해 zombie 를 찾음', async () => {
  const bs = [new FakeBroker('1'), new FakeBroker('2'), new FakeBroker('3')];
  const env = fakeEnv();
  const lib = net(bs);
  // resume 은 늦게 돌게 해서, commit 자체의 확인만 검사
  const A = mkRoom(lib, 'a', { _window: env.win, _document: env.doc, timing: { resumeDebounce: 10_000 } });
  await until(() => connectedAll(A) && readyAll(A), 3000, 'connect');
  env.hidden();
  await sleep(FAST.hiddenCheck + 50);
  for (const c of lib.clients) c.zombie = true;
  env.visible();
  const d = A.h.commit(body('after-unlock'));
  await until(() => bs.every((b) => b.retainedDoc() && b.retainedDoc().nonce === d.nonce), 3000, 'published after health check');
  assert.equal(A.h._stats().resumeRuns, 0, 'resume 이 아니라 commit 의 확인으로');
  await A.h.leave();
});

test('synced: join 직후 false → 확인 끝나면 true, resume 때 false → 다시 true, 모두 끊기면 false', async () => {
  const bs = [new FakeBroker('1'), new FakeBroker('2'), new FakeBroker('3')];
  const lib = net(bs);
  const A = mkRoom(lib, 'a');
  assert.equal(A.h.synced, false);
  assert.equal(A.h.status.synced, false);
  await until(() => A.h.synced === true, 3000, 'synced after heal');
  assert.equal(A.status.synced, true, 'onStatus 에도');
  const n = A.statusLog.length;
  A.h.resume();
  await until(() => A.statusLog.slice(n).some((s) => s.synced === false), 3000, 'false on resume');
  await until(() => A.h.synced === true && A.status.synced === true, 3000, 'true again');
  for (const b of bs) b.mode = 'down';
  for (const b of bs) b.dropAll();
  await until(() => A.h.synced === false && A.status.connected === 0, 3000, 'false when all down');
  for (const b of bs) b.mode = 'up';
  await until(() => A.h.synced === true, 3000, 'true after reconnect + heal');
  await A.h.leave();
});

test('leave 후에는 콜백이 오지 않고 commit 은 오류', async () => {
  const lib = net([new FakeBroker('1'), new FakeBroker('2'), new FakeBroker('3')]);
  const A = mkRoom(lib, 'a');
  const B = mkRoom(lib, 'b');
  await until(() => connectedAll(A, B), 3000, 'connect');
  await A.h.leave();
  const n = { docs: A.docs.length, emotes: A.emotes.length };
  B.h.commit(body('after'));
  B.h.emote('hi');
  await sleep(100);
  assert.deepEqual({ docs: A.docs.length, emotes: A.emotes.length }, n);
  assert.throws(() => A.h.commit(body(1)));
  await B.h.leave();
  await A.h.leave(); // 두 번 불러도 괜찮음
});
