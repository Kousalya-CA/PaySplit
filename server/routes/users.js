// Users page (admins only): add people, set their role, send setup links, remove access.
import { db } from '../db.js';
import { HttpError } from '../http.js';
import { createUser, createInvite, findUserByEmail, destroyUserSessions } from '../auth.js';
import { EMAIL_RE } from './auth.js';

const ROLES = ['admin', 'employee'];

const q = {
  list: db.prepare(`
    SELECT u.id, u.name, u.email, u.role, u.is_owner, u.created_at, u.last_login_at,
      u.password_hash <> '' AS has_password,
      (u.invite_token_hash IS NOT NULL AND u.invite_expires_at > datetime('now')) AS invite_open,
      (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id AND s.expires_at > datetime('now')) AS active_sessions
    FROM users u ORDER BY u.is_owner DESC, u.name COLLATE NOCASE`),
  byId: db.prepare('SELECT id, name, email, role, is_owner FROM users WHERE id = ?'),
  update: db.prepare('UPDATE users SET name = ?, role = ? WHERE id = ?'),
  remove: db.prepare('DELETE FROM users WHERE id = ?'),
};

const toRow = (u) => ({
  id: u.id,
  name: u.name,
  email: u.email,
  role: u.role,
  isOwner: Boolean(u.is_owner),
  createdAt: u.created_at,
  lastLoginAt: u.last_login_at,
  // active: has a password; invited: waiting for them to use a setup link; expired: link ran out
  status: u.has_password ? 'active' : u.invite_open ? 'invited' : 'expired',
  loggedIn: u.active_sessions > 0,
});

function requireUser(id) {
  const u = q.byId.get(id);
  if (!u) throw new HttpError(404, 'User not found.');
  return u;
}

export function registerUserRoutes(router) {
  router.get('/api/users', () => q.list.all().map(toRow), { admin: true });

  router.post('/api/users', ({ body, setStatus }) => {
    const name = String(body.name ?? '').trim();
    const email = String(body.email ?? '').trim().toLowerCase();
    const role = body.role;
    const errors = {};
    if (!name) errors.name = 'Enter their name.';
    if (!EMAIL_RE.test(email)) errors.email = 'Enter a valid email address.';
    else if (findUserByEmail(email)) errors.email = 'Someone with this email already has access.';
    if (!ROLES.includes(role)) errors.role = 'Choose Admin or Employee.';
    if (Object.keys(errors).length) throw new HttpError(400, 'Check the highlighted fields.', errors);

    const id = createUser({ name, email, role });
    setStatus(201);
    return { user: { id, name, email, role }, invite: createInvite(id) };
  }, { admin: true });

  router.patch('/api/users/:id', ({ params, body, user: me }) => {
    const target = requireUser(params.id);
    const name = body.name === undefined ? target.name : String(body.name).trim();
    if (!name) throw new HttpError(400, 'Enter their name.');
    const role = body.role === undefined ? target.role : body.role;
    if (!ROLES.includes(role)) throw new HttpError(400, 'Choose Admin or Employee.');
    if (role !== target.role) {
      if (target.is_owner) throw new HttpError(403, `${target.name} is the owner and always stays an admin.`);
      if (target.id === me.id) throw new HttpError(403, "You can't change your own role. Ask another admin.");
    }
    q.update.run(name, role, target.id);
    return { id: target.id, name, role };
  }, { admin: true });

  router.delete('/api/users/:id', ({ params, user: me }) => {
    const target = requireUser(params.id);
    if (target.is_owner) throw new HttpError(403, `${target.name} is the owner and can't be removed.`);
    if (target.id === me.id) throw new HttpError(403, "You can't remove yourself.");
    q.remove.run(target.id); // their sessions are removed with them
  }, { admin: true });

  // New setup link: for someone who hasn't set a password yet, or who forgot it.
  // Their current password keeps working until they use the link.
  router.post('/api/users/:id/invite', ({ params }) => {
    const target = requireUser(params.id);
    if (target.is_owner) throw new HttpError(403, "The owner's password can't be reset from here.");
    return { invite: createInvite(target.id) };
  }, { admin: true });

  // Sign someone out everywhere, e.g. after changing their role or if a device was lost.
  router.post('/api/users/:id/logout', ({ params, user: me }) => {
    const target = requireUser(params.id);
    if (target.id === me.id) throw new HttpError(400, 'Use Log out to sign yourself out.');
    destroyUserSessions(target.id);
  }, { admin: true });
}
