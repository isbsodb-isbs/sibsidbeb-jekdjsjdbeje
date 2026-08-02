const http = require('http');
const https = require('https');
const crypto = require('crypto');
const net = require('net');
const fs = require('fs');
const querystring = require('querystring');

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
    const raw = fs.readFileSync(ALLOWED_FILE, 'utf8');
    return raw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  } catch (e) {
    console.error(`Could not read ${ALLOWED_FILE}:`, e.message);
    return [];
  }
}

function isAllowedUser(username) {
  return loadAllowedUsers().includes(username.toLowerCase());
}

function sign(data) {
  return crypto.createHmac('sha256', COOKIE_SECRET).update(data).digest('hex');
}

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

function isAuthed(req) {
  return checkCookie(getCookie(req));
}

function httpsPost(hostname, path, body) {
  return new Promise((resolve, reject) => {
    const data = querystring.stringify(body);
    const req = https.request({
      hostname, path, method: 'POST',
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
    https.request({
      hostname, path, method: 'GET',
      headers: { 'User-Agent': 'auth-proxy', 'Authorization': `Bearer ${token}` }
    }, res => {
      let out = '';
      res.on('data', c => out += c);
      res.on('end', () => { try { resolve(JSON.parse(out)); } catch (e) { reject(e); } });
    }).on('error', reject).end();
  });
}

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

server.on('upgrade', (req, clientSocket, head) => {
  if (!isAuthed(req)) { clientSocket.destroy(); return; }
  const proxySocket = net.connect(TARGET_PORT, '127.0.0.1', () => {
    proxySocket.write(
      `${req.method} ${req.url} HTTP/1.1\r\n` +
      Object.entries(req.headers).map(([k, v]) => `${k}: ${v}`).join('\r\n') +
      '\r\n\r\n'
    );
    if (head && head.length) proxySocket.write(head);
    proxySocket.pipe(clientSocket);
    clientSocket.pipe(proxySocket);
  });
  proxySocket.on('error', () => clientSocket.destroy());
  clientSocket.on('error', () => proxySocket.destroy());
});

server.listen(LISTEN_PORT, () => console.log(`Auth proxy on :${LISTEN_PORT}`));
