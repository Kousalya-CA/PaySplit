import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { Loading, ErrorNote } from '../components/common.jsx';

const STATUS = {
  active: 'Active',
  invited: 'Waiting to set password',
  expired: 'Setup link expired',
};

// '2026-09-30 14:05:00' (UTC, from SQLite) -> local date and time
const when = (s) => (s
  ? new Date(`${s.replace(' ', 'T')}Z`).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })
  : 'Never');

// The owner is shown as its own role; only Admin and Employee can be given to people.
export const roleLabel = (u) => (u.isOwner ? 'Owner' : u.role === 'admin' ? 'Admin' : 'Employee');

const setupUrl =(token) => `${window.location.origin}${window.location.pathname}#/set-password/${token}`;

// Admins only: add people with a role, send setup links, change roles, remove access.
export default function UsersPage({ me }) {
  const [users, setUsers] = useState(null);
  const [form, setForm] = useState({ name: '', email: '', role: 'employee' });
  const [fieldErrors, setFieldErrors] = useState({});
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [link, setLink] = useState(null); // { name, url, days }

  const load = () => api.users.list().then(setUsers).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  const change = (e) => setForm({ ...form, [e.target.name]: e.target.value });

  const add = async (e) => {
    e.preventDefault();
    setError('');
    setFieldErrors({});
    setSaving(true);
    try {
      const { user, invite } = await api.users.create(form);
      setLink({ name: user.name, url: setupUrl(invite.token), days: invite.expiresInDays });
      setForm({ name: '', email: '', role: 'employee' });
      load();
    } catch (err) {
      setFieldErrors(err.fields || {});
      if (!Object.keys(err.fields || {}).length) setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const run = async (fn) => {
    setError('');
    try { await fn(); load(); } catch (err) { setError(err.message); }
  };

  const changeRole = (u, role) => run(() => api.users.update(u.id, { role }));

  const newLink = (u) => run(async () => {
    const { invite } = await api.users.newLink(u.id);
    setLink({ name: u.name, url: setupUrl(invite.token), days: invite.expiresInDays, reset: u.status === 'active' });
  });

  const signOut = (u) => {
    if (!window.confirm(`Sign ${u.name} out on all their devices?`)) return;
    run(() => api.users.signOut(u.id));
  };

  const remove = (u, isMe) => {
    const question = isMe
      ? "Delete your own account? You'll be logged out and won't be able to log in again."
      : `Delete ${u.name}? They won't be able to log in any more.`;
    if (!window.confirm(question)) return;
    run(async () => {
      await api.users.remove(u.id);
      if (isMe) window.dispatchEvent(new Event('paysplit:logout'));
    });
  };

  return (
    <section>
      <div className="page-head">
        <div>
          <h1>Users</h1>
          <p className="muted">People who can log in to PaySplit. Only admins see this page.</p>
        </div>
      </div>

      <form className="panel user-form" onSubmit={add} noValidate>
        <h2>Add a user</h2>
        <div className="row">
          <label className="grow">
            <span>Name</span>
            <input name="name" value={form.name} onChange={change} autoComplete="off"
              aria-invalid={Boolean(fieldErrors.name)} />
            {fieldErrors.name && <small className="field-error">{fieldErrors.name}</small>}
          </label>
          <label className="grow">
            <span>Email</span>
            <input name="email" type="email" value={form.email} onChange={change} autoComplete="off"
              aria-invalid={Boolean(fieldErrors.email)} />
            {fieldErrors.email && <small className="field-error">{fieldErrors.email}</small>}
          </label>
          <label>
            <span>Role</span>
            <select name="role" value={form.role} onChange={change}>
              <option value="employee">Employee</option>
              <option value="admin">Admin</option>
            </select>
          </label>
        </div>
        <div className="actions">
          <button className="primary" type="submit" disabled={saving}>{saving ? 'Adding…' : 'Add user'}</button>
          <span className="muted small">You'll get a link to send them so they can set their own password.</span>
        </div>
      </form>

      {link && <SetupLink link={link} onClose={() => setLink(null)} />}
      <ErrorNote>{error}</ErrorNote>

      {!users ? <Loading /> : (
        <div className="table-wrap">
          <table className="grid list">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Email</th>
                <th scope="col">Role</th>
                <th scope="col">Status</th>
                <th scope="col">Last login</th>
                <th scope="col"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => {
                const isMe = u.id === me.id;
                const locked = u.isOwner || isMe;
                return (
                  <tr key={u.id}>
                    <th scope="row">
                      {u.name}
                      {isMe && <span className="tag">You</span>}
                    </th>
                    <td>{u.email}</td>
                    <td>
                      {locked ? roleLabel(u) : (
                        <select aria-label={`Role for ${u.name}`} className="compact" value={u.role}
                          onChange={(e) => changeRole(u, e.target.value)}>
                          <option value="employee">Employee</option>
                          <option value="admin">Admin</option>
                        </select>
                      )}
                    </td>
                    <td className={u.status === 'active' ? '' : 'warn-text'}>{STATUS[u.status]}</td>
                    <td>
                      {when(u.lastLoginAt)}
                      {u.loggedIn && <span className="tag tag-live">Logged in</span>}
                    </td>
                    <td className="row-actions">
                      {!u.isOwner && (
                        <button className="link" onClick={() => newLink(u)}>
                          {u.status === 'active' ? 'Reset password' : 'New setup link'}
                        </button>
                      )}
                      {!isMe && u.loggedIn && <button className="link" onClick={() => signOut(u)}>Sign out</button>}
                      {!u.isOwner && <button className="link danger" onClick={() => remove(u, isMe)}>Delete</button>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="muted small">
        The owner has full access and can't be deleted or changed. Admins can add and manage users;
        employees can't see this page.
      </p>
    </section>
  );
}

function SetupLink({ link, onClose }) {
  const input = useRef(null);
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link.url);
    } catch {
      input.current.select();
      document.execCommand('copy');
    }
    setCopied(true);
  };

  return (
    <div className="panel setup-link" role="status">
      <h2>{link.reset ? `Password reset link for ${link.name}` : `${link.name} was added`}</h2>
      <p className="muted">
        Send this link to {link.name}. It works once and expires in {link.days} days.
        {link.reset && ' Their current password keeps working until they use it.'}
        {' '}You won't be able to see it again, but you can make a new one any time.
      </p>
      <div className="copy-row">
        <input ref={input} readOnly value={link.url} aria-label="Setup link" onFocus={(e) => e.target.select()} />
        <button className="primary small" type="button" onClick={copy}>{copied ? 'Copied' : 'Copy link'}</button>
        <button className="secondary small" type="button" onClick={onClose}>Done</button>
      </div>
    </div>
  );
}
