// Roles & access page (admins only): the built-in Employee role and custom roles, and which tabs
// each can open. Admin tabs can't be given to them (see access.js).
import { db } from '../db.js';
import { HttpError } from '../http.js';
import { TABS, OPEN_TABS, parseTabs } from '../access.js';

const q = {
  roles: db.prepare(`SELECT r.*, (SELECT COUNT(*) FROM users u WHERE u.role = 'employee'
      AND (u.role_id = r.id OR (r.builtin = 1 AND u.role_id IS NULL))) AS users
    FROM roles r ORDER BY r.builtin DESC, r.name COLLATE NOCASE`),
  role: db.prepare('SELECT * FROM roles WHERE id = ?'),
  insert: db.prepare('INSERT INTO roles (name, tabs) VALUES (?, ?)'),
  update: db.prepare('UPDATE roles SET name = ?, tabs = ? WHERE id = ?'),
  remove: db.prepare('DELETE FROM roles WHERE id = ?'),
  moveUsers: db.prepare('UPDATE users SET role_id = NULL WHERE role_id = ?'),
  admins: db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'"),
};

const view = () => ({
  tabs: TABS,
  admins: q.admins.get().n,
  roles: q.roles.all().map((r) => ({ id: r.id, name: r.name, builtin: Boolean(r.builtin), tabs: parseTabs(r.tabs), users: r.users })),
});

function parseName(value) {
  const name = String(value ?? '').trim();
  if (!name) throw new HttpError(400, 'Enter the role name.');
  if (name.length > 40) throw new HttpError(400, 'Keep the role name to 40 characters or fewer.');
  if (/^(admin|owner)$/i.test(name)) throw new HttpError(400, `"${name}" is already a built-in role. Choose another name.`);
  return name;
}
function parseTabList(value) {
  if (!Array.isArray(value)) throw new HttpError(400, 'Choose the tabs for this role.');
  const bad = value.find((k) => !OPEN_TABS.includes(k));
  if (bad) throw new HttpError(400, `${TABS.find((t) => t.key === bad)?.label || bad} is for admins only.`);
  return JSON.stringify([...new Set(value)]);
}
const unique = (fn, name) => {
  try { return fn(); } catch (err) {
    if (/UNIQUE/i.test(String(err.message))) throw new HttpError(409, `There's already a role called ${name}.`);
    throw err;
  }
};

export function registerRoleRoutes(router) {
  const admin = { admin: true };
  router.get('/api/roles', () => view(), admin);

  router.post('/api/roles', ({ body, setStatus }) => {
    const name = parseName(body?.name);
    const tabs = parseTabList(body?.tabs ?? []);
    unique(() => q.insert.run(name, tabs), name);
    setStatus(201);
    return view();
  }, admin);

  router.put('/api/roles/:id', ({ params, body }) => {
    const role = q.role.get(params.id);
    if (!role) throw new HttpError(404, 'That role wasn\'t found. Reload the page.');
    const name = body?.name === undefined || role.builtin ? role.name : parseName(body.name);
    const tabs = body?.tabs === undefined ? role.tabs : parseTabList(body.tabs);
    unique(() => q.update.run(name, tabs, role.id), name);
    return view();
  }, admin);

  // Deleting a custom role moves its people to the Employee role.
  router.delete('/api/roles/:id', ({ params }) => {
    const role = q.role.get(params.id);
    if (!role) throw new HttpError(404, 'That role wasn\'t found. Reload the page.');
    if (role.builtin) throw new HttpError(400, 'The Employee role can\'t be deleted.');
    q.moveUsers.run(role.id);
    q.remove.run(role.id);
    return view();
  }, admin);
}
