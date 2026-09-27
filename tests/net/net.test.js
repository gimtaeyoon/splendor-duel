// SDNet 실제 공개 브로커 테스트 (npm run test:net). 네트워크가 필요하고 느릴 수 있어요.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const mqtt = require('mqtt');
const SDNet = require('../../js/net.js');

const ROOM = SDNet.newRoomCode();
const DOC_T = `sdkr1/${ROOM}/doc`;
const PRIMARY = SDNet.BROKERS.slice(0, 2);
// 방 문서의 game 은 null 또는 players 2명짜리 객체여야 함 (validDoc)
const G = (x) => ({ players: [{}, {}], x });
const usedDevices = new Set();
const openRooms = new Set();
const rawClients = new Set();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms, what) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (fn()) return Date.now() - t0;
    await sleep(50);
  }
  assert.fail(`시간 초과 (${ms} ms): ${what}`);
}

function memStorage(init) {
  const m = new Map(Object.entries(init || {}));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), map: m };
}

// 방 참가 + 최소 한 브로커 연결까지 (느린 공개 브로커 때문에 몇 번 다시 시도)
async function joinRoom(deviceId, extra, { needAll = false } = {}) {
  usedDevices.add(deviceId);
  for (let attempt = 1; attempt <= 3; attempt++) {
    const r = { docs: [], peers: {}, status: null, emotes: [] };
    r.h = SDNet.join(
      Object.assign(
        {
          room: ROOM,
          deviceId,
          name: deviceId,
          storage: memStorage(),
          onDoc: (d, info) => r.docs.push({ d, source: info.source }),
          onPeers: (p) => (r.peers = p),
          onStatus: (s) => (r.status = s),
          onEmote: (e) => r.emotes.push(e),
        },
        extra
      )
    );
    openRooms.add(r);
    try {
      await until(() => r.status && r.status.connected >= (needAll ? 2 : 1), 25000, `${deviceId} connect`);
      // 연결 직후 retained 확인(healWait ~2 s)이 끝날 때까지
      await sleep(2600);
      return r;
    } catch (e) {
      console.log(`  (${deviceId}: 브로커 연결 실패, 다시 시도 ${attempt}/3)`, r.status && JSON.stringify(r.status.brokers));
      openRooms.delete(r);
      await r.h.leave();
    }
  }
  assert.fail(`${deviceId}: 브로커에 연결하지 못했어요`);
}

async function rawConnect(url) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const c = mqtt.connect(url, { clientId: 'sdtest_' + Math.random().toString(16).slice(2, 10), clean: true, connectTimeout: 10000, reconnectPeriod: 0 });
    rawClients.add(c);
    const ok = await new Promise((res) => {
      const t = setTimeout(() => res(false), 12000);
      c.once('connect', () => (clearTimeout(t), res(true)));
      c.once('error', () => (clearTimeout(t), res(false)));
    });
    if (ok) return c;
    c.end(true);
    rawClients.delete(c);
    await sleep(1000);
  }
  return null;
}

// 브로커에 남아 있는 retained 문서 읽기
async function rawRetained(url, topic, waitMs = 3000) {
  const c = await rawConnect(url);
  if (!c) return undefined;
  let last = null;
  c.on('message', (t, p) => {
    if (t === topic) last = p.toString();
  });
  await new Promise((res) => c.subscribe(topic, { qos: 1 }, res));
  await sleep(waitMs);
  await new Promise((res) => c.end(false, {}, res));
  rawClients.delete(c);
  return last;
}

async function rawPublish(url, topic, payload, retain = true) {
  const c = await rawConnect(url);
  if (!c) return false;
  await new Promise((res) => c.publish(topic, payload, { qos: 1, retain }, res));
  await new Promise((res) => c.end(false, {}, res));
  rawClients.delete(c);
  return true;
}

function connectedUrls(r) {
  return r.status.brokers.filter((b) => b.state === 'connected').map((b) => b.url);
}

