import { useState } from 'react';
import { api } from '../api.js';
import AuthLayout from './AuthLayout.jsx';
import Field from './Field.jsx';

export default function Signup({ onSuccess, onSwitch }) {
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [errors, setErrors] = useState({});
  const [formError, setFormError] = useState('');
  const [loading, setLoading] = useState(false);

  const change = (e) => setForm({ ...form, [e.target.name]: e.target.value });

  const submit = async (e) => {
    e.preventDefault();
    const next = {};
    if (!form.name.trim()) next.name = 'Enter your name.';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) next.email = 'Enter a valid email address.';
    if (form.password.length < 8) next.password = 'Use at least 8 characters.';
    setErrors(next);
    setFormError('');
    if (Object.keys(next).length) return;

    setLoading(true);
    try {
      const { user } = await api.signup(form.name, form.email, form.password);
      onSuccess(user);
    } catch (err) {
      setErrors(err.fields || {});
      if (!Object.keys(err.fields || {}).length) setFormError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthLayout title="Create your account" subtitle="Start a group, add a bill, and PaySplit does the maths.">
      <form onSubmit={submit} noValidate>
        {formError && <div className="form-error" role="alert">{formError}</div>}
        <Field label="Name" name="name" autoComplete="name"
          value={form.name} onChange={change} error={errors.name} autoFocus />
        <Field label="Email" name="email" type="email" autoComplete="email"
          value={form.email} onChange={change} error={errors.email} />
        <Field label="Password" name="password" type="password" autoComplete="new-password"
          value={form.password} onChange={change} error={errors.password} hint="At least 8 characters." />
        <button className="primary" type="submit" disabled={loading}>
          {loading ? 'Creating account…' : 'Create account'}
        </button>
      </form>
      <p className="switch">
        Already have an account? <button type="button" className="link" onClick={onSwitch}>Log in</button>
      </p>
    </AuthLayout>
  );
}
