'use strict';
// 스플렌더 대결 — PC 에서 게임 파일을 보여 주는 작은 서버 (외부 모듈 없음)
// 실행: node tools/serve.js [--tunnel] [--open]      포트 변경: set PORT=9000 && node tools/serve.js
//   --tunnel  같은 와이파이가 아닌 상대도 들어올 수 있는 인터넷 주소를 만들어요 (tools/tunnel.js)
//   --open    서버가 뜨면 이 컴퓨터의 브라우저로 게임을 열어요

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};
// 개발 중에는 고친 내용이 바로 보이게 캐시하지 않음
const NO_STORE = new Set(['.html', '.js', '.mjs', '.css', '.json', '.webmanifest']);
const SERVER_TAG = 'splendor-duel'; // /healthz 응답 헤더로 "우리 서버"인지 구분

let tunnel = null; // --tunnel 일 때만 불러옴

function tunnelInfo() {
  if (tunnel) return tunnel.info();
  return { status: 'off', url: null, error: null, provider: null, verified: false, since: 0 };
}

function send(res, code, type, body, extra) {
  res.writeHead(code, Object.assign({ 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }, extra));
  res.end(body);
}

// URL 경로 → 프로젝트 안의 실제 파일 경로 (밖으로 나가거나 숨김 폴더면 null)
function resolvePath(urlPath) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(urlPath, 'http://localhost').pathname);
  } catch {
    return null;
  }
  if (pathname.includes('\0') || pathname.includes('\\')) return null;
  const parts = pathname.split('/').filter(Boolean);
  // .tunnel, .git 같은 숨김 폴더와 node_modules 는 보여 주지 않음 (인터넷 링크로도 열리므로)
  if (parts.some((p) => p.startsWith('.') || p === 'node_modules')) return null;
  const file = path.resolve(ROOT, ...parts);
  if (file !== ROOT && !file.startsWith(ROOT + path.sep)) return null;
  return file;
}

function handle(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    send(res, 405, 'text/plain; charset=utf-8', 'Method Not Allowed', { Allow: 'GET, HEAD' });
    return;
  }
  let pathname = '/';
  try {
    pathname = new URL(req.url, 'http://localhost').pathname;
  } catch {}
  if (pathname === '/healthz') {
    send(res, 200, 'text/plain; charset=utf-8', 'ok', { 'X-Server': SERVER_TAG });
    return;
  }
  if (pathname === '/tunnel.json') {
    const t = tunnelInfo();
    send(res, 200, 'application/json; charset=utf-8', JSON.stringify({ status: t.status, url: t.url, verified: !!t.verified, provider: t.provider || null, error: t.error || null }), {
      'Access-Control-Allow-Origin': '*',
    });
    return;
  }
  const file = resolvePath(req.url);
  if (!file) {
    send(res, 403, 'text/plain; charset=utf-8', 'Forbidden');
    return;
  }
  fs.stat(file, (err, st) => {
    let target = file;
    if (!err && st.isDirectory()) target = path.join(file, 'index.html');
    fs.stat(target, (err2, st2) => {
      if (err2 || !st2.isFile()) {
        send(res, 404, 'text/plain; charset=utf-8', '파일을 찾을 수 없어요 (404)');
        return;
      }
      const ext = path.extname(target).toLowerCase();
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Content-Length': st2.size,
        'Cache-Control': NO_STORE.has(ext) ? 'no-store' : 'no-cache',
        'X-Content-Type-Options': 'nosniff',
      });
      if (req.method === 'HEAD') return res.end();
      const stream = fs.createReadStream(target);
      stream.on('error', () => res.destroy());
      stream.pipe(res);
    });
  });
}

// 같은 공유기에 연결된 휴대폰이 접속할 주소 (가상 어댑터는 뒤로 미룸)
function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) {
      if ((a.family !== 'IPv4' && a.family !== 4) || a.internal || a.address.startsWith('169.254.')) continue;
      let score = 0;
      if (/wi-?fi|wlan|wireless|무선/i.test(name)) score += 3;
      else if (/ethernet|이더넷|^eth|^en/i.test(name)) score += 2;
      if (/vethernet|virtual|vmware|vbox|hyper-v|wsl|docker|loopback|bluetooth|tailscale|zerotier|hamachi/i.test(name)) score -= 10;
      if (a.address.startsWith('192.168.')) score += 1;
      out.push({ ip: a.address, score });
    }
  }
  return out.sort((x, y) => y.score - x.score).map((x) => x.ip);
}

function listen(port, host) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handle);
    server.once('error', reject);
    server.listen(port, host, () => resolve(server));
  });
}

// 이미 이 게임 서버가 그 포트에서 돌고 있는가?
async function isOurs(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1500) });
    return r.headers.get('x-server') === SERVER_TAG && (await r.text()) === 'ok';
  } catch {
    return false;
  }
}

// 포트가 사용 중이면 다음 포트로 (최대 20개)
async function start(port = Number(process.env.PORT) || 8080, host = process.env.HOST || '0.0.0.0') {
  let lastErr;
  for (let p = port; p < port + 20; p++) {
    try {
      return { server: await listen(p, host), existing: false };
    } catch (err) {
      lastErr = err;
      if (err.code !== 'EADDRINUSE' && err.code !== 'EACCES') throw err;
      if (await isOurs(p)) return { server: null, existing: true, port: p };
    }
  }
  throw lastErr;
}

function openBrowser(url) {
  try {
    const cmd = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    const args = process.platform === 'win32' ? ['/c', 'start', '""', url] : [url];
    spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: process.platform === 'win32' }).unref();
  } catch {}
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  const wantTunnel = argv.includes('--tunnel');
  const wantOpen = argv.includes('--open');
  start()
    .then(({ server, existing, port: busyPort }) => {
      if (existing) {
        console.log(`\n  💎 스플렌더 대결 서버가 이미 켜져 있어요. 브라우저에서 http://localhost:${busyPort} 을 열면 돼요.\n`);
        if (wantOpen) openBrowser(`http://localhost:${busyPort}`);
        process.exit(0);
      }
      const port = server.address().port;
      const local = `http://localhost:${port}`;
      console.log('');
      console.log('  💎 스플렌더 대결 서버가 열렸어요!');
      console.log('');
      console.log(`  이 컴퓨터에서:      ${local}`);
      for (const ip of lanAddresses()) console.log(`  같은 와이파이에서:  http://${ip}:${port}`);
      console.log('');
      if (wantTunnel) {
        tunnel = require('./tunnel');
        console.log('  🌐 멀리 있는 상대를 위한 인터넷 주소를 만드는 중이에요… (잠시만 기다려 주세요)');
        tunnel.start(port);
      } else {
        console.log('  (멀리 있는 상대와 하려면 --tunnel 을 붙여 실행하거나 GitHub Pages 주소를 쓰세요)');
      }
      console.log('  종료하려면 이 창에서 Ctrl+C 를 누르세요.');
      console.log('');
      if (wantOpen) openBrowser(local);
    })
    .catch((err) => {
      if (err && err.code === 'EADDRINUSE') {
        console.error(`\n  ${err.port}번 근처 포트를 모두 다른 프로그램이 쓰고 있어요. 다른 포트로 실행해 보세요: set PORT=9000 && node tools/serve.js\n`);
      } else console.error('\n  서버를 열지 못했어요:', err && err.message, '\n');
      process.exit(1);
    });
}

module.exports = { start, handle, resolvePath, lanAddresses, MIME };
