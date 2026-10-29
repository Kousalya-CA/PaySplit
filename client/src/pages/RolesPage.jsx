import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Loading, ErrorNote } from '../components/common.jsx';

// Roles & access (admins and the owner): which tabs each role can open. Admin always has every tab;
// admin tabs (pay and company data) can't be given to other roles. Changes apply when people next
// load the app; their data is also refused on the server for tabs their role doesn't have.
export default function RolesPage() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [newName, setNewName] = useState('');
  const [renaming, setRenaming] = useState(null); // { id, name }

  useEffect(() => { api.roles.list().then(setData).catch((e) => setError(e.message)); }, []);
  if (!data) return error ? <ErrorNote>{error}</ErrorNote> : <Loading />;

  const run = async (fn, done) => {
    setBusy(true);
    setError('');
    setNotice('');
    try { setData(await fn()); setNotice(done); return true; } catch (err) { setError(err.message); return false; } finally { setBusy(false); }
  };
  const toggle = (role, key) => {
    const tabs = role.tabs.includes(key) ? role.tabs.filter((k) => k !== key) : [...role.tabs, key];
    const label = data.tabs.find((t) => t.key === key).label;
    run(() => api.roles.update(role.id, { tabs }), `${role.name} ${tabs.includes(key) ? 'can now open' : 'no longer sees'} ${label}.`);
  };
  const add = async (e) => {
    e.preventDefault();
    const base = data.roles.find((r) => r.builtin);
    if (await run(() => api.roles.create({ name: newName, tabs: base ? base.tabs : [] }), `Added the ${newName.trim()} role, starting with the Employee tabs.`)) setNewName('');
  };
  const rename = async (e) => {
    e.preventDefault();
    if (await run(() => api.roles.update(renaming.id, { name: renaming.name }), `Renamed to ${renaming.name.trim()}.`)) setRenaming(null);
  };
  const remove = (role) => {
    const who = role.users ? ` Its ${role.users} ${role.users === 1 ? 'person moves' : 'people move'} to the Employee role.` : '';
    if (!window.confirm(`Delete the ${role.name} role?${who}`)) return;
    run(() => api.roles.remove(role.id), `Deleted the ${role.name} role.${who}`);
  };

  return (
    <section>
      <div className="page-head">
        <div>
          <h1>Roles &amp; access</h1>
          <p className="muted">Choose which tabs each role can open. Admins and the owner always see every tab. Give people a role on the <a href="#/users">Users</a> page.</p>
        </div>
      </div>
      <ErrorNote>{error}</ErrorNote>
      {notice && <p className="ok-text small" role="status">{notice}</p>}

      <div className="table-wrap">
        <table className="grid roles-table">
          <thead>
            <tr>
              <th scope="col">Tab</th>
              <th scope="col" className="role-col">
                <strong>Admin</strong>
                <small className="muted">{data.admins} {data.admins === 1 ? 'person' : 'people'} · all tabs</small>
              </th>
              {data.roles.map((r) => (
                <th key={r.id} scope="col" className="role-col">
                  {renaming?.id === r.id ? (
                    <form onSubmit={rename} className="role-rename">
                      <input value={renaming.name} maxLength={40} autoFocus aria-label="Role name" onChange={(e) => setRenaming({ ...renaming, name: e.target.value })} />
                      <button className="link" type="submit" disabled={busy}>Save</button>
                      <button className="link" type="button" onClick={() => setRenaming(null)}>Cancel</button>
                    </form>
                  ) : <strong>{r.name}</strong>}
                  <small className="muted">{r.users} {r.users === 1 ? 'person' : 'people'}{r.builtin ? ' · built in' : ''}</small>
                  {!r.builtin && renaming?.id !== r.id && (
                    <span className="role-actions">
                      <button className="link small" onClick={() => setRenaming({ id: r.id, name: r.name })}>Rename</button>
                      <button className="link small danger" disabled={busy} onClick={() => remove(r)}>Delete</button>
                    </span>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.tabs.map((t) => (
              <tr key={t.key} className={t.admin ? 'admin-tab' : undefined}>
                <th scope="row">
                  {t.label}
                  {t.admin && <small className="muted"> · admins only</small>}
                </th>
                <td className="role-cell"><input type="checkbox" checked disabled aria-label={`Admin: ${t.label}`} /></td>
                {data.roles.map((r) => (
                  <td key={r.id} className="role-cell">
                    {t.admin ? <span className="muted" title="Pay and company data: admins only">🔒</span> : (
                      <input type="checkbox" checked={r.tabs.includes(t.key)} disabled={busy}
                        aria-label={`${r.name}: ${t.label}`} onChange={() => toggle(r, t.key)} />
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <form className="row roles-add" onSubmit={add}>
        <label className="grow">
          <span>New role</span>
          <input value={newName} maxLength={40} required placeholder="For example Team Lead" onChange={(e) => setNewName(e.target.value)} />
        </label>
        <button className="secondary" type="submit" disabled={busy}>Add role</button>
      </form>
      <p className="muted small">
        A new role starts with the Employee tabs; tick or untick tabs above. People in these roles see only their own pay on
        Summary, Employees and All payments. Changes take effect the next time they open or reload the app.
      </p>
    </section>
  );
}
