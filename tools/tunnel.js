'use strict';
// 인터넷 초대 링크: 같은 와이파이가 아닌 상대도 들어올 수 있는 https 주소를 만들어요.
// 사용하는 순서: 이 게임 폴더 .tunnel 안의 cloudflared → 옆 게임 폴더(아발론, 초성퀴즈 등)의 .tunnel 안 cloudflared
//               → 컴퓨터에 설치된 cloudflared(PATH) → 기본 ssh(localhost.run)
// 연결이 소리 없이 끊기는 경우가 있어서, 링크가 실제로 열리는지 주기적으로 직접 확인하고 안 되면 다시 연결해요.
// 이 컴퓨터와 서버 창이 켜져 있는 동안만 유지돼요.

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DIR = path.join(ROOT, '.tunnel');
const EXE = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
const SIBLINGS = ['아발론', '초성퀴즈']; // 이미 cloudflared 를 받아 둔 사용자의 다른 게임 폴더
const state = { status: 'off', url: null, error: null, provider: null, verified: false, since: 0 };
let proc = null;
let port = 8080;
let wantOn = false;
let restarts = []; // 최근 다시 연결한 시각 (너무 잦으면 멈춤)
let probeTimer = null;
let fails = 0;

function which(cmd) {
  try {
    const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { encoding: 'utf8', windowsHide: true });
    if (r.status === 0) return r.stdout.split(/\r?\n/)[0].trim() || null;
  } catch {}
  return null;
}

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

// cloudflared 를 찾을 후보 위치 (앞에 있을수록 먼저)
function cloudflaredCandidates() {
  const out = [path.join(DIR, EXE)];
  const parent = path.dirname(path.resolve(ROOT));
  for (const name of SIBLINGS) out.push(path.join(parent, name, '.tunnel', EXE));
  // 그 밖의 옆 폴더들
  try {
    for (const ent of fs.readdirSync(parent, { withFileTypes: true })) {
      if (ent.isDirectory() && !SIBLINGS.includes(ent.name)) out.push(path.join(parent, ent.name, '.tunnel', EXE));
    }
  } catch {}
  // 이 게임 폴더가 바탕 화면이 아닌 곳에 있을 때를 위해 바탕 화면의 게임 폴더도 확인
  const home = os.homedir();
  for (const desk of [path.join(home, 'OneDrive', '바탕 화면'), path.join(home, 'Desktop'), path.join(home, 'OneDrive', 'Desktop')]) {
    for (const name of SIBLINGS) out.push(path.join(desk, name, '.tunnel', EXE));
  }
  return [...new Set(out.map((p) => path.resolve(p)))];
}

function findCloudflared() {
  for (const p of cloudflaredCandidates()) if (isFile(p)) return p;
  return which('cloudflared');
}