test(`실시간 브로커 동기화 (방 ${ROOM})`, { timeout: 600000 }, async (t) => {
  let A, B;

  t.after(async () => {
    // 모두 나간 뒤 retained 토픽 정리 ('{}' 로 덮기 — 빈 페이로드는 금지)
    for (const r of openRooms) await r.h.leave().catch(() => {});
    for (const c of rawClients) c.end(true);
    const topics = [DOC_T, ...[...usedDevices].map((d) => `sdkr1/${ROOM}/presence/${d}`)];
    await Promise.all(
      SDNet.BROKERS.map(async (url) => {
        const c = await rawConnect(url);
        if (!c) return;
        for (const tp of topics) await new Promise((res) => c.publish(tp, '{}', { qos: 1, retain: true }, res));
        await new Promise((res) => c.end(false, {}, res));
      })
    );
  });

  await t.test('A commit → B 가 받음, B 가 seq 2 → A 가 받음', async () => {
    [A, B] = await Promise.all([joinRoom('devA', { seat: 0 }, { needAll: true }), joinRoom('devB', { seat: 1 }, { needAll: true })]);
    assert.equal(A.h.doc, null);
    assert.equal(A.status.total, 3, '세 브로커를 처음부터 모두 씀');
    assert.deepEqual(A.status.brokers.map((b) => b.name), ['emqx', 'coreflux', 'hivemq']);
    await until(() => A.h.synced && B.h.synced, 20000, 'synced');
    const d1 = A.h.commit({ seats: [{ deviceId: 'devA', name: '에이' }, null], game: null, prevLoser: null });
    assert.equal(d1.seq, 1);
    assert.equal(A.docs.at(-1).source, 'local');
    assert.equal(A.h.delivery.state, 'pending');
    const ms = await until(() => B.h.doc && B.h.doc.nonce === d1.nonce, 20000, 'B receives seq 1');
    console.log(`  A→B 전달 ${ms} ms`);
    assert.deepEqual(B.h.doc.seats[0], { deviceId: 'devA', name: '에이' });
    const dms = await until(() => A.h.delivery.state === 'delivered', 20000, 'A delivery → delivered (B presence seen)');
    console.log(`  delivered 확인 +${dms} ms`);
    assert.equal(B.docs.at(-1).source, 'remote');
    const d2 = B.h.commit(Object.assign({}, B.h.doc, { seats: [B.h.doc.seats[0], { deviceId: 'devB', name: '비' }] }));
    assert.equal(d2.seq, 2);
    await until(() => A.h.doc && A.h.doc.seq === 2 && A.h.doc.nonce === d2.nonce, 20000, 'A receives seq 2');
    assert.equal(A.h.doc.by, 'devB');
    assert.equal(A.docs.filter((x) => x.source === 'remote' && x.d.seq === 2).length, 1, '두 브로커로 와도 한 번');
  });

  await t.test('동시에 같은 seq 로 커밋 → 같은 문서로 수렴', async () => {
    const base = A.h.doc.seq;
    const da = A.h.commit(Object.assign({}, A.h.doc, { game: G('A') }));
    const db = B.h.commit(Object.assign({}, B.h.doc, { game: G('B') }));
    assert.equal(da.seq, base + 1);
    assert.equal(db.seq, base + 1);
    const winner = da.nonce > db.nonce ? da : db;
    await until(() => A.h.doc.nonce === winner.nonce && B.h.doc.nonce === winner.nonce, 30000, 'converge');
    assert.deepEqual(A.h.doc, B.h.doc);
    assert.deepEqual(A.h.doc.game, winner.game);
    const loser = winner === da ? B : A;
    await until(() => loser.h.delivery.state === 'superseded', 20000, 'loser superseded');
    // 각 브로커의 retained 도 승자로 고쳐짐
    await sleep(3000);
    for (const url of connectedUrls(A)) {
      const raw = await rawRetained(url, DOC_T);
      if (raw === undefined) {
        console.log(`  (${url} 확인용 연결 실패, 건너뜀)`);
        continue;
      }
      assert.equal(JSON.parse(raw).nonce, winner.nonce, `${url} retained = 승자`);
    }
  });

  await t.test('늦게 들어온 C 가 retained 문서를 받음', async () => {
    const C = await joinRoom('devC');
    await until(() => C.h.doc && C.h.doc.nonce === A.h.doc.nonce, 20000, 'C gets retained doc');
    assert.equal(C.docs[0].source, 'remote');
    await C.h.leave();
    openRooms.delete(C);
  });

  await t.test('옛 seq 문서는 무시하고 브로커를 고침', async () => {
    const cur = A.h.doc;
    const stale = Object.assign({}, cur, { seq: cur.seq - 1, nonce: 'zzzzzzzz', game: G('stale') });
    const nA = A.docs.length, nB = B.docs.length;
    const url = connectedUrls(A)[0];
    assert.ok(await rawPublish(url, DOC_T, JSON.stringify(stale)), 'stale publish');
    await rawPublish(url, DOC_T, '{not json', false);
    await rawPublish(url, DOC_T, JSON.stringify(Object.assign({}, cur, { seq: 999, room: 'ZZZZZZ' })), false);
    await sleep(4000);
    assert.equal(A.docs.length, nA);
    assert.equal(B.docs.length, nB);
    assert.equal(A.h.doc.nonce, cur.nonce);
    assert.equal(B.h.doc.nonce, cur.nonce);
    // 옛 문서를 받은 A/B 가 그 브로커에 현재 문서를 다시 올림
    let raw;
    for (let i = 0; i < 5; i++) {
      raw = await rawRetained(url, DOC_T, 2000);
      if (raw && JSON.parse(raw).nonce === cur.nonce) break;
    }
    assert.equal(JSON.parse(raw).nonce, cur.nonce, 'broker healed');
  });

  await t.test('캐시가 브로커보다 새것이면 다시 올려서 모두에게 퍼짐', async () => {
    const cur = A.h.doc;
    const newer = Object.assign({}, cur, { seq: cur.seq + 5, nonce: 'cache' + Date.now(), by: 'devH', game: G('fromCache') });
    const H = await joinRoom('devH', { storage: memStorage({ ['sd.room.' + ROOM]: JSON.stringify(newer) }) });
    assert.equal(H.docs[0].source, 'cache');
    assert.equal(H.h.doc.seq, newer.seq);
    await until(() => A.h.doc.nonce === newer.nonce && B.h.doc.nonce === newer.nonce, 30000, 'A,B get cached doc via heal');
    assert.deepEqual(B.h.doc.game, G('fromCache'));
    await H.h.leave();
    openRooms.delete(H);
  });

  await t.test('presence: 온라인 → 비정상 종료(LWT) 로 오프라인', async () => {
    await until(() => A.peers.devB && A.peers.devB.online && B.peers.devA && B.peers.devA.online, 30000, 'both online');
    assert.equal(A.peers.devA.self, true);
    B.h.setPresence({ name: '비비', seat: 1 });
    await until(() => A.peers.devB.name === '비비' && A.peers.devB.seat === 1, 20000, 'name/seat');
    const K = await joinRoom('devK');
    await until(() => A.peers.devK && A.peers.devK.online, 30000, 'K online');
    K.h._crash(); // DISCONNECT 없이 끊음 → 브로커가 LWT
    const ms = await until(() => A.peers.devK && A.peers.devK.online === false, 60000, 'K offline via LWT');
    console.log(`  LWT 반영 ${ms} ms`);
    openRooms.delete(K);
    // 정상 leave → offline 표시
    const L = await joinRoom('devL');
    await until(() => A.peers.devL && A.peers.devL.online, 30000, 'L online');
    await L.h.leave();
    openRooms.delete(L);
    await until(() => A.peers.devL.online === false, 30000, 'L offline after leave');
  });

  await t.test('emote: 상대에게 한 번 전달, 내 것은 무시', async () => {
    A.h.emote('💎');
    await until(() => B.emotes.length >= 1, 20000, 'emote');
    await sleep(2000);
    assert.equal(B.emotes.length, 1, '두 브로커로 와도 한 번');
    assert.equal(B.emotes[0].from, 'devA');
    assert.equal(B.emotes[0].emote, '💎');
    assert.equal(A.emotes.length, 0);
  });

  await t.test('leave', async () => {
    await Promise.all([A.h.leave(), B.h.leave()]);
    openRooms.delete(A);
    openRooms.delete(B);
    assert.ok(PRIMARY.length === 2);
  });
});
