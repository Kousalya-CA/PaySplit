// My profile (everyone signed in): their account (name, email, role and tabs, last login, devices,
// password) and their employee details, matched by email. People edit their own name, phone and
// photo; admins set designation, date of joining, reporting manager and location.
import { db } from '../db.js';
import { HttpError, getCookie } from '../http.js';
import { verifyPassword, changePassword, destroyOtherSessions, countSessions, findUserById } from '../auth.js';
import { roleName, tabsFor, TABS } from '../access.js';

const q = {
  employeeByEmail: db.prepare(`
    SELECT e.id, e.employee_code, e.name, e.type, e.active, e.phone, e.photo, e.designation, e.joined_on,
      e.manager_id, m.name AS manager, e.location
    FROM employees e LEFT JOIN employees m ON m.id = e.manager_id
    WHERE e.email = ? COLLATE NOCASE`),
  employee: db.prepare('SELECT id, name FROM employees WHERE id = ?'),
  rename: db.prepare('UPDATE users SET name = ? WHERE id = ?'),
  setPhone: db.prepare('UPDATE employees SET phone = ? WHERE id = ?'),
  setPhoto: db.prepare('UPDATE employees SET photo = ? WHERE id = ?'),
  setDetails: db.prepare('UPDATE employees SET designation = ?, joined_on = ?, manager_id = ?, location = ? WHERE id = ?'),
};

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const PHONE_RE = /^[+0-9][0-9 ()-]{5,19}$/;
const PHOTO_RE = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;
const MAX_PHOTO = 300_000; // characters of the data URL (about 220 KB of image)

function profileOf(user, token) {
  const u = findUserById(user.id);
  const e = user.email ? q.employeeByEmail.get(user.email) : null;
  return {
    account: {
      name: u.name,
      email: u.email,
      role: roleName(u),
      isOwner: Boolean(u.is_owner),
      tabs: tabsFor(u).map((k) => TABS.find((t) => t.key === k)?.label || k),
      lastLoginAt: u.last_login_at,
      devices: countSessions(u.id),
      hasPassword: Boolean(u.password_hash),
    },
    employee: e ? {
      id: e.id, code: e.employee_code, type: e.type, active: Boolean(e.active), phone: e.phone, photo: e.photo,
      designation: e.designation, joinedOn: e.joined_on, manager: e.manager, location: e.location,
    } : null,
    signedInHere: Boolean(token),
  };
}
const text = (value, max, label) => {
  const v = String(value ?? '').trim();
  if (v.length > max) throw new HttpError(400, `Keep the ${label} to ${max} characters or fewer.`);
  return v || null;
};

export function registerProfileRoutes(router) {
  router.get('/api/me/profile', ({ user, req }) => profileOf(user, getCookie(req, 'sid')));

  // Name (the login), and phone and photo (the linked employee).
  router.patch('/api/me/profile', ({ user, body, req }) => {
    const e = user.email ? q.employeeByEmail.get(user.email) : null;
    if (body?.name !== undefined) {
      const name = String(body.name).trim();
      if (!name) throw new HttpError(400, 'Enter your name.');
      if (name.length > 80) throw new HttpError(400, 'Keep your name to 80 characters or fewer.');
      q.rename.run(name, user.id);
    }
    if (body?.phone !== undefined || body?.photo !== undefined) {
      if (!e) throw new HttpError(400, 'Your login isn\'t linked to an employee yet, so there are no employee details to change. Ask an admin.');
      if (body.phone !== undefined) {
        const phone = text(body.phone, 20, 'phone number');
        if (phone && !PHONE_RE.test(phone)) throw new HttpError(400, 'Enter the phone number with digits only, for example +91 98765 43210.');
        q.setPhone.run(phone, e.id);
      }
      if (body.photo !== undefined) {
        const photo = body.photo ? String(body.photo) : null;
        if (photo && (!PHOTO_RE.test(photo) || photo.length > MAX_PHOTO)) throw new HttpError(400, 'Choose a JPEG, PNG or WebP photo under 200 KB.');
        q.setPhoto.run(photo, e.id);
      }
    }
    return profileOf(user, getCookie(req, 'sid'));
  });

  router.post('/api/me/password', ({ user, body, req }) => {
    const u = findUserById(user.id);
    const current = String(body?.current ?? '');
    const password = String(body?.password ?? '');
    if (!verifyPassword(current, u.password_hash)) throw new HttpError(400, 'Check the highlighted fields.', { current: 'That isn\'t your current password.' });
    if (password.length < 8) throw new HttpError(400, 'Check the highlighted fields.', { password: 'Use at least 8 characters.' });
    if (password === current) throw new HttpError(400, 'Check the highlighted fields.', { password: 'Choose a password different from the current one.' });
    changePassword(u.id, password, getCookie(req, 'sid'));
    return profileOf(user, getCookie(req, 'sid'));
  });

  router.post('/api/me/sign-out-others', ({ user, req }) => {
    destroyOtherSessions(user.id, getCookie(req, 'sid'));
    return profileOf(user, getCookie(req, 'sid'));
  });

  // Admins: an employee's designation, date of joining, reporting manager and location.
  router.patch('/api/employees/:id/details', ({ params, body }) => {
    const e = q.employee.get(params.id);
    if (!e) throw new HttpError(404, 'Employee not found.');
    const joined = body?.joined_on ? String(body.joined_on) : null;
    if (joined && (!DAY_RE.test(joined) || Number.isNaN(Date.parse(`${joined}T00:00:00Z`)))) throw new HttpError(400, 'Choose the date of joining.');
    const managerId = body?.manager_id ? Number(body.manager_id) : null;
    if (managerId && (managerId === e.id || !q.employee.get(managerId))) throw new HttpError(400, 'Choose another employee as the reporting manager.');
    q.setDetails.run(text(body?.designation, 80, 'designation'), joined, managerId, text(body?.location, 80, 'location'), e.id);
    return { ok: true };
  }, { admin: true });
}
