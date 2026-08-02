const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const { execFile } = require('child_process');
const querystring = require('querystring');

const {
  GH_OAUTH_CLIENT_ID, GH_OAUTH_CLIENT_SECRET,
  COOKIE_SECRET, PUBLIC_URL
} = process.env;

const LISTEN_PORT = 8080;
const COOKIE_NAME = 'auth';
const ALLOWED_FILE = process.env.ALLOWED_FILE || 'allowed-users.txt';
const TMUX_SESSION = 'chomens';

function loadAllowedUsers() {
  try {
    return fs.readFileSync(ALLOWED_FILE, 'utf8')
      .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  } catch (e) {
    console.error(`Could not read ${ALLOWED_FILE}:`, e.message);
    return [];
  }
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
function getCookie(req) {
  const header = req.headers.cookie || '';
  const match = header.split(';').map(s => s.trim()).find(s => s.startsWith(COOKIE_NAME + '='));
  return match ? match.split('=')[1] : null;
}
function isAuthed(req) { return checkCookie(getCookie(req)); }

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
      let out = '';
      res.on('data', c => out += c);
      res.on('end', () => { try { resolve(JSON.parse(out)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}
function httpsGet(hostname, path, token) {
  return new Promise((resolve, reject) => {
    https.request({ hostname, path, method: 'GET',
      headers: { 'User-Agent': 'auth-proxy', 'Authorization': `Bearer ${token}` }
    }, res => {
      let out = '';
      res.on('data', c => out += c);
      res.on('end', () => { try { resolve(JSON.parse(out)); } catch (e) { reject(e); } });
    }).on('error', reject).end();
  });
}

let sendQueue = Promise.resolve();
function queueSend(cmd) {
  sendQueue = sendQueue.then(() => new Promise((resolve) => {
    execFile('tmux', ['send-keys', '-t', TMUX_SESSION, '-l', '--', cmd], () => {
      execFile('tmux', ['send-keys', '-t', TMUX_SESSION, 'Enter'], () => {
        resolve();
      });
    });
  }));
  return sendQueue;
}

const PAGE = `<!doctype html><html><head><meta charset="utf-8">
<style>
body{background:#111;color:#0f0;font-family:monospace;margin:0;padding:10px}
#out{white-space:pre-wrap;height:80vh;overflow-y:auto;border:1px solid #333;padding:8px}
#in{width:80%;background:#000;color:#0f0;border:1px solid #333;padding:6px}
button{padding:6px 12px}
#status{color:#888;font-size:12px;margin-top:4px}
</style></head><body>
<div id="out"></div>
<input id="in" autocomplete="off" placeholder="type command, press Enter"/>
<button onclick="send()">Send</button>
<div id="status"></div>
<script>
const out = document.getElementById('out');
const inp = document.getElementById('in');
const status = document.getElementById('status');
async function poll(){
  try {
    const r = await fetch('/api/output');
    const t = await r.text();
    out.textContent = t;
    out.scrollTop = out.scrollHeight;
  } catch(e){}
  setTimeout(poll, 1000);
}
async function send(){
  const cmd = inp.value;
  if (!cmd) return;
  inp.value = '';
  inp.disabled = true;
  status.textContent = 'sending...';
  try {
    await fetch('/api/send', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({cmd}) });
  } catch(e){}
  status.textContent = '';
  inp.disabled = false;
  inp.focus();
}
inp.addEventListener('keydown', e => { if (e.key === 'Enter') send(); });
poll();
</script></body></html>`;

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

  if (!isAuthed(req)) {
    const authorizeUrl = `https://github.com/login/oauth/authorize?client_id=${GH_OAUTH_CLIENT_ID}&redirect_uri=${encodeURIComponent(PUBLIC_URL + '/auth/callback')}`;
    res.writeHead(302, { 'Location': authorizeUrl });
    return res.end();
  }

  if (url.pathname === '/api/output') {
    execFile('tmux', ['capture-pane', '-t', TMUX_SESSION, '-p', '-S', '-2000'], (err, stdout) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(err ? 'tmux session not found' : stdout);
    });
    return;
  }

  if (url.pathname === '/api/send' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      let cmd;
      try { cmd = JSON.parse(body).cmd; } catch (e) { res.writeHead(400); return res.end('bad json'); }
      if (typeof cmd !== 'string') { res.writeHead(400); return res.end('bad cmd'); }
      await queueSend(cmd);
      res.writeHead(200); res.end('ok');
    });
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(PAGE);
});

server.listen(LISTEN_PORT, () => console.log(`Console on :${LISTEN_PORT}`));