function plan() {
  const cf = findCloudflared();
  if (cf) {
    return {
      provider: 'Cloudflare',
      cmd: cf,
      args: ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`],
      re: /https:\/\/[a-z0-9-]+\.trycloudflare\.com/,
    };
  }
  const ssh = which('ssh');
  if (!ssh) return null;
  fs.mkdirSync(DIR, { recursive: true });
  return {
    provider: 'localhost.run',
    cmd: ssh,
    args: [
      '-T',
      '-o', 'StrictHostKeyChecking=accept-new',
      '-o', `UserKnownHostsFile=${path.join(DIR, 'known_hosts')}`, // 사용자 ssh 설정은 건드리지 않음
      '-o', 'ServerAliveInterval=20',
      '-o', 'ServerAliveCountMax=3',
      '-o', 'ExitOnForwardFailure=yes',
      '-o', 'BatchMode=yes',
      // localhost 는 IPv6(::1)로 풀릴 수 있어 반드시 127.0.0.1 로 연결
      '-R', `80:127.0.0.1:${port}`,
      'nokey@localhost.run',
    ],
    // 안내문의 다른 주소(admin.localhost.run 등)가 아니라 "tunneled with tls termination, https://…" 줄의 주소
    re: /tunneled with tls termination, (https:\/\/[a-z0-9.-]+)/,
  };
}

function lastLine(text) {
  const lines = text
    .replace(/\x1b\[[0-9;]*m/g, '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^[\s█▀▄]+$/.test(l));
  return lines[lines.length - 1] || '';
}

function launch() {
  const p = plan();
  if (!p) {
    wantOn = false;
    Object.assign(state, {
      status: 'error',
      url: null,
      verified: false,
      error: '이 컴퓨터에서 연결 프로그램(cloudflared 또는 ssh)을 찾을 수 없어요. 같은 와이파이 주소나 GitHub Pages 를 이용해 주세요.',
    });
    console.log(`\n  ⚠ ${state.error}\n`);
    return;
  }
  Object.assign(state, { status: 'starting', provider: p.provider, verified: false });
  let out = '';
  const child = spawn(p.cmd, p.args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  proc = child;
  const onData = (d) => {
    out = (out + d.toString()).slice(-8000);
    if (state.status !== 'starting' || proc !== child) return;
    const m = out.match(p.re);
    const url = m && (m[1] || m[0]);
    if (url && !/admin\./.test(url)) {
      Object.assign(state, { status: 'on', url, error: null, verified: false, since: Date.now() });
      fails = 0;
      console.log(`\n  🌐 인터넷 초대 주소: ${url}  (확인 중…)\n`);
      scheduleProbe(5000);
    }
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  child.on('error', (e) => {
    if (proc !== child) return;
    proc = null;
    wantOn = false;
    Object.assign(state, { status: 'error', url: null, verified: false, error: e.message });
  });
  child.on('exit', (code) => {
    if (proc !== child) return; // 우리가 일부러 끈 경우
    proc = null;
    if (wantOn) restart('연결이 끊겨 다시 연결하는 중이에요…');
    else Object.assign(state, { status: 'error', url: null, verified: false, error: lastLine(out) || `연결 프로그램이 종료됐어요 (코드 ${code})` });
  });
  // 40초 안에 주소를 받지 못하면 다시 시도
  setTimeout(() => {
    if (proc === child && state.status === 'starting') restart('주소를 받지 못해 다시 시도하는 중이에요…');
  }, 40000).unref();
}

// 끊긴 연결을 버리고 새로 연결 (10분에 6번 넘게 실패하면 멈춤)
function restart(reason) {
  clearTimeout(probeTimer);
  const now = Date.now();
  restarts = restarts.filter((t) => now - t < 10 * 60 * 1000);
  const p = proc;
  proc = null;
  if (p) p.kill();
  if (restarts.length >= 6) {
    wantOn = false;
    Object.assign(state, { status: 'error', url: null, verified: false, error: '인터넷 연결이 계속 끊겨서 멈췄어요. 인터넷 상태를 확인한 뒤 다시 시도해 주세요.' });
    console.log('\n  ⚠ 인터넷 초대 링크를 유지하지 못했어요.\n');
    return;
  }
  restarts.push(now);
  Object.assign(state, { status: 'starting', url: null, verified: false, error: reason });
  console.log(`\n  ↻ ${reason}\n`);
  setTimeout(() => wantOn && !proc && launch(), 1500).unref();
}

// 링크가 정말 열리는지 인터넷을 거쳐 직접 확인 ("no tunnel here" 같은 조용한 끊김을 잡아냄)
function scheduleProbe(ms) {
  clearTimeout(probeTimer);
  probeTimer = setTimeout(probe, ms);
  probeTimer.unref();
}

async function probe() {
  if (state.status !== 'on' || !state.url) return;
  const url = state.url;
  let ok = false;
  try {
    const r = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(8000), cache: 'no-store' });
    ok = r.ok && (await r.text()).trim() === 'ok';
  } catch {}
  if (state.status !== 'on' || state.url !== url) return; // 그사이 바뀜
  if (ok) {
    fails = 0;
    if (!state.verified) {
      state.verified = true;
      console.log(`  ✓ 인터넷 초대 링크가 잘 열려요: ${url}`);
      console.log('    멀리 있는 상대에게는 게임 화면의 초대 링크(이 주소 + 방 코드)를 보내 주세요.\n');
    }
    return scheduleProbe(20000);
  }
  fails++;
  // 처음 만든 직후에는 주소가 퍼지는 데 시간이 걸릴 수 있어 1분까지는 기다림
  const young = !state.verified && Date.now() - state.since < 60000;
  if (young || (state.verified && fails < 2)) return scheduleProbe(state.verified ? 7000 : 5000);
  restart('인터넷 링크가 열리지 않아 다시 연결하는 중이에요…');
}

function start(serverPort) {
  port = serverPort || port;
  if (state.status === 'on' || state.status === 'starting') return info();
  wantOn = true;
  restarts = [];
  launch();
  return info();
}

function stop() {
  wantOn = false;
  clearTimeout(probeTimer);
  if (proc) {
    const p = proc;
    proc = null;
    p.kill();
  }
  Object.assign(state, { status: 'off', url: null, error: null, verified: false });
  return info();
}

const info = () => ({
  status: state.status,
  url: state.url,
  error: state.error,
  provider: state.provider,
  verified: state.verified,
  since: state.since,
});

// 서버가 꺼지면 연결 프로그램도 닫기
process.on('exit', () => proc && proc.kill());
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    if (proc) proc.kill();
    process.exit(0);
  });
}

module.exports = { start, stop, info, findCloudflared, cloudflaredCandidates };
