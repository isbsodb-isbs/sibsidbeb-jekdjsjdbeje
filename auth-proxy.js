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

// ---- Global queue: only one committed line flushes to ttyd at a time ----
let flushQueue = Promise.resolve();
function enqueueFlush(fn) {
  flushQueue = flushQueue.then(() => fn().catch(() => {}));
  return flushQueue;
}

// ---- HTTP server: auth + reverse proxy to ttyd's static assets ----
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

  // authed -> reverse proxy straight to ttyd's HTTP (serves its real frontend, unmodified)
  const proxyReq = http.request({
    hostname: '127.0.0.1', port: TARGET_PORT,
    path: req.url, method: req.method, headers: req.headers
  }, proxyRes => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
  });
  req.pipe(proxyReq);
  proxyReq.on('error', () => { res.writeHead(502); res.end('Bad gateway'); });
});

// ---- WebSocket: intercept at message level ----
const wss = new WebSocket.Server({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  if (!isAuthedReq(req)) { socket.destroy(); return; }

  wss.handleUpgrade(req, socket, head, (clientWs) => {
    const upstream = new WebSocket(`ws://127.0.0.1:${TARGET_PORT}${req.url}`, 'tty');

    let gotFirst = false;
    let buf = '';

    upstream.on('message', (data) => {
      if (clientWs.readyState === WebSocket.OPEN) clientWs.send(data);
    });
    upstream.on('close', () => clientWs.close());
    upstream.on('error', () => clientWs.close());

    clientWs.on('message', (data) => {
      if (upstream.readyState !== WebSocket.OPEN) return;

      // first message is the ttyd init JSON (auth token + size) - pass through untouched
      if (!gotFirst) { gotFirst = true; upstream.send(data); return; }

      const str = data.toString('binary');
      const cmd = str[0];

      if (cmd !== '0') {
        // resize / other control commands forward immediately
        upstream.send(data);
        return;
      }

      const payload = str.slice(1);
      for (const ch of payload) {
        const code = ch.charCodeAt(0);
        if (ch === '\r' || ch === '\n') {
          const line = buf;
          buf = '';
          enqueueFlush(() => new Promise((resolve) => {
            if (upstream.readyState === WebSocket.OPEN) {
              upstream.send('0' + line + '\r');
            }
            resolve();
          }));
        } else if (code === 0x7f || code === 0x08) {
          // backspace: edit local buffer only, echo erase to this client only
          if (buf.length > 0) {
            buf = buf.slice(0, -1);
            if (clientWs.readyState === WebSocket.OPEN) clientWs.send('0\b \b');
          }
        } else {
          buf += ch;
          if (clientWs.readyState === WebSocket.OPEN) clientWs.send('0' + ch);
        }
      }
    });

    clientWs.on('close', () => upstream.close());
    clientWs.on('error', () => upstream.close());
  });
});

server.listen(LISTEN_PORT, () => console.log(`Auth proxy on :${LISTEN_PORT}`));
