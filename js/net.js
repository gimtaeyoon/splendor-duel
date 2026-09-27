/* 스플렌더 대결 — 온라인 방 동기화 (MQTT over WSS). 게임 규칙은 전혀 모릅니다.
 * docs/SPEC.md §4, §6 참고.
 * - 방 문서(doc)는 retained QoS1 로 세 브로커에 동시에 올리고, (seq, nonce) 로 최신본을 고릅니다.
 * - 브로커가 문서를 잃었거나 옛 문서를 들고 있으면 우리 것을 다시 올려서 스스로 고칩니다.
 * - 오프라인/옛 캐시 위에서 만든 커밋(확인 안 된 가지)은, 브로커에 다른 새 문서가 있으면 버리고 onConflict 로 알립니다.
 * - 접속 표시(presence)는 retained + LWT (+ 내가 가진 문서 seen), 이모티콘은 QoS0 비보존.
 * - 연결이 이상하면 reconnect() 대신 클라이언트를 통째로 새로 만듭니다 (resume / watchdog / 상태 확인).
 */
(function () {
  'use strict';

  const APP = 'sdkr1';
  const BROKERS = [
    'wss://broker.emqx.io:8084/mqtt',
    'wss://iot.coreflux.cloud:443/mqtt',
    'wss://broker.hivemq.com:8884/mqtt',
  ];
  const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const ROOM_LEN = 6;
  const MAX_PAYLOAD = 200 * 1024; // 이보다 큰 메시지는 무시
  const MAX_EMOTE = 64;
  const MAX_SEQ = 1e9; // 이보다 큰 seq 는 거절 (방을 영원히 잠그는 공격 방지)
  const MAX_SEQ_JUMP = 500; // 내 문서보다 이만큼 넘게 앞선 문서는 받지 않음
  const STALE_LOCAL_MS = 24 * 3600 * 1000; // 내 문서가 이보다 오래됐으면 MAX_SEQ_JUMP 제한을 풀어 줌
  const MAX_JUMP = 5; // commit(doc, {jump}) 의 최대값
  const ANC_MAX = 12; // 문서에 담는 조상 수 (충돌 판정용)
  const DEFAULT_TIMING = {
    healWait: 2000, // 접속 후 retained 문서를 기다리는 시간
    presenceEvery: 25000, // 접속 표시 갱신 주기
    peerStale: 70000, // 이보다 오래된 접속 표시는 오프라인 취급
    tick: 5000, // 상대 접속 상태 재평가 + watchdog 주기
    repushGap: 3000, // 같은 문서를 같은 브로커에 다시 올리는 최소 간격
    connectTimeout: 8000,
    reconnectPeriod: 2000,
    keepalive: 20,
    resumeDebounce: 300, // online/visibilitychange/pageshow 가 몰려도 마지막 것 뒤 한 번만
    resumeMinGap: 3000, // resume 을 이보다 자주 하지 않음 (대신 접속 표시만 다시)
    healthTimeout: 4000, // 상태 확인(QoS1 PUBACK) 을 이만큼 기다려도 없으면 클라이언트 새로 만듦
    watchdogStale: 20000, // 이만큼 연결이 없고 시도 중도 아니면 클라이언트 새로 만듦
    hiddenCheck: 10000, // 이보다 오래 숨겨져 있었으면 다음 commit 때 상태 확인
    announceDebounce: 300, // 문서가 바뀐 뒤 접속 표시(seen) 다시 알리기
    // fallbackAfter: 예전 옵션. 이제 세 브로커를 처음부터 모두 쓰므로 받기만 하고 무시합니다.
  };

  // ---------- 순수 함수 (tests/net-offline.test.js 에서 검사) ----------

  function randomInt(n) {
    const c = typeof globalThis !== 'undefined' ? globalThis.crypto : null;
    if (c && typeof c.getRandomValues === 'function') {
      // 편향 없는 추출
      const limit = Math.floor(0x100000000 / n) * n;
      const buf = new Uint32Array(1);
      do c.getRandomValues(buf); while (buf[0] >= limit);
      return buf[0] % n;
    }
    return Math.floor(Math.random() * n);
  }

  function randomId(len) {
    const hex = '0123456789abcdef';
    let s = '';
    for (let i = 0; i < len; i++) s += hex[randomInt(16)];
    return s;
  }

  function newRoomCode() {
    let s = '';
    for (let i = 0; i < ROOM_LEN; i++) s += ROOM_ALPHABET[randomInt(ROOM_ALPHABET.length)];
    return s;
  }

  // 사용자가 입력한 코드 정리: 대문자, 영숫자만 (토픽에 '/', '+', '#' 가 들어가지 않게)
  function normalizeRoom(code) {
    return String(code == null ? '' : code).toUpperCase().replace(/[^A-Z0-9]/g, '');
  }

  function isRoomCode(code) {
    if (typeof code !== 'string' || code.length !== ROOM_LEN) return false;
    for (const ch of code) if (ROOM_ALPHABET.indexOf(ch) < 0) return false;
    return true;
  }

  // 받은 문서가 지금 것보다 새것인가? (seq 가 크거나, 같으면 nonce 가 큰 쪽)
  function isNewer(incoming, local) {
    if (!incoming) return false;
    if (!local) return true;
    if (incoming.seq !== local.seq) return incoming.seq > local.seq;
    return incoming.nonce > local.nonce;
  }

  function sameDoc(a, b) {
    return !!a && !!b && a.seq === b.seq && a.nonce === b.nonce;
  }

  function docKey(d) {
    return d ? d.seq + ':' + d.nonce : '';
  }

  function validNonce(n) {
    return typeof n === 'string' && n.length > 0 && n.length <= 64;
  }

  function validSeq(s) {
    return Number.isSafeInteger(s) && s >= 1 && s <= MAX_SEQ;
  }

  // {seq, nonce} 만 남긴 문서 표시 (잘못되면 null)
  function refOf(x) {
    if (!isPlainObject(x) || !validSeq(x.seq) || !validNonce(x.nonce)) return null;
    return { seq: x.seq, nonce: x.nonce };
  }

  function parseKey(k) {
    if (typeof k !== 'string') return null;
    const i = k.indexOf(':');
    if (i <= 0) return null;
    return refOf({ seq: Number(k.slice(0, i)), nonce: k.slice(i + 1) });
  }

  // 문서의 조상 목록 (가까운 것부터). d.anc = ['seq:nonce', ...], 없으면 d.parent 하나.
  function ancestorsOf(d) {
    const out = [];
    if (!d) return out;
    if (Array.isArray(d.anc)) {
      for (const k of d.anc.slice(0, ANC_MAX)) {
        const r = parseKey(k);
        if (r) out.push(r);
      }
      if (out.length) return out;
    }
    const p = refOf(d.parent);
    if (p) out.push(p);
    return out;
  }

  // r 이 l 을 이어받은 문서인가? 1 = 예(같은 문서 포함), 0 = 아니오(확실), -1 = 알 수 없음
  function lineage(r, l) {
    if (!r || !l) return -1;
    if (sameDoc(r, l)) return 1;
    if (r.seq <= l.seq) return 0;
    const anc = ancestorsOf(r);
    for (const a of anc) if (a.seq === l.seq && a.nonce === l.nonce) return 1;
    if (anc.some((a) => a.seq <= l.seq)) return 0; // l 의 seq 를 지나쳤는데 l 이 없음
    if (r.parent === null) return 0; // 방의 첫 문서인데 l 보다 seq 가 큼 → 다른 역사
    return -1;
  }

  // MQTT 페이로드(Buffer/Uint8Array/string) → 문자열. 너무 크거나 비었으면 null
  function payloadText(payload) {
    if (payload == null) return null;
    if (typeof payload === 'string') {
      // UTF-8 바이트 수 상한 (문자 수 × 3 을 넘을 수 없음)
      if (payload.length === 0 || payload.length > MAX_PAYLOAD) return null;
      if (payload.length * 3 > MAX_PAYLOAD && utf8Length(payload) > MAX_PAYLOAD) return null;
      return payload;
    }
    const n = payload.byteLength != null ? payload.byteLength : payload.length;
    if (typeof n !== 'number' || n === 0 || n > MAX_PAYLOAD) return null;
    try {
      if (typeof TextDecoder !== 'undefined' && (payload instanceof Uint8Array || payload instanceof ArrayBuffer)) {
        return new TextDecoder('utf-8').decode(payload);
      }
      return String(payload.toString());
    } catch (e) {
      return null;
    }
  }

  function utf8Length(s) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(s).length;
    return unescape(encodeURIComponent(s)).length;
  }

  function parseJson(payload) {
    const text = payloadText(payload);
    if (text == null) return undefined;
    try {
      return JSON.parse(text);
    } catch (e) {
      return undefined;
    }
  }

  function isPlainObject(x) {
    return !!x && typeof x === 'object' && !Array.isArray(x);
  }

  function validSeat(s) {
    return (
      s === null ||
      (isPlainObject(s) &&
        typeof s.deviceId === 'string' &&
        s.deviceId.length > 0 &&
        s.deviceId.length <= 64 &&
        typeof s.name === 'string' &&
        s.name.length <= 24)
    );
  }

  // 이 방의 올바른 문서인가? ('{}' 지우기 표시, 다른 앱/방, 잘못된 seq/nonce/seats/game 은 거절)
  // 공개 브로커 + 추측 가능한 토픽이라 아무나 올릴 수 있음 → 모양을 엄격히 확인
  function validDoc(d, room) {
    return (
      isPlainObject(d) &&
      d.app === APP &&
      typeof d.room === 'string' &&
      d.room === room &&
      validSeq(d.seq) &&
      validNonce(d.nonce) &&
      Array.isArray(d.seats) &&
      d.seats.length === 2 &&
      validSeat(d.seats[0]) &&
      validSeat(d.seats[1]) &&
      (d.game === null || (isPlainObject(d.game) && Array.isArray(d.game.players) && d.game.players.length === 2))
    );
  }

  function parseDoc(payload, room) {
    const d = parseJson(payload);
    return validDoc(d, room) ? d : null;
  }

  // presence: undefined = 이상한 메시지(무시), null = 지워짐('{}'), 객체 = 정상
  function parsePresence(payload) {
    const p = parseJson(payload);
    if (!isPlainObject(p)) return undefined;
    if (Object.keys(p).length === 0) return null;
    if (typeof p.online !== 'boolean') return undefined;
    return {
      online: p.online,
      name: typeof p.name === 'string' ? p.name.slice(0, 40) : '',
      seat: p.seat === 0 || p.seat === 1 ? p.seat : null,
      at: Number.isFinite(p.at) ? p.at : 0,
      seen: refOf(p.seen),
    };
  }

  function parseEmote(payload) {
    const e = parseJson(payload);
    if (!isPlainObject(e)) return null;
    if (typeof e.from !== 'string' || !e.from || typeof e.emote !== 'string' || !e.emote) return null;
    if (e.emote.length > MAX_EMOTE) return null;
    return { from: e.from, emote: e.emote, at: Number.isFinite(e.at) ? e.at : Date.now(), id: typeof e.id === 'string' ? e.id : '' };
  }

  // 상대가 켜져 있는가? (online 이면서 마지막 신호가 staleMs 이내; skew = 시계 차이 보정)
  function presenceFresh(p, now, staleMs, skew) {
    if (!p || p.online !== true || !Number.isFinite(p.at)) return false;
    return now - (p.at + (skew || 0)) <= (staleMs || DEFAULT_TIMING.peerStale);
  }

  // 'wss://broker.emqx.io:8084/mqtt' → 'emqx'
  function brokerName(url) {
    let host = '';
    const m = /^[a-z]+:\/\/([^/:]+)/i.exec(String(url));
    host = m ? m[1] : String(url);
    if (/emqx/i.test(host)) return 'emqx';
    if (/coreflux/i.test(host)) return 'coreflux';
    if (/hivemq/i.test(host)) return 'hivemq';
    return host;
  }

  function getMqtt() {
    if (typeof window !== 'undefined' && window.mqtt) return window.mqtt;
    if (typeof require === 'function') {
      try {
        return require('mqtt');
      } catch (e) {
        /* 없음 */
      }
    }
    return null;
  }

  function defaultStorage() {
    try {
      return typeof localStorage !== 'undefined' ? localStorage : null;
    } catch (e) {
      return null; // 일부 브라우저는 접근만 해도 예외
    }
  }

  function safeCall(fn, ...args) {
    if (typeof fn !== 'function') return;
    try {
      fn(...args);
    } catch (e) {
      if (typeof console !== 'undefined') console.error('[SDNet] callback error', e);
    }
  }

  const DELIVERY_RANK = { pending: 0, relayed: 1, delivered: 2 };

  // ---------- 방 참가 ----------

  function join(opts) {
    const o = opts || {};
    const room = normalizeRoom(o.room);
    if (!room) throw new Error('방 코드가 필요해요.');
    const deviceId = String(o.deviceId || 'd' + randomId(15));
    const timing = Object.assign({}, DEFAULT_TIMING, o.timing || {});
    const mqttLib = o.mqtt || getMqtt();
    const storage = o.storage !== undefined ? o.storage : defaultStorage();
    const urls = (o.brokers || BROKERS).slice();
    // 테스트용: 가짜 window/document 주입 (기본은 전역)
    const win = o._window !== undefined ? o._window : typeof window !== 'undefined' ? window : null;
    const doc = o._document !== undefined ? o._document : typeof document !== 'undefined' ? document : null;
    const storageKey = 'sd.room.' + room;
    const metaKey = storageKey + '.meta';
    const prefix = APP + '/' + room + '/';
    const T = {
      doc: prefix + 'doc',
      presence: prefix + 'presence/',
      emote: prefix + 'emote',
    };
    const me = { name: typeof o.name === 'string' ? o.name : '', seat: o.seat === 0 || o.seat === 1 ? o.seat : null, at: 0 };

    let current = null; // 받아들인 최신 문서
    let confirmed = null; // 브로커에 있다고 확인된 최신 문서 {seq, nonce}
    let branch = []; // confirmed 뒤에 내가 만든, 아직 브로커 확인이 없는 커밋 (오래된 것부터)
    let lastLocal = null; // 내 마지막 커밋
    let delivery = null; // {seq, nonce, state, since}
    let synced = false;
    let left = false;
    const brokers = []; // makeBroker 참고
    const skew = {}; // deviceId → 시계 차이 추정(ms)
    const seenEmotes = new Map();
    let lastStatusSig = '';
    let lastPeersSig = null;
    let peers = {};
    let tickTimer = null;
    let resumeTimer = null;
    let announceTimer = null;
    let lastResumeRun = 0;
    let hiddenAt = 0;
    let checkOnCommit = false;
    let warnedJump = false;
    let lastAnnounceTick = 0;
    let booting = true; // join() 이 끝나기 전에는 콜백을 부르지 않음
    const stats = { resumeRuns: 0, resumeSkipped: 0, recreates: 0, healthChecks: 0 };

    // --- 캐시 먼저 ---
    if (storage) {
      let raw = null;
      let rawMeta = null;
      try {
        raw = storage.getItem(storageKey);
        rawMeta = storage.getItem(metaKey);
      } catch (e) {
        raw = null;
      }
      const cached = raw ? parseDoc(raw, room) : null;
      if (cached) {
        current = cached;
        loadMeta(cached, rawMeta);
        // room 객체가 반환된 뒤에 알림 (네트워크 이벤트보다 먼저)
        Promise.resolve().then(() => {
          if (!left && current === cached) safeCall(o.onDoc, cached, { source: 'cache' });
        });
      }
    }

    // 저장된 confirmed/branch 복원. 없거나 안 맞으면 캐시 문서를 확인된 것으로 봄 (예전 버전과 같은 동작)
    function loadMeta(cached, rawMeta) {
      confirmed = refOf(cached);
      branch = [];
      let m = null;
      try {
        m = rawMeta ? JSON.parse(rawMeta) : null;
      } catch (e) {
        m = null;
      }
      if (!isPlainObject(m) || m.tip !== docKey(cached) || !Array.isArray(m.b)) return;
      const stubs = [];
      for (const s of m.b.slice(-20)) {
        const r = refOf(s);
        if (!r) return;
        stubs.push(Object.assign({}, s, r));
      }
      if (stubs.length && !sameDoc(stubs[stubs.length - 1], cached)) return;
      confirmed = m.c == null ? null : parseKey(m.c);
      if (m.c != null && !confirmed) confirmed = refOf(cached);
      if (stubs.length) {
        stubs[stubs.length - 1] = cached;
        branch = stubs;
        lastLocal = cached;
        delivery = { seq: cached.seq, nonce: cached.nonce, state: 'pending', since: Date.now() };
      }
    }

    function stubOf(d) {
      return { seq: d.seq, nonce: d.nonce, parent: d.parent === undefined ? undefined : d.parent, anc: d.anc, by: d.by, at: d.at };
    }

    function save() {
      if (!storage || !current) return;
      try {
        storage.setItem(storageKey, JSON.stringify(current));
      } catch (e) {
        /* 저장 공간 없음 등: 무시 */
      }
      try {
        storage.setItem(metaKey, JSON.stringify({ tip: docKey(current), c: confirmed ? docKey(confirmed) : null, b: branch.map(stubOf) }));
      } catch (e) {
        /* 무시 */
      }
    }

    // --- 상태 알림 ---
    function statusInfo() {
      const list = brokers.map((b) => ({ name: b.name, url: b.url, state: b.state }));
      return { connected: list.filter((b) => b.state === 'connected').length, total: list.length, brokers: list, synced };
    }

    function emitStatus() {
      if (booting || left) return;
      const s = statusInfo();
      const sig = JSON.stringify(s);
      if (sig === lastStatusSig) return;
      lastStatusSig = sig;
      safeCall(o.onStatus, s);
    }

    function setSynced(v) {
      if (synced === v) return;
      synced = v;
      emitStatus();
    }

    function setState(b, state) {
      if (b.state === state) return;
      b.state = state;
      emitStatus();
      emitPeers(); // 내 온라인 여부가 바뀔 수 있음
    }

    // --- 전달 상태 ---
    function deliveryCopy() {
      return delivery ? Object.assign({}, delivery) : null;
    }

    function setDelivery(state) {
      if (!delivery || delivery.state === state) return;
      if (state !== 'superseded' && delivery.state !== 'superseded' && DELIVERY_RANK[state] < DELIVERY_RANK[delivery.state]) return;
      delivery = Object.assign({}, delivery, { state, since: Date.now() });
      if (!booting && !left) safeCall(o.onDelivery, deliveryCopy());
    }

    function mySeat() {
      if (current && Array.isArray(current.seats)) {
        const i = current.seats.findIndex((s) => s && s.deviceId === deviceId);
        if (i >= 0) return i;
      }
      return me.seat;
    }

    // 상대(나와 다른 자리) 가 내 마지막 커밋을 가졌는지: presence 의 seen 으로 확인
    function checkDelivered() {
      if (!delivery || !lastLocal || delivery.state === 'delivered' || delivery.state === 'superseded') return;
      const mine = mySeat();
      for (const b of brokers) {
        for (const id of Object.keys(b.presence)) {
          if (id === deviceId) continue;
          const p = b.presence[id];
          if (!p || !p.seen || (p.seat !== 0 && p.seat !== 1) || p.seat === mine) continue;
          if (sameDoc(p.seen, lastLocal)) return setDelivery('delivered');
          if (p.seen.seq > lastLocal.seq && sameDoc(current, p.seen) && lineage(current, lastLocal) === 1) return setDelivery('delivered');
        }
      }
    }

    // --- 가지(확인 안 된 내 커밋) ---
    function branchIndex(d) {
      for (let i = 0; i < branch.length; i++) if (sameDoc(branch[i], d)) return i;
      return -1;
    }

    // d 가 브로커에 있음이 확인됨 (PUBACK 또는 되돌아온 메시지)
    function confirmDoc(d) {
      const i = branchIndex(d);
      if (i >= 0) {
        confirmed = refOf(d);
        branch = branch.slice(i + 1);
        save();
      } else if (sameDoc(d, current) && (!confirmed || isNewer(d, confirmed))) {
        confirmed = refOf(d);
        save();
      }
      // superseded 는 내 문서가 다시 현재 문서가 된 경우에만 되돌림 (느린 브로커의 늦은 PUBACK 은 무시)
      if (lastLocal && sameDoc(d, lastLocal) && delivery) {
        if (delivery.state === 'pending' || (delivery.state === 'superseded' && sameDoc(current, d))) setDelivery('relayed');
      }
    }

    // 원격 문서를 받아들임 (더 새것이거나, 가지를 버릴 때는 더 옛것이어도)
    function adoptRemote(d, from) {
      // 확인 안 된 내 커밋 중 d 의 조상이라고 확인되지 않는 것은 사라짐
      const lost = branch.filter((x) => lineage(d, x) !== 1);
      if (!branch.length && lastLocal && delivery && delivery.state !== 'superseded' && !sameDoc(d, lastLocal) && lineage(d, lastLocal) === 0) {
        lost.push(lastLocal);
      }
      current = d;
      confirmed = refOf(d);
      branch = [];
      save();
      safeCall(o.onDoc, d, { source: 'remote' });
      if (lastLocal && sameDoc(d, lastLocal)) confirmDoc(d);
      if (lost.length) {
        if (lastLocal && lost.some((x) => sameDoc(x, lastLocal))) setDelivery('superseded');
        safeCall(o.onConflict, { lost, winner: d });
      } else if (lastLocal && d.by !== deviceId && lineage(d, lastLocal) === 1) {
        // 상대가 내 커밋 위에 새 커밋을 올림 → 상대가 받았다는 뜻
        const ps = Array.isArray(d.seats) ? d.seats.findIndex((s) => s && s.deviceId === d.by) : -1;
        if (ps >= 0 && ps !== mySeat()) setDelivery('delivered');
      }
      // 다른 브로커가 이 문서를 모르면 옮겨 줌
      for (const ob of brokers) {
        if (ob !== from && ob.ready && ob.state === 'connected' && (!ob.lastSeen || isNewer(current, ob.lastSeen))) publishDoc(ob);
      }
      scheduleAnnounce();
      checkDelivered();
    }

    // --- 문서 올리기 ---
    function publishDoc(b, force) {
      const c = b.client;
      if (!current) return;
      if (!c || !c.connected || !b.ready) {
        b.needsPush = true;
        return;
      }
      const key = docKey(current);
      const now = Date.now();
      if (!force && b.pushedKey === key && now - b.pushedAt < timing.repushGap) return;
      const d = current;
      const payload = JSON.stringify(d);
      if (!payload) return; // 빈 페이로드는 절대 보내지 않음
      if (payload.length > MAX_PAYLOAD && typeof console !== 'undefined') {
        console.warn('[SDNet] 문서가 너무 커요:', payload.length);
      }
      b.pushedKey = key;
      b.pushedAt = now;
      b.needsPush = false;
      try {
        c.publish(T.doc, payload, { qos: 1, retain: true }, (err) => {
          if (left || b.client !== c) return;
          if (err) {
            b.needsPush = true;
            return;
          }
          // PUBACK: 이 순간 브로커의 retained 는 이 문서 (이후 메시지는 이 뒤에 도착)
          b.lastSeen = d;
          confirmDoc(d);
          // 그사이 더 새 문서를 받았다면 이 브로커는 이제 옛 문서를 들고 있음 → 고침
          // (지금 문서를 이미 이 브로커에 보냈다면 그것이 뒤에 도착하므로 그대로 둠)
          if (isNewer(current, d) && b.pushedKey !== docKey(current)) publishDoc(b, true);
        });
      } catch (e) {
        b.needsPush = true;
      }
    }

    // 접속 직후 retained 확인이 끝나면: 가지가 낡았는지 판단하고, 필요한 브로커에 올림
    function finishHeal(b) {
      b.ready = true;
      const R = b.lastSeen;
      if (branch.length && R && !sameDoc(R, current)) {
        if (branchIndex(R) >= 0) confirmDoc(R);
        else if (!(confirmed && (sameDoc(R, confirmed) || isNewer(confirmed, R)))) {
          // 내가 모르는 새 문서가 브로커에 있음 → 오프라인/옛 캐시 위에서 만든 내 커밋은 버림
          adoptRemote(R, b);
        }
      }
      setSynced(true);
      flushAll(b);
    }

    function flushAll(healed) {
      if (!current) return;
      // 확인 안 된 가지가 있으면, 붙어 있는 모든 브로커의 확인이 끝난 뒤에 올림
      if (branch.length && brokers.some((x) => x.state === 'connected' && x.client && x.client.connected && !x.ready)) return;
      for (const b of brokers) {
        if (!b.ready || !b.client || !b.client.connected) continue;
        if (!b.lastSeen || isNewer(current, b.lastSeen)) publishDoc(b, b === healed || b.needsPush);
        else b.needsPush = false;
      }
    }

    function acceptRemote(d, b) {
      // 내 문서가 최근 것인데 seq 가 너무 앞선 문서 = 방을 잠그려는 장난으로 봄.
      // (내 캐시가 하루 넘게 묵었으면 정말로 많이 진행됐을 수 있으니 받아들임)
      if (current && d.seq > current.seq + MAX_SEQ_JUMP && Date.now() - (Number(current.at) || 0) < STALE_LOCAL_MS) {
        if (!warnedJump && typeof console !== 'undefined') console.warn('[SDNet] seq 가 너무 앞선 문서를 무시해요:', d.seq);
        warnedJump = true;
        return; // lastSeen 도 바꾸지 않음 → 브로커를 우리 것으로 고침
      }
      b.lastSeen = d; // 이 브로커가 마지막으로 보여 준 문서 (= 브로커의 retained)
      if (sameDoc(d, current)) {
        confirmDoc(d);
        return;
      }
      if (isNewer(d, current)) {
        adoptRemote(d, b);
        return;
      }
      if (branchIndex(d) >= 0) confirmDoc(d);
      // 이 브로커가 옛 문서를 들고 있음 → 우리 것으로 고침 (확인 중이면 finishHeal 에서)
      if (b.ready) publishDoc(b);
    }

    // --- 접속 표시 ---
    function presencePayload(online) {
      return JSON.stringify({ online, name: me.name, seat: me.seat, at: Date.now(), seen: current ? { seq: current.seq, nonce: current.nonce } : null });
    }

    function announce(b) {
      const c = b.client;
      if (!c || !c.connected) return;
      me.at = Date.now();
      try {
        c.publish(T.presence + deviceId, presencePayload(true), { qos: 1, retain: true });
      } catch (e) {
        /* 다음 주기에 다시 */
      }
    }

    function announceAll() {
      clearTimeout(announceTimer);
      announceTimer = null;
      for (const b of brokers) announce(b);
      lastAnnounceTick = Date.now();
    }

    function scheduleAnnounce() {
      if (left) return;
      clearTimeout(announceTimer);
      announceTimer = setTimeout(() => {
        announceTimer = null;
        if (!left) announceAll();
      }, timing.announceDebounce);
    }

    function computePeers() {
      const now = Date.now();
      const out = {};
      const ids = new Set();
      for (const b of brokers) for (const id of Object.keys(b.presence)) ids.add(id);
      ids.delete(deviceId);
      for (const id of ids) {
        let best = null;
        let online = false;
        for (const b of brokers) {
          const p = b.presence[id];
          if (!p) continue;
          // 연결이 끊긴 브로커의 정보도 시간이 지나면 저절로 오래된 것이 됨
          if (presenceFresh(p, now, timing.peerStale, skew[id])) online = true;
          if (!best || p.at > best.at) best = p;
        }
        if (best) out[id] = { online, name: best.name, seat: best.seat, at: best.at, seen: best.seen || null, self: false };
      }
      const connected = brokers.some((b) => b.state === 'connected');
      out[deviceId] = { online: connected, name: me.name, seat: me.seat, at: me.at, seen: current ? refOf(current) : null, self: true };
      return out;
    }

    function emitPeers() {
      if (left || booting) return;
      peers = computePeers();
      const sigObj = {};
      for (const id of Object.keys(peers).sort()) {
        const p = peers[id];
        sigObj[id] = [p.online, p.name, p.seat, p.seen ? docKey(p.seen) : ''];
      }
      const sig = JSON.stringify(sigObj);
      if (sig === lastPeersSig) return;
      lastPeersSig = sig;
      safeCall(o.onPeers, peers);
    }

    // --- 메시지 처리 ---
    function onMessage(b, topic, payload, packet) {
      if (left) return;
      if (topic === T.doc) {
        const d = parseDoc(payload, room);
        if (d) acceptRemote(d, b);
        return;
      }
      if (topic.indexOf(T.presence) === 0) {
        const id = topic.slice(T.presence.length);
        if (!id || id.indexOf('/') >= 0 || id.length > 64) return;
        const p = parsePresence(payload);
        if (p === undefined) return;
        if (id === deviceId) {
          // 예전 연결의 LWT 가 늦게 도착해 나를 오프라인으로 덮었으면 다시 알림
          if (p && !p.online && b.client && b.client.connected) announce(b);
          return;
        }
        if (p === null) delete b.presence[id];
        else {
          b.presence[id] = p;
          const retained = !!(packet && packet.retain);
          if (!retained && p.online && p.at) skew[id] = Date.now() - p.at; // 실시간 신호로 시계 차이 추정
        }
        emitPeers();
        checkDelivered();
        return;
      }
      if (topic === T.emote) {
        const e = parseEmote(payload);
        if (!e || e.from === deviceId) return;
        const now = Date.now();
        if (e.id) {
          if (seenEmotes.has(e.id)) return; // 여러 브로커로 같은 것이 옴
          seenEmotes.set(e.id, now);
          for (const [k, t] of seenEmotes) if (now - t > 60000) seenEmotes.delete(k);
        }
        safeCall(o.onEmote, { from: e.from, emote: e.emote, at: e.at });
      }
    }

    // --- 브로커 연결 ---
    function onConnect(b, client) {
      b.everConnected = true;
      b.ready = false;
      b.lastSeen = null; // 브로커 상태를 모름 → retained 로 다시 알게 됨
      b.pushedKey = ''; // 예전 연결로 보낸 것은 도착했는지 모름
      clearTimeout(b.healTimer);
      clearHealth(b);
      setState(b, 'connected');
      const subs = {};
      subs[T.doc] = { qos: 1 };
      subs[T.presence + '+'] = { qos: 1 };
      subs[T.emote] = { qos: 0 };
      // SUBACK 이 오지 않는 연결(반쯤 죽은 소켓)은 새로 만듦 → 다른 브로커의 올리기를 무한정 막지 않음
      b.healTimer = setTimeout(() => {
        b.healTimer = null;
        if (!left && b.client === client) recreateBroker(b);
      }, timing.healWait + timing.healthTimeout);
      // mqtt.js 의 자동 재구독(resubscribe)은 끄고 매 접속마다 여기서 직접 구독합니다.
      try {
        client.subscribe(subs, (err) => {
          if (left || b.client !== client || !client.connected) return;
          clearTimeout(b.healTimer);
          b.healTimer = null;
          if (err) {
            recreateBroker(b); // 구독 실패: 연결을 새로 맺어 다시 시도 (reconnect() 는 쓰지 않음)
            return;
          }
          announce(b);
          b.healTimer = setTimeout(() => {
            b.healTimer = null;
            if (left || b.client !== client || !client.connected) return;
            // 브로커에 문서가 없거나 우리 것보다 옛것이면 다시 올림. 오프라인 중에 만든 커밋도 여기서
            // 브로커 것을 먼저 보고 판단하므로, 그사이 상대가 올린 문서를 덮어쓰지 않음.
            finishHeal(b);
          }, timing.healWait);
        });
      } catch (e) {
        recreateBroker(b);
      }
    }

    function onDown(b) {
      b.connecting = false;
      b.ready = false;
      clearTimeout(b.healTimer);
      b.healTimer = null;
      clearHealth(b);
      if (b.state === 'connected') b.downSince = Date.now();
      setState(b, 'offline');
      if (!brokers.some((x) => x.state === 'connected')) setSynced(false);
      flushAll(); // 이 브로커를 기다리던 올리기가 있으면 진행
    }

    function makeBroker(url) {
      const now = Date.now();
      const b = {
        url,
        name: brokerName(url),
        client: null,
        state: 'connecting',
        connecting: false, // 지금 연결(핸드셰이크) 시도 중
        connectingSince: 0,
        everConnected: false,
        ready: false, // 접속 후 retained 확인이 끝남
        lastSeen: null,
        needsPush: false,
        pushedKey: '',
        pushedAt: 0,
        healTimer: null,
        health: null, // 진행 중인 상태 확인 {client, timer}
        presence: {},
        lastConnectAt: 0,
        lastRecreateAt: now,
        downSince: now,
      };
      brokers.push(b);
      createClient(b);
      return b;
    }

    // 클라이언트 만들기 + 이벤트 연결. 모든 핸들러는 b.client 가 바뀌면(예전 클라이언트) 무시.
    function createClient(b) {
      b.client = null;
      if (!mqttLib) {
        b.state = 'offline';
        return;
      }
      let client;
      try {
        client = mqttLib.connect(b.url, {
          clientId: 'sd_' + randomId(12),
          clean: true,
          keepalive: timing.keepalive,
          reconnectPeriod: timing.reconnectPeriod,
          connectTimeout: timing.connectTimeout,
          resubscribe: false,
          will: { topic: T.presence + deviceId, payload: presencePayload(false), qos: 1, retain: true },
        });
      } catch (e) {
        b.connecting = false;
        setState(b, 'offline');
        return;
      }
      b.client = client;
      b.connecting = true;
      b.connectingSince = Date.now();
      const mine = (fn) =>
        function () {
          if (left || b.client !== client) return;
          fn.apply(null, arguments);
        };
      client.on(
        'connect',
        mine(() => {
          b.connecting = false;
          b.lastConnectAt = Date.now();
          onConnect(b, client);
        })
      );
      client.on('message', mine((topic, payload, packet) => onMessage(b, topic, payload, packet)));
      client.on(
        'reconnect',
        mine(() => {
          b.connecting = true;
          b.connectingSince = Date.now();
          setState(b, 'connecting');
        })
      );
      client.on('close', mine(() => onDown(b)));
      client.on('offline', mine(() => onDown(b)));
      client.on('error', () => {}); // 오류는 close 로 처리 (리스너가 없으면 EventEmitter 가 throw)
    }

    // 예전 클라이언트를 버리고 같은 브로커에 새 클라이언트를 만듦. reconnect() 는 절대 쓰지 않음:
    // mqtt.js 5 의 reconnect() 는 진행 중인 연결을 닫지 않고 두 번째 연결을 열어 서로를 끊게 만듦.
    function recreateBroker(b) {
      if (left) return;
      const old = b.client;
      if (old) {
        try {
          old.removeAllListeners();
          old.on('error', () => {});
        } catch (e) {
          /* 무시 */
        }
        try {
          old.end(true);
        } catch (e) {
          /* 무시 */
        }
        try {
          // disconnecting 상태로 굳은 클라이언트는 end() 가 아무것도 안 함 → 소켓을 직접 닫음
          if (old.stream && typeof old.stream.destroy === 'function') old.stream.destroy();
        } catch (e) {
          /* 무시 */
        }
      }
      stats.recreates++;
      clearTimeout(b.healTimer);
      b.healTimer = null;
      clearHealth(b);
      b.ready = false;
      b.connecting = false;
      if (b.state === 'connected') b.downSince = Date.now();
      b.lastRecreateAt = Date.now();
      createClient(b);
      if (b.client) setState(b, 'connecting');
      if (!brokers.some((x) => x.state === 'connected')) setSynced(false);
      flushAll();
    }

    // --- 상태 확인 (반쯤 열린 소켓 찾기): QoS1 접속 표시를 보내고 PUBACK 을 기다림 ---
    function clearHealth(b) {
      if (b.health) clearTimeout(b.health.timer);
      b.health = null;
    }

    function healthCheck(b) {
      const c = b.client;
      if (!c || !c.connected) return;
      if (c.disconnecting) {
        recreateBroker(b);
        return;
      }
      if (b.health) return;
      stats.healthChecks++;
      const h = { client: c, timer: null };
      b.health = h;
      h.timer = setTimeout(() => {
        if (b.health !== h) return;
        b.health = null;
        if (!left && b.client === c) recreateBroker(b);
      }, timing.healthTimeout);
      me.at = Date.now();
      try {
        c.publish(T.presence + deviceId, presencePayload(true), { qos: 1, retain: true }, (err) => {
          if (b.health !== h) return;
          clearTimeout(h.timer);
          b.health = null;
          if (left || b.client !== c) return;
          if (err) {
            recreateBroker(b);
            return;
          }
          if (b.ready) setSynced(true); // 연결이 살아 있었음 → 그동안 온 메시지도 다 받음
        });
      } catch (e) {
        clearTimeout(h.timer);
        b.health = null;
        recreateBroker(b);
      }
    }

    function midAttempt(b) {
      return b.connecting && Date.now() - b.connectingSince < timing.connectTimeout + 2000;
    }

    // --- 모바일: 다시 켜졌을 때. 언제 불러도 안전함 (몇 번이 몰려도 한 번만 실행) ---
    function scheduleResume() {
      if (left) return;
      clearTimeout(resumeTimer);
      resumeTimer = setTimeout(runResume, timing.resumeDebounce);
    }

    function runResume() {
      resumeTimer = null;
      if (left) return;
      const now = Date.now();
      if (lastResumeRun && now - lastResumeRun < timing.resumeMinGap) {
        stats.resumeSkipped++;
        announceAll();
        emitPeers();
        return;
      }
      lastResumeRun = now;
      stats.resumeRuns++;
      checkOnCommit = false;
      setSynced(false);
      for (const b of brokers) {
        const c = b.client;
        if (!c) recreateBroker(b);
        else if (!c.connected) {
          if (!midAttempt(b)) recreateBroker(b); // 핸드셰이크 중이면 그대로 둠
        } else if (c.disconnecting) recreateBroker(b);
        else healthCheck(b); // 접속 표시도 겸함
      }
      lastAnnounceTick = now;
      emitPeers();
    }

    // 굳은 클라이언트 찾기 (tick 마다)
    function watchdog() {
      const now = Date.now();
      const online = typeof navigator === 'undefined' || !navigator || navigator.onLine !== false;
      for (const b of brokers) {
        const c = b.client;
        if (!c) {
          if (mqttLib && now - b.lastRecreateAt > timing.watchdogStale) recreateBroker(b);
          continue;
        }
        if (c.connected && c.disconnecting) recreateBroker(b);
        else if (b.state === 'connected' && !c.connected) recreateBroker(b);
        else if (
          !c.connected &&
          online &&
          !midAttempt(b) &&
          now - Math.max(b.lastConnectAt, b.lastRecreateAt, b.downSince) > timing.watchdogStale
        ) {
          recreateBroker(b);
        }
      }
    }

    const onOnline = () => scheduleResume();
    const onVisible = () => {
      const v = doc && doc.visibilityState;
      if (v === 'hidden') {
        if (!hiddenAt) hiddenAt = Date.now();
        return;
      }
      if (v === 'visible') {
        if (hiddenAt && Date.now() - hiddenAt > timing.hiddenCheck) checkOnCommit = true;
        hiddenAt = 0;
        scheduleResume();
      }
    };
    const hasWindow = !!win && typeof win.addEventListener === 'function';
    const hasDocument = !!doc && typeof doc.addEventListener === 'function';
    if (hasWindow) {
      win.addEventListener('online', onOnline);
      win.addEventListener('pageshow', onOnline);
    }
    if (hasDocument) {
      doc.addEventListener('visibilitychange', onVisible);
      if (doc.visibilityState === 'hidden') hiddenAt = Date.now();
    }

    // --- 시작: 세 브로커 모두 처음부터 (두 기기가 같은 브로커를 공유하도록) ---
    for (const url of urls) makeBroker(url);
    lastAnnounceTick = Date.now();
    tickTimer = setInterval(() => {
      if (left) return;
      watchdog();
      if (Date.now() - lastAnnounceTick >= timing.presenceEvery - 50) announceAll();
      emitPeers(); // 오래된 접속 표시를 오프라인으로
    }, Math.min(timing.tick, timing.presenceEvery));
    Promise.resolve().then(() => {
      booting = false;
      emitStatus();
      emitPeers();
      if (delivery) safeCall(o.onDelivery, deliveryCopy());
    });

    function stopAll() {
      left = true;
      clearInterval(tickTimer);
      clearTimeout(resumeTimer);
      clearTimeout(announceTimer);
      for (const b of brokers) {
        clearTimeout(b.healTimer);
        clearHealth(b);
      }
      if (hasWindow) {
        win.removeEventListener('online', onOnline);
        win.removeEventListener('pageshow', onOnline);
      }
      if (hasDocument) doc.removeEventListener('visibilitychange', onVisible);
    }

    const handle = {
      room,
      deviceId,
      get doc() {
        return current;
      },
      get peers() {
        return peers;
      },
      get status() {
        return statusInfo();
      },
      // 적어도 한 브로커에서 (join / resume / 전부 끊김 이후) retained 확인을 마쳤는가
      get synced() {
        return synced;
      },
      // 내 마지막 커밋의 전달 상태 {seq, nonce, state:'pending'|'relayed'|'delivered'|'superseded', since} 또는 null
      get delivery() {
        return deliveryCopy();
      },
      // 새 판을 올림: seq/nonce/by/at/app/room/parent/anc 는 여기서 채움. 채워진 문서를 돌려줌.
      // opts.jump (1..5, 기본 1): seq = 지금 seq + jump. 기권/자리 이어받기는 2 를 써서 동시에 온 보통 수를 이김.
      commit(docIn, opts) {
        if (left) throw new Error('이미 방에서 나왔어요.');
        const j = opts && opts.jump;
        const jump = Number.isInteger(j) ? Math.min(MAX_JUMP, Math.max(1, j)) : 1;
        const d = JSON.parse(JSON.stringify(docIn || {}));
        d.app = APP;
        d.room = room;
        d.seq = (current ? current.seq : 0) + jump;
        d.nonce = randomId(16);
        d.by = deviceId;
        d.at = Date.now();
        d.parent = current ? { seq: current.seq, nonce: current.nonce } : null;
        d.anc = current ? [docKey(current)].concat(ancestorsOf(current).map(docKey)).slice(0, ANC_MAX) : [];
        if (!validDoc(d, room)) throw new Error('방 문서 모양이 잘못됐어요 (seats 2칸, game 은 null 또는 players 2명).');
        current = d;
        branch.push(d);
        if (branch.length > 50) branch = branch.slice(-50);
        lastLocal = d;
        delivery = { seq: d.seq, nonce: d.nonce, state: 'pending', since: Date.now() };
        save();
        safeCall(o.onDoc, d, { source: 'local' });
        safeCall(o.onDelivery, deliveryCopy());
        for (const b of brokers) {
          if (b.client && b.client.connected && b.ready) publishDoc(b, true);
          else b.needsPush = true; // 접속 후 retained 확인이 끝나면 올림
        }
        // 오래 숨겨져 있었으면 소켓이 반쯤 죽었을 수 있음 → 바로 확인
        if (checkOnCommit || (hiddenAt && Date.now() - hiddenAt > timing.hiddenCheck)) {
          checkOnCommit = false;
          for (const b of brokers) if (b.client && b.client.connected) healthCheck(b);
        }
        scheduleAnnounce();
        return d;
      },
      emote(str) {
        if (left) return;
        const emote = String(str == null ? '' : str).slice(0, MAX_EMOTE);
        if (!emote) return;
        const payload = JSON.stringify({ from: deviceId, emote, at: Date.now(), id: randomId(12) });
        for (const b of brokers) {
          if (b.client && b.client.connected) {
            try {
              b.client.publish(T.emote, payload, { qos: 0, retain: false });
            } catch (e) {
              /* 무시 */
            }
          }
        }
      },
      setPresence(p) {
        if (left || !p) return;
        if (typeof p.name === 'string') me.name = p.name;
        if (p.seat === 0 || p.seat === 1 || p.seat === null) me.seat = p.seat;
        for (const b of brokers) {
          // 다음 재접속부터 LWT 에도 새 이름/자리
          if (b.client && b.client.options && b.client.options.will) b.client.options.will.payload = presencePayload(false);
        }
        announceAll();
        emitPeers();
        checkDelivered();
      },
      // 다시 켜졌을 때 연결 점검. 언제 불러도 안전 (300 ms 모아서 한 번, 3 초 안에는 다시 안 함)
      resume: scheduleResume,
      // 방에서 나감: 오프라인 표시 후 깔끔하게 종료. Promise 반환
      leave() {
        if (left) return Promise.resolve();
        stopAll();
        const off = presencePayload(false);
        return Promise.all(
          brokers.map(
            (b) =>
              new Promise((resolve) => {
                const c = b.client;
                b.state = 'offline';
                if (!c) return resolve();
                let finished = false;
                const done = () => {
                  if (finished) return;
                  finished = true;
                  clearTimeout(guard);
                  resolve();
                };
                const guard = setTimeout(() => {
                  try {
                    c.end(true);
                  } catch (e) {
                    /* 무시 */
                  }
                  done();
                }, 3000);
                const endNow = (force) => {
                  try {
                    c.end(force, {}, done);
                  } catch (e) {
                    done();
                  }
                };
                if (c.connected && !c.disconnecting) {
                  try {
                    c.publish(T.presence + deviceId, off, { qos: 1, retain: true }, () => endNow(false));
                  } catch (e) {
                    endNow(true);
                  }
                } else endNow(true);
              })
          )
        ).then(() => undefined);
      },
      // 테스트용: DISCONNECT 없이 끊음 (브로커가 LWT 를 보냄)
      _crash() {
        if (left) return;
        stopAll();
        for (const b of brokers) {
          try {
            if (b.client) b.client.end(true);
          } catch (e) {
            /* 무시 */
          }
        }
      },
      // 테스트 전용 (앱은 쓰지 말 것: status / delivery / synced 를 쓰세요)
      _brokers() {
        return brokers;
      },
      _stats() {
        return Object.assign({}, stats);
      },
    };
    return handle;
  }

  const SDNet = {
    APP,
    BROKERS: BROKERS.slice(),
    ROOM_ALPHABET,
    join,
    newRoomCode,
    normalizeRoom,
    isRoomCode,
    _internal: {
      isNewer,
      sameDoc,
      validDoc,
      parseDoc,
      parsePresence,
      parseEmote,
      presenceFresh,
      payloadText,
      normalizeRoom,
      isRoomCode,
      randomId,
      lineage,
      ancestorsOf,
      brokerName,
      MAX_PAYLOAD,
      MAX_SEQ,
      MAX_SEQ_JUMP,
      ROOM_LEN,
      DEFAULT_TIMING,
    },
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = SDNet;
  else window.SDNet = SDNet;
})();
