// Small wrapper around fetch for the PaySplit API. The session cookie is sent automatically.
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
    if (res.status === 401 && !path.startsWith('/auth/')) window.dispatchEvent(new Event('paysplit:logout'));
    throw err;
  }
  return data;
}

export const api = {
  me: () => request('/auth/me'),
  login: (email, password) => request('/auth/login', { method: 'POST', body: { email, password } }),
  status: () => request('/auth/status'),
  setup: (name, email, password) => request('/auth/setup', { method: 'POST', body: { name, email, password } }),
  invite: (token) => request('/auth/invite', { method: 'POST', body: { token } }),
  setPassword: (token, password) => request('/auth/set-password', { method: 'POST', body: { token, password } }),
  logout: () => request('/auth/logout', { method: 'POST' }),

  users: {
    list: () => request('/users'),
    create: (body) => request('/users', { method: 'POST', body }),
    update: (id, body) => request(`/users/${id}`, { method: 'PATCH', body }),
    remove: (id) => request(`/users/${id}`, { method: 'DELETE' }),
    newLink: (id) => request(`/users/${id}/invite`, { method: 'POST' }),
    signOut: (id) => request(`/users/${id}/logout`, { method: 'POST' }),
  },

  employees: {
    list: () => request('/employees'),
    create: (body) => request('/employees', { method: 'POST', body }),
    update: (id, body) => request(`/employees/${id}`, { method: 'PATCH', body }),
    remove: (id) => request(`/employees/${id}`, { method: 'DELETE' }),
    tasks: (id, month) => request(`/employees/${id}/tasks${month ? `?month=${month}` : ''}`),
  },
  azdo: {
    config: () => request('/azdo/config'),
    saveConfig: (body) => request('/azdo/config', { method: 'PUT', body }),
    test: () => request('/azdo/test', { method: 'POST' }),
    addArea: (path, displayName) => request('/azdo/areas', { method: 'POST', body: { path, display_name: displayName } }),
    renameArea: (id, displayName) => request(`/azdo/areas/${id}`, { method: 'PATCH', body: { display_name: displayName } }),
    removeArea: (id) => request(`/azdo/areas/${id}`, { method: 'DELETE' }),
    addIteration: (areaId, path) => request(`/azdo/areas/${areaId}/iterations`, { method: 'POST', body: { path } }),
    refreshIteration: (id) => request(`/azdo/iterations/${id}/refresh`, { method: 'POST' }),
    removeIteration: (id) => request(`/azdo/iterations/${id}`, { method: 'DELETE' }),
  },
  customers: {
    list: () => request('/customers'),
    get: (id) => request(`/customers/${id}`),
    create: (body) => request('/customers', { method: 'POST', body }),
    update: (id, body) => request(`/customers/${id}`, { method: 'PATCH', body }),
    remove: (id) => request(`/customers/${id}`, { method: 'DELETE' }),
    work: (id, month, refresh) => {
      const query = new URLSearchParams({ ...(month ? { month } : {}), ...(refresh ? { refresh: '1' } : {}) }).toString();
      return request(`/customers/${id}/work${query ? `?${query}` : ''}`);
    },
  },
  periods: {
    save: (id, body) => request(`/periods/${id}`, { method: 'PUT', body }),
  },
  exchangeRate: () => request('/exchange-rate'),
  payments: () => request('/payments'),
  summary: () => request('/summary'),
};
