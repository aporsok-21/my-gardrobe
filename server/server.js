// My Gardrobe backend: accounts and each person's wardrobe, in one SQLite file.
// No packages needed (Node 22.5+ has node:sqlite). It also serves the website and app,
// so `node server/server.js` replaces `python3 -m http.server`.
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = +process.argv[2] || +process.env.PORT || 8000;
const ROOT = path.join(__dirname, '..');
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'data', 'gardrobe.db');
const SESSION_DAYS = 60;
const MAX_BODY = 25 * 1024 * 1024;   // photos are stored as JPEG data URLs inside the items
// What the app keeps per person; device preferences (theme, units, language) stay in the browser
const DATA_KEYS = ['mg-items', 'mg-wash', 'mg-worn', 'mg-fav', 'mg-figure', 'mg-outfit', 'mg-outfit-prev', 'mg-worn-day'];

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
`);
db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());

const q = {
  userByEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
  userById: db.prepare('SELECT * FROM users WHERE id = ?'),
  addUser: db.prepare('INSERT INTO users (email, name, pw_hash, created_at) VALUES (?, ?, ?, ?)'),
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
function startSession(res, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  q.addSession.run(sha(token), userId, Date.now() + SESSION_DAYS * 864e5);
  res.setHeader('Set-Cookie', `mg_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}`);
}
function currentUser(req) {
  const token = cookies(req).mg_session;
  if (!token) return null;
  const s = q.session.get(sha(token), Date.now());
  return s ? { user: q.userById.get(s.user_id), tokenHash: sha(token) } : null;
}
const publicUser = (u) => ({ name: u.name, email: u.email });

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
  // Browsers send Origin on cross-site POST/PUT/DELETE; refuse those so other sites can't act with the cookie
  if (req.method !== 'GET' && req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) return send(res, 403, { error: 'origin' });

  if (route === 'POST /api/signup') {
    const { name, email, password } = await readJson(req);
    if (!String(name || '').trim()) return send(res, 400, { error: 'name' });
    if (!EMAIL.test(email || '')) return send(res, 400, { error: 'email' });
    if (String(password || '').length < 8) return send(res, 400, { error: 'short' });
    if (q.userByEmail.get(email.trim())) return send(res, 409, { error: 'taken' });
    const r = q.addUser.run(email.trim(), String(name).trim().slice(0, 80), hashPw(password), Date.now());
    startSession(res, Number(r.lastInsertRowid));
    return send(res, 201, { user: { name: String(name).trim(), email: email.trim() }, data: {} });
  }
  if (route === 'POST /api/login') {
    const { email, password } = await readJson(req);
    const key = String(email || '').toLowerCase() + '|' + req.socket.remoteAddress;
    if (tooManyFails(key)) return send(res, 429, { error: 'wait' });
    const u = q.userByEmail.get(String(email || '').trim());
    if (!u || !checkPw(String(password || ''), u.pw_hash)) { noteFail(key); return send(res, 401, { error: 'login' }); }
    fails.delete(key);
    startSession(res, u.id);
    return send(res, 200, { user: publicUser(u), data: dataOf(u.id) });
  }
  if (route === 'POST /api/logout') {
    const token = cookies(req).mg_session;
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
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
function serveFile(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.join(ROOT, rel);
  // only the site itself: nothing outside the folder, no dotfiles, not the server or the Expo app
  const top = path.relative(ROOT, file).split(path.sep)[0];
  if (!file.startsWith(ROOT + path.sep) || /(^|[\\/])\./.test(rel) || ['server', 'app', 'node_modules'].includes(top)) { res.writeHead(404); return res.end('Not found'); }
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
