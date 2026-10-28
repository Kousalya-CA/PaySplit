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
    setRelieved: (id, relievedOn, note) => request(`/employees/${id}/relieved`, { method: 'PUT', body: { relieved_on: relievedOn, note } }),
    addPip: (id, body) => request(`/employees/${id}/pips`, { method: 'POST', body }),
    updatePip: (pipId, body) => request(`/pips/${pipId}`, { method: 'PUT', body }),
    removePip: (pipId) => request(`/pips/${pipId}`, { method: 'DELETE' }),
  },
  sow: (month, refresh) => request(`/sow?month=${encodeURIComponent(month || '')}${refresh ? '&refresh=1' : ''}`),
  holidays: {
    add: (day, name) => request('/holidays', { method: 'POST', body: { day, name } }),
    remove: (id) => request(`/holidays/${id}`, { method: 'DELETE' }),
    setHours: (hours) => request('/holidays/hours', { method: 'PUT', body: { hours_per_day: hours } }),
    addLeave: (body) => request('/leaves', { method: 'POST', body }),
    removeLeave: (id) => request(`/leaves/${id}`, { method: 'DELETE' }),
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
    work: (id, { from, to } = {}, refresh) => {
      const query = new URLSearchParams({ ...(from ? { from } : {}), ...(to ? { to } : {}), ...(refresh ? { refresh: '1' } : {}) }).toString();
      return request(`/customers/${id}/work${query ? `?${query}` : ''}`);
    },
  },
  periods: {
    save: (id, body) => request(`/periods/${id}`, { method: 'PUT', body }),
    markAllPaid: (id, paidOn) => request(`/periods/${id}/paid`, { method: 'POST', body: { paid_on: paidOn } }),
  },
  allocations: {
    markPaid: (id, paidOn) => request(`/allocations/${id}/paid`, { method: 'POST', body: { paid_on: paidOn } }),
    undoPaid: (id) => request(`/allocations/${id}/paid`, { method: 'DELETE' }),
    markPart: (id, seq, paidOn) => request(`/allocations/${id}/parts/${seq}/paid`, { method: 'POST', body: { paid_on: paidOn } }),
    undoPart: (id, seq) => request(`/allocations/${id}/parts/${seq}/paid`, { method: 'DELETE' }),
  },
  deployments: {
    list: () => request('/deployments'),
    create: (body) => request('/deployments', { method: 'POST', body }),
    update: (id, body) => request(`/deployments/${id}`, { method: 'PATCH', body }),
    remove: (id) => request(`/deployments/${id}`, { method: 'DELETE' }),
    addOption: (kind, name) => request('/deployment-options', { method: 'POST', body: { kind, name } }),
    removeOption: (id) => request(`/deployment-options/${id}`, { method: 'DELETE' }),
    setFeatures: (customerId, features) => request(`/customers/${customerId}/features`, { method: 'PUT', body: { features } }),
  },
  payouts: {
    list: () => request('/payouts'),
    get: (quarter) => request(`/payouts/${quarter}`),
    saveNote: (quarter, employeeId, comment) => request(`/payouts/${quarter}/notes/${employeeId}`, { method: 'PUT', body: { comment } }),
    submit: (quarter, comments) => request(`/payouts/${quarter}/submit`, { method: 'POST', body: { comments } }),
    approve: (lineId, comment) => request(`/payout-lines/${lineId}/approve`, { method: 'POST', body: { comment } }),
    approveAll: (quarter) => request(`/payouts/${quarter}/approve-all`, { method: 'POST' }),
    undoApprove: (lineId, comment) => request(`/payout-lines/${lineId}/undo-approve`, { method: 'POST', body: { comment } }),
    undoSubmit: (lineId, comment) => request(`/payout-lines/${lineId}/undo-submit`, { method: 'POST', body: { comment } }),
    markPaid: (lineId, paidOn) => request(`/payout-lines/${lineId}/paid`, { method: 'POST', body: { paid_on: paidOn } }),
    markAllPaid: (quarter, paidOn) => request(`/payouts/${quarter}/paid`, { method: 'POST', body: { paid_on: paidOn } }),
    moveDraft: (quarter, employeeId, currency, comment) => request(`/payouts/${quarter}/move`, { method: 'POST', body: { employee_id: employeeId, currency, comment } }),
    moveLine: (lineId, comment) => request(`/payout-lines/${lineId}/move`, { method: 'POST', body: { comment } }),
    moveBack: (moveId, comment) => request(`/payout-moves/${moveId}/move-back`, { method: 'POST', body: { comment } }),
    undoPaid: (lineId, comment) => request(`/payout-lines/${lineId}/undo-paid`, { method: 'POST', body: { comment } }),
    undoAllPaid: (quarter, comment) => request(`/payouts/${quarter}/undo-paid`, { method: 'POST', body: { comment } }),
    saveSettings: (payLag, approvalsRequired) => request('/payout-settings', { method: 'PUT', body: { pay_lag: payLag, approvals_required: approvalsRequired } }),
    mine: () => request('/my/statements'),
  },
  exchangeRate: (from) => request(`/exchange-rate?from=${from}`),
  payments: () => request('/payments'),
  summary: (currency) => request(`/summary${currency ? `?currency=${currency}` : ''}`),
};
