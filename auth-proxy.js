const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const querystring = require('querystring');
const WebSocket = require('ws');

const {
  GH_OAUTH_CLIENT_ID, GH_OAUTH_CLIENT_SECRET,
  COOKIE_SECRET, PUBLIC_URL
} = process.env;

const TARGET_PORT = 7681;
const LISTEN_PORT = 8080;
const COOKIE_NAME = 'auth';
const ALLOWED_FILE = process.env.ALLOWED_FILE || 'allowed-users.txt';

function loadAllowedUsers() {
  try {
    return fs.readFileSync(ALLOWED_FILE, 'utf8')
      .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  } catch (e) { return []; }
}
function isAllowedUser(u) { return loadAllowedUsers().includes(u.toLowerCase()); }

function sign(data) { return crypto.createHmac('sha256', COOKIE_SECRET).update(data).digest('hex'); }
function makeCookie(username) {
  const exp = Date.now() + 1000 * 60 * 60 * 12;
  const payload = `${username}.${exp}`;
  return `${payload}.${sign(payload)}`;
}
function checkCookie(value) {
  if (!value) return false;
  const parts = value.split('.');
  if (parts.length !== 3) return false;
  const [username, exp, sig] = parts;
  const payload = `${username}.${exp}`;
  if (sign(payload) !== sig) return false;
  if (Date.now() > Number(exp)) return false;
  return isAllowedUser(username);
}
function getCookieFromHeader(header) {
  header = header || '';
  const match = header.split(';').map(s => s.trim()).find(s => s.startsWith(COOKIE_NAME + '='));
  return match ? match.split('=')[1] : null;
}
function isAuthedReq(req) { return checkCookie(getCookieFromHeader(req.headers.cookie)); }

function httpsPost(hostname, path, body) {
  return new Promise((resolve, reject) => {
    const data = querystring.stringify(body);
    const req = https.request({ hostname, path, method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(data),
        'Accept': 'application/json'
      }
    }, res => {
      let out = ''; res.on('data', c => out += c);
      res.on('end', () => { try { resolve(JSON.parse(out)); } catch (e) { reject(e); } });
    });
    req.on('error', reject); req.write(data); req.end();
  });
}
function httpsGet(hostname, path, token) {
  return new Promise((resolve, reject) => {
    https.request({ hostname, path, method: 'GET',
      headers: { 'User-Agent': 'auth-proxy', 'Authorization': `Bearer ${token}` }
    }, res => {
      let out = ''; res.on('data', c => out += c);
      res.on('end', () => { try { resolve(JSON.parse(out)); } catch (e) { reject(e); } });
    }).on('error', reject).end();
  });
}

// ---- Global queue: only one submitted line flushes to ttyd at a time ----
let flushQueue = Promise.resolve();
function enqueueFlush(fn) {
  flushQueue = flushQueue.then(() => fn().catch(() => {}));
  return flushQueue;
}

const PAGE = `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/xterm/5.3.0/css/xterm.min.css" />
<script src="https://cdnjs.cloudflare.com/ajax/libs/xterm/5.3.0/lib/xterm.min.js"></script>
<style>
html,body{background:#000;margin:0;padding:0;height:100%}
#term{height:85vh;padding:6px;box-sizing:border-box}
#bar{display:flex;padding:6px;background:#111}
#in{flex:1;background:#000;color:#0f0;border:1px solid #333;padding:10px;font-family:monospace;font-size:16px}
button{padding:10px 18px;margin-left:6px;font-size:16px}
#status{color:#888;font-size:12px;padding:0 6px;font-family:monospace;height:16px}
</style></head><body>
<div id="term"></div>
<div id="bar">
  <input id="in" autocomplete="off" autocapitalize="off" autocorrect="off" placeholder="type command, press Enter"/>
  <button id="sendBtn">Send</button>
</div>
<div id="status"></div>
<script>
const term = new Terminal({ convertEol: true, disableStdin: true, fontSize: 14, cols: 120, rows: 32, theme: { background: '#000' } });
term.open(document.getElementById('term'));

const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
const ws = new WebSocket(proto + '//' + location.host + '/ws', 'tty');
ws.binaryType = 'arraybuffer';

ws.addEventListener('open', () => {
  ws.send(JSON.stringify({ AuthToken: '', columns: 120, rows: 32 }));
});

ws.addEventListener('message', (ev) => {
  const data = typeof ev.data === 'string' ? ev.data : new TextDecoder('utf-8').decode(ev.data);
  if (data.length > 0 && data[0] === '0') {
    term.write(data.slice(1));
  }
});

const inp = document.getElementById('in');
const status = document.getElementById('status');
const sendBtn = document.getElementById('sendBtn');

function send(){
  const cmd = inp.value;
  if (!cmd) return;
  inp.value = '';
  status.textContent = 'sending...';
  ws.send('0' + cmd + '\\r');
  status.textContent = '';
  inp.focus();
}
sendBtn.addEventListener('click', send);
inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); send(); } });
</script></body></html>`;

