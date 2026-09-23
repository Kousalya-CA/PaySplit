// PaySplit API server: Node built-ins only.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, dirname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  findUserByEmail, createUser, verifyPassword,
  createSession, userFromToken, destroySession,
} from './auth.js';

const PORT = process.env.PORT || 3000;
const isProd = process.env.NODE_ENV === 'production';
const distDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'client', 'dist');
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// --- helpers ---------------------------------------------------------------
const json = (res, status, data, headers = {}) => {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(data === undefined ? '' : JSON.stringify(data));
};

const readBody = (req) => new Promise((resolve, reject) => {
  let body = '';
  req.on('data', (c) => { body += c; if (body.length > 1e5) req.destroy(); });
  req.on('end', () => { try { resolve(body ? JSON.parse(body) : {}); } catch { reject(new Error('Invalid JSON')); } });
});

const getCookie = (req, name) =>
  (req.headers.cookie || '').split(';').map((c) => c.trim().split('='))
    .find(([k]) => k === name)?.[1];

const sessionCookie = (token, maxAge) =>
  `sid=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAge}${isProd ? '; Secure' : ''}`;

// Simple in-memory limiter: 10 failed logins per email+IP per 15 minutes.
const failures = new Map();
const limitKey = (req, email) => `${req.socket.remoteAddress}|${email}`;
const isLimited = (key) => {
  const f = failures.get(key);
  if (f && Date.now() - f.first > 15 * 60 * 1000) { failures.delete(key); return false; }
  return f?.count >= 10;
};
const recordFailure = (key) => {
  const f = failures.get(key) || { count: 0, first: Date.now() };
  f.count++; failures.set(key, f);
};

const publicUser = ({ id, name, email }) => ({ id, name, email });

// --- routes ----------------------------------------------------------------
const routes = {
  'POST /api/auth/signup': async (req, res) => {
    const { name = '', email = '', password = '' } = await readBody(req);
    const cleanEmail = String(email).trim().toLowerCase();
    const cleanName = String(name).trim();
    const errors = {};
    if (!cleanName) errors.name = 'Enter your name.';
    if (!EMAIL_RE.test(cleanEmail)) errors.email = 'Enter a valid email address.';
    if (String(password).length < 8) errors.password = 'Use at least 8 characters.';
    if (!errors.email && findUserByEmail(cleanEmail)) errors.email = 'An account with this email already exists.';
    if (Object.keys(errors).length) return json(res, 400, { errors });

    const id = createUser({ name: cleanName, email: cleanEmail, password: String(password) });
    const { token, maxAge } = createSession(id);
    json(res, 201, { user: { id, name: cleanName, email: cleanEmail } }, { 'Set-Cookie': sessionCookie(token, maxAge) });
  },

  'POST /api/auth/login': async (req, res) => {
    const { email = '', password = '' } = await readBody(req);
    const cleanEmail = String(email).trim().toLowerCase();
    const key = limitKey(req, cleanEmail);
    if (isLimited(key)) return json(res, 429, { error: 'Too many attempts. Try again in 15 minutes.' });

    const user = findUserByEmail(cleanEmail);
    if (!user || !verifyPassword(String(password), user.password_hash)) {
      recordFailure(key);
      return json(res, 401, { error: 'Email or password is incorrect.' });
    }
    failures.delete(key);
    const { token, maxAge } = createSession(user.id);
    json(res, 200, { user: publicUser(user) }, { 'Set-Cookie': sessionCookie(token, maxAge) });
  },

  'POST /api/auth/logout': async (req, res) => {
    destroySession(getCookie(req, 'sid'));
    json(res, 204, undefined, { 'Set-Cookie': sessionCookie('', 0) });
  },

  'GET /api/auth/me': async (req, res) => {
    const user = userFromToken(getCookie(req, 'sid'));
    user ? json(res, 200, { user: publicUser(user) }) : json(res, 401, { error: 'Not signed in.' });
  },
};

// --- static files (production build of the React app) -----------------------
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

async function serveStatic(res, pathname) {
  let file = normalize(join(distDir, pathname));
  if (!file.startsWith(distDir)) return json(res, 403, { error: 'Forbidden' });
  try {
    if (!extname(file)) file = join(distDir, 'index.html'); // SPA fallback
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found. Run "npm run build" to build the React app, or use the Vite dev server.');
  }
}

createServer(async (req, res) => {
  const { pathname } = new URL(req.url, `http://${req.headers.host}`);
  try {
    const route = routes[`${req.method} ${pathname}`];
    if (route) return await route(req, res);
    if (pathname.startsWith('/api/')) return json(res, 404, { error: 'Not found' });
    await serveStatic(res, pathname);
  } catch (err) {
    json(res, 400, { error: err.message });
  }
}).listen(PORT, () => console.log(`PaySplit server running at http://localhost:${PORT}`));
