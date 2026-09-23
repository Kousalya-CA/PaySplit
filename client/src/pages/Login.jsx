import { useState } from 'react';
import { api } from '../api.js';
import AuthLayout from './AuthLayout.jsx';
import Field from './Field.jsx';

export default function Login({ onSuccess, onSwitch }) {
  const [form, setForm] = useState({ email: '', password: '' });
  const [errors, setErrors] = useState({});
  const [formError, setFormError] = useState('');
  const [loading, setLoading] = useState(false);

  const change = (e) => setForm({ ...form, [e.target.name]: e.target.value });

  const submit = async (e) => {
    e.preventDefault();
    const next = {};
    if (!form.email.trim()) next.email = 'Enter your email.';
    if (!form.password) next.password = 'Enter your password.';
    setErrors(next);
    setFormError('');
    if (Object.keys(next).length) return;

    setLoading(true);
    try {
      const { user } = await api.login(form.email, form.password);
      onSuccess(user);
    } catch (err) {
      setFormError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthLayout title="Log in" subtitle="Welcome back. Your groups and balances are waiting.">
      <form onSubmit={submit} noValidate>
        {formError && <div className="form-error" role="alert">{formError}</div>}
        <Field label="Email" name="email" type="email" autoComplete="email"
          value={form.email} onChange={change} error={errors.email} autoFocus />
        <Field label="Password" name="password" type="password" autoComplete="current-password"
          value={form.password} onChange={change} error={errors.password} />
        <button className="primary" type="submit" disabled={loading}>
          {loading ? 'Logging in…' : 'Log in'}
        </button>
      </form>
      <p className="switch">
        New to PaySplit? <button type="button" className="link" onClick={onSwitch}>Create an account</button>
      </p>
    </AuthLayout>
  );
}
