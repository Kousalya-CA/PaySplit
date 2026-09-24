// Sign up, log in, log out, current user.
import {
  findUserByEmail, createUser, verifyPassword, createSession, destroySession,
} from '../auth.js';
import { HttpError, getCookie } from '../http.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const isProd = process.env.NODE_ENV === 'production';

export const sessionCookie = (token, maxAge) =>
  `sid=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAge}${isProd ? '; Secure' : ''}`;

// Simple in-memory limiter: 10 failed logins per email+IP per 15 minutes.
const failures = new Map();
const WINDOW = 15 * 60 * 1000;

const publicUser = ({ id, name, email }) => ({ id, name, email });

export function registerAuthRoutes(router) {
  router.post('/api/auth/signup', ({ body, setHeader }) => {
    const name = String(body.name ?? '').trim();
    const email = String(body.email ?? '').trim().toLowerCase();
    const password = String(body.password ?? '');
    const errors = {};
    if (!name) errors.name = 'Enter your name.';
    if (!EMAIL_RE.test(email)) errors.email = 'Enter a valid email address.';
    if (password.length < 8) errors.password = 'Use at least 8 characters.';
    if (!errors.email && findUserByEmail(email)) errors.email = 'An account with this email already exists.';
    if (Object.keys(errors).length) throw new HttpError(400, 'Check the highlighted fields.', errors);

    const id = createUser({ name, email, password });
    const { token, maxAge } = createSession(id);
    setHeader('Set-Cookie', sessionCookie(token, maxAge));
    return { user: { id, name, email } };
  }, { auth: false });

  router.post('/api/auth/login', ({ req, body, setHeader }) => {
    const email = String(body.email ?? '').trim().toLowerCase();
    const password = String(body.password ?? '');
    const key = `${req.socket.remoteAddress}|${email}`;
    const f = failures.get(key);
    if (f && Date.now() - f.first > WINDOW) failures.delete(key);
    if (failures.get(key)?.count >= 10) throw new HttpError(429, 'Too many attempts. Try again in 15 minutes.');

    const user = findUserByEmail(email);
    if (!user || !verifyPassword(password, user.password_hash)) {
      const entry = failures.get(key) || { count: 0, first: Date.now() };
      entry.count++;
      failures.set(key, entry);
      throw new HttpError(401, 'Email or password is incorrect.');
    }
    failures.delete(key);
    const { token, maxAge } = createSession(user.id);
    setHeader('Set-Cookie', sessionCookie(token, maxAge));
    return { user: publicUser(user) };
  }, { auth: false });

  router.post('/api/auth/logout', ({ req, setHeader }) => {
    destroySession(getCookie(req, 'sid'));
    setHeader('Set-Cookie', sessionCookie('', 0));
  }, { auth: false });

  router.get('/api/auth/me', ({ user }) => ({ user: publicUser(user) }));
}
