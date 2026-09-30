// Password hashing, sessions and setup links using node:crypto.
import { scryptSync, randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { db } from './db.js';

const SESSION_DAYS = 7;
const INVITE_DAYS = 7;
const sha256 = (s) => createHash('sha256').update(s).digest('hex');

export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password, stored) {
  if (!stored) return false; // invited user who hasn't set a password yet
  const [salt, hash] = stored.split(':');
  const candidate = scryptSync(password, salt, 64);
  return timingSafeEqual(candidate, Buffer.from(hash, 'hex'));
}

const q = {
  userByEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
  userCount: db.prepare('SELECT COUNT(*) AS n FROM users'),
  insertUser: db.prepare('INSERT INTO users (name, email, password_hash, role, is_owner) VALUES (?, ?, ?, ?, ?)'),
  insertSession: db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, datetime('now', ?))"),
  sessionUser: db.prepare(`
    SELECT u.id, u.name, u.email, u.role, u.is_owner FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > datetime('now')`),
  deleteSession: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
  deleteUserSessions: db.prepare('DELETE FROM sessions WHERE user_id = ?'),
  purgeExpired: db.prepare("DELETE FROM sessions WHERE expires_at <= datetime('now')"),
  touchLogin: db.prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?"),
  setInvite: db.prepare("UPDATE users SET invite_token_hash = ?, invite_expires_at = datetime('now', ?) WHERE id = ?"),
  userByInvite: db.prepare(`
    SELECT * FROM users WHERE invite_token_hash = ? AND invite_expires_at > datetime('now')`),
  setPassword: db.prepare(`
    UPDATE users SET password_hash = ?, invite_token_hash = NULL, invite_expires_at = NULL WHERE id = ?`),
};

export const findUserByEmail = (email) => q.userByEmail.get(email);
export const hasUsers = () => q.userCount.get().n > 0;

export function createUser({ name, email, password = null, role = 'employee', isOwner = false }) {
  const { lastInsertRowid } = q.insertUser.run(name, email, password ? hashPassword(password) : '', role, isOwner ? 1 : 0);
  return Number(lastInsertRowid);
}

export function createSession(userId) {
  q.purgeExpired.run();
  q.touchLogin.run(userId);
  const token = randomBytes(32).toString('hex');
  q.insertSession.run(sha256(token), userId, `+${SESSION_DAYS} days`);
  return { token, maxAge: SESSION_DAYS * 24 * 60 * 60 };
}

export const userFromToken = (token) => (token ? q.sessionUser.get(sha256(token)) : undefined);
export const destroySession = (token) => { if (token) q.deleteSession.run(sha256(token)); };
export const destroyUserSessions = (userId) => q.deleteUserSessions.run(userId);

// One-time link an admin sends so a user can choose their password. Only the hash is stored.
export function createInvite(userId) {
  const token = randomBytes(24).toString('hex');
  q.setInvite.run(sha256(token), `+${INVITE_DAYS} days`, userId);
  return { token, expiresInDays: INVITE_DAYS };
}

export const findUserByInvite = (token) => (token ? q.userByInvite.get(sha256(String(token))) : undefined);

// Sets the password, uses up the link and signs out any other sessions.
export function setPasswordFromInvite(userId, password) {
  q.setPassword.run(hashPassword(password), userId);
  q.deleteUserSessions.run(userId);
}
