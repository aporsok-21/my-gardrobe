// My Gardrobe backend: accounts and each person's wardrobe, in one SQLite file.
// No packages needed (Node 22.5+ has node:sqlite). It also serves the website and app,
// so `node server/server.js` replaces `python3 -m http.server`.
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { lookup } = require('./lookup');
const { classify, Anthropic } = require('./classify');
const { sendVerify } = require('./mail');

const PORT = +process.argv[2] || +process.env.PORT || 8000;
const ROOT = path.join(__dirname, '..');
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'data', 'gardrobe.db');
const SESSION_DAYS = 60;
const VERIFY_HOURS = 24;
const MAX_BODY = 25 * 1024 * 1024;   // photos are stored as JPEG data URLs inside the items
// What the app keeps per person; device preferences (theme, units, language) stay in the browser
// The Android app (Capacitor) loads the app from this origin and signs in with a bearer token instead of the cookie
const APP_ORIGINS = ['https://localhost'];
const DATA_KEYS = ['mg-items', 'mg-wash', 'mg-worn', 'mg-fav', 'mg-figure', 'mg-outfit', 'mg-outfit-prev', 'mg-worn-day', 'mg-capsule', 'mg-capsule-looks', 'mg-colours'];

fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
const db = new DatabaseSync(DB_FILE);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name TEXT NOT NULL,
    pw_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS user_data (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, key)
  );
  CREATE TABLE IF NOT EXISTS verify_tokens (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
`);
// New accounts must confirm their email before they can log in; accounts made before this count as confirmed
if (!db.prepare('PRAGMA table_info(users)').all().some((c) => c.name === 'verified')) db.exec('ALTER TABLE users ADD COLUMN verified INTEGER NOT NULL DEFAULT 1');
db.prepare('DELETE FROM verify_tokens WHERE expires_at < ?').run(Date.now());
db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());

const q = {
  userByEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
  userById: db.prepare('SELECT * FROM users WHERE id = ?'),
  addUser: db.prepare('INSERT INTO users (email, name, pw_hash, created_at, verified) VALUES (?, ?, ?, ?, 0)'),
  redoUser: db.prepare('UPDATE users SET name = ?, pw_hash = ? WHERE id = ?'),
  setVerified: db.prepare('UPDATE users SET verified = 1 WHERE id = ?'),
  addVerify: db.prepare('INSERT INTO verify_tokens (token_hash, user_id, expires_at) VALUES (?, ?, ?)'),
  verifyToken: db.prepare('SELECT user_id FROM verify_tokens WHERE token_hash = ? AND expires_at > ?'),
  dropVerify: db.prepare('DELETE FROM verify_tokens WHERE user_id = ?'),
  setPw: db.prepare('UPDATE users SET pw_hash = ? WHERE id = ?'),
  addSession: db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)'),
  session: db.prepare('SELECT user_id FROM sessions WHERE token_hash = ? AND expires_at > ?'),
  dropSession: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
  dropOtherSessions: db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?'),
  data: db.prepare('SELECT key, value FROM user_data WHERE user_id = ?'),
  putData: db.prepare(`INSERT INTO user_data (user_id, key, value, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT (user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`),
  dropData: db.prepare('DELETE FROM user_data WHERE user_id = ? AND key = ?')
};

// ---- passwords (scrypt) and session tokens (random, only their hash is stored)
function hashPw(pw) {
  const salt = crypto.randomBytes(16);
  return 'scrypt$' + salt.toString('hex') + '$' + crypto.scryptSync(pw, salt, 64).toString('hex');
}
function checkPw(pw, stored) {
  const [, salt, hash] = stored.split('$');
  const want = Buffer.from(hash, 'hex');
  const got = crypto.scryptSync(pw, Buffer.from(salt, 'hex'), want.length);
  return crypto.timingSafeEqual(want, got);
}
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
function cookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach((c) => { const i = c.indexOf('='); if (i > 0) out[c.slice(0, i).trim()] = decodeURIComponent(c.slice(i + 1).trim()); });
  return out;
}
function startSession(req, res, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  q.addSession.run(sha(token), userId, Date.now() + SESSION_DAYS * 864e5);
  if (isApp(req)) return token;   // the phone app keeps it itself
  res.setHeader('Set-Cookie', `mg_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}`);
}
const isApp = (req) => APP_ORIGINS.includes(req.headers.origin);
function sessionToken(req) {
  const m = /^Bearer (\S+)$/.exec(req.headers.authorization || '');
  return m ? m[1] : cookies(req).mg_session;
}
function currentUser(req) {
  const token = sessionToken(req);
  if (!token) return null;
  const s = q.session.get(sha(token), Date.now());
  return s ? { user: q.userById.get(s.user_id), tokenHash: sha(token) } : null;
}
const publicUser = (u) => ({ name: u.name, email: u.email });

// ---- confirming the email address: a one-time link, only its hash is stored.
// PUBLIC_URL is the server's address as people's phones reach it (falls back to the address this request came to).
const lastMail = new Map();
async function mailVerify(req, u, lang) {
  if (Date.now() - (lastMail.get(u.id) || 0) < 60e3) return;   // at most one email a minute per account
  lastMail.set(u.id, Date.now());
  const token = crypto.randomBytes(32).toString('base64url');
  q.dropVerify.run(u.id);
  q.addVerify.run(sha(token), u.id, Date.now() + VERIFY_HOURS * 36e5);
  const base = (process.env.PUBLIC_URL || 'http://' + req.headers.host).replace(/\/$/, '');
  try { await sendVerify(u.email, u.name, base + '/api/verify?t=' + token, lang); } catch (e) { console.error('verify email:', e.message); throw Object.assign(new Error('mail'), { status: 502 }); }
}

// ---- small helpers
function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const parts = [];
    req.on('data', (c) => { size += c.length; if (size > MAX_BODY) { reject(Object.assign(new Error('too big'), { status: 413 })); req.destroy(); } else parts.push(c); });
    req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
    req.on('error', reject);
  });
}
async function readJson(req) {
  try { return JSON.parse(await readBody(req) || '{}'); } catch (e) { if (e.status) throw e; throw Object.assign(new Error('bad json'), { status: 400 }); }
}
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Slow down password guessing: at most 10 failed tries per email + address in 15 minutes
const fails = new Map();
function tooManyFails(key) { const f = fails.get(key); return f && f.n >= 10 && Date.now() - f.t < 15 * 6e4; }
function noteFail(key) { const f = fails.get(key); fails.set(key, f && Date.now() - f.t < 15 * 6e4 ? { n: f.n + 1, t: f.t } : { n: 1, t: Date.now() }); }

// ---- API
async function api(req, res, url) {
  const route = req.method + ' ' + url.pathname;
  // Browsers send Origin on cross-site POST/PUT/DELETE; refuse those so other sites can't act with the cookie.
  // The Android app is the exception: it doesn't use the cookie.
  if (isApp(req)) {
    res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
    res.setHeader('Vary', 'Origin');
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Max-Age': '86400' });
      return res.end();
    }
  } else if (req.method !== 'GET' && req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) return send(res, 403, { error: 'origin' });

  if (route === 'POST /api/signup') {
    const { name, email, password, lang } = await readJson(req);
    if (!String(name || '').trim()) return send(res, 400, { error: 'name' });
    if (!EMAIL.test(email || '')) return send(res, 400, { error: 'email' });
    if (String(password || '').length < 8) return send(res, 400, { error: 'short' });
    const nm = String(name).trim().slice(0, 80), old = q.userByEmail.get(email.trim());
    if (old && old.verified) return send(res, 409, { error: 'taken' });
    // Not confirmed yet: signing up again with the same email starts over (new name, password and link)
    if (old) q.redoUser.run(nm, hashPw(password), old.id);
    else q.addUser.run(email.trim(), nm, hashPw(password), Date.now());
    await mailVerify(req, q.userByEmail.get(email.trim()), lang);
    // No session yet: they log in once the email is confirmed
    return send(res, 201, { verify: true, email: email.trim() });
  }
  if (route === 'POST /api/verify/resend') {
    const { email, lang } = await readJson(req);
    const u = q.userByEmail.get(String(email || '').trim());
    if (u && !u.verified) await mailVerify(req, u, lang);
    return send(res, 200, { ok: true });   // the same answer either way, so it doesn't tell who has an account
  }
  // The link in the email: confirm, then open the app's log-in page
  if (route === 'GET /api/verify') {
    const v = q.verifyToken.get(sha(url.searchParams.get('t') || ''), Date.now());
    if (v) { q.setVerified.run(v.user_id); q.dropVerify.run(v.user_id); }
    res.writeHead(302, { Location: '/app.html?verified=' + (v ? '1' : '0'), 'Cache-Control': 'no-store' });
    return res.end();
  }
  if (route === 'POST /api/login') {
    const { email, password } = await readJson(req);
    const key = String(email || '').toLowerCase() + '|' + req.socket.remoteAddress;
    if (tooManyFails(key)) return send(res, 429, { error: 'wait' });
    const u = q.userByEmail.get(String(email || '').trim());
    if (!u || !checkPw(String(password || ''), u.pw_hash)) { noteFail(key); return send(res, 401, { error: 'login' }); }
    fails.delete(key);
    if (!u.verified) return send(res, 403, { error: 'unverified' });
    const token = startSession(req, res, u.id);
    return send(res, 200, { user: publicUser(u), data: dataOf(u.id), token });
  }
  if (route === 'POST /api/logout') {
    const token = sessionToken(req);
    if (token) q.dropSession.run(sha(token));
    res.setHeader('Set-Cookie', 'mg_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
    return send(res, 200, { ok: true });
  }

  const me = currentUser(req);
  if (!me) return send(res, 401, { error: 'signin' });

  if (route === 'GET /api/me') return send(res, 200, { user: publicUser(me.user), data: dataOf(me.user.id) });
  if (route === 'POST /api/password') {
    const { current, next } = await readJson(req);
    if (!checkPw(String(current || ''), me.user.pw_hash)) return send(res, 400, { error: 'current' });
    if (String(next || '').length < 8) return send(res, 400, { error: 'short' });
    q.setPw.run(hashPw(next), me.user.id);
    q.dropOtherSessions.run(me.user.id, me.tokenHash);   // sign out the other devices
    return send(res, 200, { ok: true });
  }
  // "Add automatically": what a shop's product page says about the piece (signed in only, so it isn't an open proxy)
  if (route === 'POST /api/lookup') {
    const { url: link } = await readJson(req);
    try { return send(res, 200, await lookup(link)); } catch (e) { if (e.code) return send(res, 422, { error: e.code }); throw e; }
  }
  // A new piece's photo: what it is (server/classify.js). 'off' when the server has no Claude API credentials.
  if (route === 'POST /api/classify') {
    const { photo } = await readJson(req);
    try {
      const piece = await classify(photo);
      return send(res, piece ? 200 : 422, piece || { error: 'unsure' });
    } catch (e) {
      if (e.code === 'photo') return send(res, 400, { error: 'photo' });
      if (e instanceof Anthropic.AuthenticationError) return send(res, 503, { error: 'off' });
      if (e instanceof Anthropic.RateLimitError) return send(res, 503, { error: 'busy' });
      if (e instanceof Anthropic.APIError) { console.error('classify:', e.status, e.message); return send(res, 502, { error: 'ai' }); }
      // anything else is set-up (the SDK reports missing credentials with a plain Error): log it, the app carries on without
      console.error('classify unavailable:', e.message);
      return send(res, 503, { error: 'off' });
    }
  }
  // One stored value per key, exactly the text the app keeps in localStorage
  const m = url.pathname.match(/^\/api\/data\/([a-z-]+)$/);
  if (m && DATA_KEYS.includes(m[1])) {
    if (req.method === 'PUT') { q.putData.run(me.user.id, m[1], await readBody(req), Date.now()); return send(res, 200, { ok: true }); }
    if (req.method === 'DELETE') { q.dropData.run(me.user.id, m[1]); return send(res, 200, { ok: true }); }
  }
  return send(res, 404, { error: 'not found' });
}
function dataOf(userId) {
  const out = {};
  q.data.all(userId).forEach((r) => { out[r.key] = r.value; });
  return out;
}

// ---- static files (website + app)
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
  '.apk': 'application/vnd.android.package-archive' };   // release/MyGardrobe.apk, downloaded over Wi-Fi
function serveFile(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.join(ROOT, rel);
  // only the site itself: nothing outside the folder, no dotfiles, not the server or the Expo app
  const top = path.relative(ROOT, file).split(path.sep)[0];
  if (!file.startsWith(ROOT + path.sep) || /(^|[\\/])\./.test(rel) || ['server', 'app', 'node_modules', 'www', 'android', 'scripts'].includes(top)) { res.writeHead(404); return res.end('Not found'); }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Content-Length': st.size });
    fs.createReadStream(file).pipe(res);
  });
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (!url.pathname.startsWith('/api/')) return serveFile(req, res, url);
  try { await api(req, res, url); } catch (e) {
    if (!e.status) console.error(e);
    if (!res.headersSent) send(res, e.status || 500, { error: e.status ? e.message : 'server' });
  }
}).listen(PORT, () => console.log(`My Gardrobe on http://localhost:${PORT}`));
