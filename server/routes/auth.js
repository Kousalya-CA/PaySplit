// Log in, log out, current user, first-time setup and setup links.
// There is no public sign-up: admins add users from the Users page.
import {
  findUserByEmail, createUser, verifyPassword, createSession, destroySession, hasUsers,
  findUserByInvite, setPasswordFromInvite,
} from '../auth.js';
import { HttpError, getCookie } from '../http.js';

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const isProd = process.env.NODE_ENV === 'production';

export const sessionCookie = (token, maxAge) =>
  `sid=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAge}${isProd ? '; Secure' : ''}`;

// Simple in-memory limiter: 10 failed logins per email+IP per 15 minutes.
const failures = new Map();
const WINDOW = 15 * 60 * 1000;

export const publicUser = ({ id, name, email, role, is_owner }) =>
  ({ id, name, email, role, isOwner: Boolean(is_owner) });

const checkPassword = (password) => {
  if (password.length < 8) throw new HttpError(400, 'Check the highlighted fields.', { password: 'Use at least 8 characters.' });
};

export function registerAuthRoutes(router) {
  // Whether the app has no accounts yet, so the first-time setup form should be shown.
  router.get('/api/auth/status', () => ({ needsSetup: !hasUsers() }), { auth: false });

  // First-time setup only: creates the owner account when the database has no users.
  router.post('/api/auth/setup', ({ body, setHeader }) => {
    if (hasUsers()) throw new HttpError(403, 'PaySplit is already set up. Ask your admin to add you.');
    const name = String(body.name ?? '').trim();
    const email = String(body.email ?? '').trim().toLowerCase();
    const password = String(body.password ?? '');
    const errors = {};
    if (!name) errors.name = 'Enter your name.';
    if (!EMAIL_RE.test(email)) errors.email = 'Enter a valid email address.';
    if (password.length < 8) errors.password = 'Use at least 8 characters.';
    if (Object.keys(errors).length) throw new HttpError(400, 'Check the highlighted fields.', errors);

    const id = createUser({ name, email, password, role: 'admin', isOwner: true });
    const { token, maxAge } = createSession(id);
    setHeader('Set-Cookie', sessionCookie(token, maxAge));
    return { user: publicUser({ id, name, email, role: 'admin', is_owner: 1 }) };
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
      if (user && !user.password_hash) {
        throw new HttpError(401, "Your account isn't set up yet. Open the setup link your admin sent you to choose a password.");
      }
      throw new HttpError(401, 'Email or password is incorrect.');
    }
    failures.delete(key);
    const { token, maxAge } = createSession(user.id);
    setHeader('Set-Cookie', sessionCookie(token, maxAge));
    return { user: publicUser(user) };
  }, { auth: false });

  // Setup link: look up who it's for, then let them choose a password.
  router.post('/api/auth/invite', ({ body }) => {
    const user = findUserByInvite(body.token);
    if (!user) throw new HttpError(404, 'This setup link has expired or was already used. Ask your admin for a new one.');
    return { name: user.name, email: user.email };
  }, { auth: false });

  router.post('/api/auth/set-password', ({ body, setHeader }) => {
    const user = findUserByInvite(body.token);
    if (!user) throw new HttpError(404, 'This setup link has expired or was already used. Ask your admin for a new one.');
    const password = String(body.password ?? '');
    checkPassword(password);
    setPasswordFromInvite(user.id, password);
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
