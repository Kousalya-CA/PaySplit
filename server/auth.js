// Password hashing and session handling using node:crypto.
import { scryptSync, randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { db } from './db.js';

const SESSION_DAYS = 7;
const sha256 = (s) => createHash('sha256').update(s).digest('hex');

export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const candidate = scryptSync(password, salt, 64);
  return timingSafeEqual(candidate, Buffer.from(hash, 'hex'));
}

const q = {
  userByEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
  insertUser: db.prepare('INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)'),
  insertSession: db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, datetime('now', ?))"),
  sessionUser: db.prepare(`
    SELECT u.id, u.name, u.email FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > datetime('now')`),
  deleteSession: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
  purgeExpired: db.prepare("DELETE FROM sessions WHERE expires_at <= datetime('now')"),
};

export const findUserByEmail = (email) => q.userByEmail.get(email);

export function createUser({ name, email, password }) {
  const { lastInsertRowid } = q.insertUser.run(name, email, hashPassword(password));
  return Number(lastInsertRowid);
}

export function createSession(userId) {
  q.purgeExpired.run();
  const token = randomBytes(32).toString('hex');
  q.insertSession.run(sha256(token), userId, `+${SESSION_DAYS} days`);
  return { token, maxAge: SESSION_DAYS * 24 * 60 * 60 };
}

export const userFromToken = (token) => (token ? q.sessionUser.get(sha256(token)) : undefined);
export const destroySession = (token) => { if (token) q.deleteSession.run(sha256(token)); };
