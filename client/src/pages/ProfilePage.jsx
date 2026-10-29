import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { Loading, ErrorNote } from '../components/common.jsx';
import { dayLabel } from '../format.js';

// My profile (everyone): the account (name, email, role and tabs, last login, signed-in devices,
// password) and the employee details matched by email. People change their own name, phone and photo;
// designation, date of joining, manager and location are set by admins.
const when = (iso) => (iso ? new Date(`${iso.replace(' ', 'T')}Z`).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'Never');

// Shrink a chosen photo to a 256 px square JPEG so it stays small.
function squarePhoto(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const size = 256;
      const side = Math.min(img.width, img.height);
      const canvas = Object.assign(document.createElement('canvas'), { width: size, height: size });
      canvas.getContext('2d').drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, size, size);
      URL.revokeObjectURL(img.src);
      resolve(canvas.toDataURL('image/jpeg', 0.85));
    };
    img.onerror = () => reject(new Error('That file isn\'t a photo this browser can open. Choose a JPEG or PNG.'));
    img.src = URL.createObjectURL(file);
  });
}

export default function ProfilePage({ onUserChange }) {
  const [p, setP] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState('');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [pw, setPw] = useState({ current: '', password: '', confirm: '' });
  const [pwErrors, setPwErrors] = useState({});
  const fileRef = useRef(null);

  const show = (d) => { setP(d); setName(d.account.name); setPhone(d.employee?.phone || ''); };
  useEffect(() => { api.profile.get().then(show).catch((e) => setError(e.message)); }, []);
  if (!p) return error ? <ErrorNote>{error}</ErrorNote> : <Loading />;

  const run = async (key, fn, done) => {
    setBusy(key);
    setError('');
    setNotice('');
    try { const d = await fn(); show(d); setNotice(done); return d; } catch (err) { setError(err.message); return null; } finally { setBusy(''); }
  };
  const saveName = async (e) => {
    e.preventDefault();
    const d = await run('name', () => api.profile.update({ name }), 'Name saved.');
    if (d) onUserChange?.({ name: d.account.name });
  };
  const savePhone = (e) => { e.preventDefault(); run('phone', () => api.profile.update({ phone }), phone.trim() ? 'Phone number saved.' : 'Phone number removed.'); };
  const choosePhoto = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const photo = await squarePhoto(file);
      const d = await run('photo', () => api.profile.update({ photo }), 'Photo saved.');
      if (d) onUserChange?.({ photo: d.employee?.photo || null });
    } catch (err) { setError(err.message); }
  };
  const removePhoto = async () => {
    const d = await run('photo', () => api.profile.update({ photo: null }), 'Photo removed.');
    if (d) onUserChange?.({ photo: null });
  };
  const changePassword = async (e) => {
    e.preventDefault();
    setPwErrors({});
    if (pw.password !== pw.confirm) { setPwErrors({ confirm: 'The two new passwords don\'t match.' }); return; }
    setBusy('pw');
    setError('');
    setNotice('');
    try {
      show(await api.profile.password(pw.current, pw.password));
      setPw({ current: '', password: '', confirm: '' });
      setNotice('Password changed. Your other devices were signed out.');
    } catch (err) {
      setPwErrors(err.fields || {});
      if (!Object.keys(err.fields || {}).length) setError(err.message);
    } finally { setBusy(''); }
  };
  const signOutOthers = () => run('devices', () => api.profile.signOutOthers(), 'Signed out of your other devices.');

  const a = p.account;
  const emp = p.employee;
  const initial = (a.name || '?')[0].toUpperCase();
  return (
    <section className="profile">
      <div className="profile-head">
        <div className="profile-photo">
          {emp?.photo ? <img src={emp.photo} alt="" /> : <span aria-hidden="true">{initial}</span>}
        </div>
        <div>
          <h1>{a.name}</h1>
          <p className="muted">{[emp?.designation, a.role, emp?.location].filter(Boolean).join(' · ')}</p>
        </div>
      </div>
      <ErrorNote>{error}</ErrorNote>
      {notice && <p className="ok-text small" role="status">{notice}</p>}

      <div className="profile-grid">
        <section className="profile-card">
          <h2>Account</h2>
          <form className="row" onSubmit={saveName}>
            <label className="grow">
              <span>Name</span>
              <input value={name} maxLength={80} required onChange={(e) => setName(e.target.value)} />
            </label>
            <button className="secondary" type="submit" disabled={busy !== '' || name.trim() === a.name}>Save</button>
          </form>
          <dl className="profile-dl">
            <dt>Email</dt><dd>{a.email} <small className="muted">(used to sign in and to match your Azure DevOps work)</small></dd>
            <dt>Role</dt><dd>{a.isOwner ? 'Owner (Admin)' : a.role}</dd>
            <dt>Tabs you can open</dt><dd>{a.tabs.join(', ') || 'None yet'}</dd>
            <dt>Last login</dt><dd>{when(a.lastLoginAt)}</dd>
            <dt>Signed in on</dt>
            <dd>
              {a.devices} {a.devices === 1 ? 'device' : 'devices'}
              {a.devices > 1 && <button className="link profile-inline" disabled={busy !== ''} onClick={signOutOthers}>Sign out of the others</button>}
            </dd>
          </dl>

          <h3>Change password</h3>
          <form className="profile-pw" onSubmit={changePassword}>
            {[['current', 'Current password', 'current-password'], ['password', 'New password', 'new-password'], ['confirm', 'New password again', 'new-password']].map(([k, label, ac]) => (
              <label key={k}>
                <span>{label}</span>
                <input type="password" value={pw[k]} autoComplete={ac} required minLength={k === 'current' ? undefined : 8}
                  aria-invalid={Boolean(pwErrors[k])} onChange={(e) => setPw({ ...pw, [k]: e.target.value })} />
                {pwErrors[k] && <small className="field-error">{pwErrors[k]}</small>}
              </label>
            ))}
            <p className="muted small">At least 8 characters. Changing it signs you out on your other devices.</p>
            <div><button className="primary" type="submit" disabled={busy !== ''}>{busy === 'pw' ? 'Saving…' : 'Change password'}</button></div>
          </form>
        </section>

        <section className="profile-card">
          <h2>Employee details</h2>
          {!emp ? (
            <p className="muted">Your login isn't linked to an employee yet (they're matched by email). Ask an admin to add your email on the Employees page.</p>
          ) : (
            <>
              <div className="profile-photo-row">
                <div className="profile-photo small">{emp.photo ? <img src={emp.photo} alt="Your photo" /> : <span aria-hidden="true">{initial}</span>}</div>
                <div className="row">
                  <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={choosePhoto} />
                  <button className="secondary" type="button" disabled={busy !== ''} onClick={() => fileRef.current?.click()}>{busy === 'photo' ? 'Saving…' : emp.photo ? 'Change photo' : 'Add photo'}</button>
                  {emp.photo && <button className="link danger" type="button" disabled={busy !== ''} onClick={removePhoto}>Remove</button>}
                </div>
              </div>
              <form className="row" onSubmit={savePhone}>
                <label className="grow">
                  <span>Phone</span>
                  <input type="tel" value={phone} maxLength={20} placeholder="+91 98765 43210" onChange={(e) => setPhone(e.target.value)} />
                </label>
                <button className="secondary" type="submit" disabled={busy !== '' || phone.trim() === (emp.phone || '')}>Save</button>
              </form>
              <dl className="profile-dl">
                <dt>Employee ID</dt><dd>{emp.code || <span className="muted">Not set</span>}</dd>
                <dt>Type</dt><dd>{emp.type}</dd>
                <dt>Status</dt><dd>{emp.active ? 'Active' : 'Inactive'}</dd>
                <dt>Designation</dt><dd>{emp.designation || <span className="muted">Not set</span>}</dd>
                <dt>Date of joining</dt><dd>{emp.joinedOn ? dayLabel(emp.joinedOn) : <span className="muted">Not set</span>}</dd>
                <dt>Reporting manager</dt><dd>{emp.manager || <span className="muted">Not set</span>}</dd>
                <dt>Location</dt><dd>{emp.location || <span className="muted">Not set</span>}</dd>
              </dl>
              <p className="muted small">Designation, date of joining, manager and location are set by an admin. Ask them if something is wrong.</p>
            </>
          )}
        </section>
      </div>
    </section>
  );
}