// ---- HTTP server ----
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, PUBLIC_URL);

  if (url.pathname === '/auth/callback') {
    const code = url.searchParams.get('code');
    if (!code) { res.writeHead(400); return res.end('Missing code'); }
    try {
      const tokenResp = await httpsPost('github.com', '/login/oauth/access_token', {
        client_id: GH_OAUTH_CLIENT_ID,
        client_secret: GH_OAUTH_CLIENT_SECRET,
        code
      });
      if (!tokenResp.access_token) { res.writeHead(401); return res.end('OAuth failed'); }
      const user = await httpsGet('api.github.com', '/user', tokenResp.access_token);
      if (!isAllowedUser(user.login)) { res.writeHead(403); return res.end('Not authorized'); }
      res.writeHead(302, {
        'Set-Cookie': `${COOKIE_NAME}=${makeCookie(user.login)}; HttpOnly; Path=/; Max-Age=43200`,
        'Location': '/'
      });
      return res.end();
    } catch (e) {
      res.writeHead(500); return res.end('Auth error: ' + e.message);
    }
  }

  if (!isAuthedReq(req)) {
    const authorizeUrl = `https://github.com/login/oauth/authorize?client_id=${GH_OAUTH_CLIENT_ID}&redirect_uri=${encodeURIComponent(PUBLIC_URL + '/auth/callback')}`;
    res.writeHead(302, { 'Location': authorizeUrl });
    return res.end();
  }

  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(PAGE);
});

// ---- WebSocket: bridge our custom client <-> ttyd, serialized submits ----
const wss = new WebSocket.Server({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  if (!isAuthedReq(req)) { socket.destroy(); return; }
  if (!req.url.startsWith('/ws')) { socket.destroy(); return; }

  wss.handleUpgrade(req, socket, head, (clientWs) => {
    const upstream = new WebSocket(`ws://127.0.0.1:${TARGET_PORT}/ws`, 'tty');
    let gotFirst = false;

    upstream.on('message', (data) => {
      if (clientWs.readyState === WebSocket.OPEN) clientWs.send(data);
    });
    upstream.on('close', () => clientWs.close());
    upstream.on('error', () => clientWs.close());

    clientWs.on('message', (data) => {
      if (upstream.readyState !== WebSocket.OPEN) return;

      // first message: our own JSON handshake, pass straight through
      if (!gotFirst) { gotFirst = true; upstream.send(data); return; }

      // every subsequent message from our custom client is one complete,
      // deliberately-submitted line - serialize so submits never interleave
      enqueueFlush(() => new Promise((resolve) => {
        if (upstream.readyState === WebSocket.OPEN) {
          upstream.send(data);
        }
        resolve();
      }));
    });

    clientWs.on('close', () => upstream.close());
    clientWs.on('error', () => upstream.close());
  });
});

server.listen(LISTEN_PORT, () => console.log(`Auth proxy on :${LISTEN_PORT}`));
