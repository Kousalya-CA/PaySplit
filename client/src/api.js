// Small wrapper around fetch for the PaySplit API. Cookies carry the session.
async function request(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || 'Something went wrong. Try again.');
    err.fields = data.errors || {};
    err.status = res.status;
    throw err;
  }
  return data;
}

export const api = {
  me: () => request('/auth/me'),
  login: (email, password) => request('/auth/login', { method: 'POST', body: { email, password } }),
  signup: (name, email, password) => request('/auth/signup', { method: 'POST', body: { name, email, password } }),
  logout: () => request('/auth/logout', { method: 'POST' }),
};
