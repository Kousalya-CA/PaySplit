import { useEffect, useState } from 'react';
import { api } from '../api.js';
import AuthLayout from './AuthLayout.jsx';
import Field from './Field.jsx';

// Opened from the setup link an admin sends: the user chooses a password and is logged in.
export default function SetPassword({ token, onSuccess, onCancel }) {
  const [invite, setInvite] = useState(null); // { name, email }
  const [linkError, setLinkError] = useState('');
  const [form, setForm] = useState({ password: '', confirm: '' });
  const [errors, setErrors] = useState({});
  const [formError, setFormError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => { api.invite(token).then(setInvite).catch((e) => setLinkError(e.message)); }, [token]);

  const change = (e) => setForm({ ...form, [e.target.name]: e.target.value });

  const submit = async (e) => {
    e.preventDefault();
    const next = {};
    if (form.password.length < 8) next.password = 'Use at least 8 characters.';
    else if (form.password !== form.confirm) next.confirm = "The passwords don't match.";
    setErrors(next);
    setFormError('');
    if (Object.keys(next).length) return;

    setLoading(true);
    try {
      const { user } = await api.setPassword(token, form.password);
      onSuccess(user);
    } catch (err) {
      setErrors(err.fields || {});
      if (!Object.keys(err.fields || {}).length) setFormError(err.message);
    } finally {
      setLoading(false);
    }
  };

  if (linkError) {
    return (
      <AuthLayout title="Link not valid" subtitle={linkError}>
        <button className="primary" type="button" onClick={onCancel}>Go to log in</button>
      </AuthLayout>
    );
  }
  if (!invite) return <div className="splash" aria-busy="true">PaySplit</div>;

  return (
    <AuthLayout title={`Welcome, ${invite.name.split(' ')[0]}`} subtitle={`Choose a password for ${invite.email}. You'll use it to log in from now on.`}>
      <form onSubmit={submit} noValidate>
        {formError && <div className="form-error" role="alert">{formError}</div>}
        <input type="email" name="username" value={invite.email} autoComplete="username" readOnly hidden />
        <Field label="New password" name="password" type="password" autoComplete="new-password"
          value={form.password} onChange={change} error={errors.password} hint="At least 8 characters." autoFocus />
        <Field label="Confirm password" name="confirm" type="password" autoComplete="new-password"
          value={form.confirm} onChange={change} error={errors.confirm} />
        <button className="primary" type="submit" disabled={loading}>
          {loading ? 'Saving…' : 'Set password and log in'}
        </button>
      </form>
    </AuthLayout>
  );
}
