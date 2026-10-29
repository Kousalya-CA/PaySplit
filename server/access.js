// Roles & access: which tabs each role can open. Admins (and the owner) always have every tab.
// Every other user has the built-in Employee role or a custom role (users.role = 'employee' with
// users.role_id), each with its own list of tabs. Admin tabs hold pay and company data and can't
// be given to other roles. A tab a role doesn't have is hidden and its data is refused (403).
import { db } from './db.js';

export const TABS = [
  { key: 'summary', label: 'Summary' },
  { key: 'customers', label: 'Customers', admin: true },
  { key: 'employees', label: 'Employees' },
  { key: 'payments', label: 'All payments' },
  { key: 'payouts', label: 'Payouts', admin: true },
  { key: 'deployments', label: 'Deployments' },
  { key: 'sow', label: 'Sprint Tracker' },
  { key: 'timesheet', label: 'Timesheet' },
  { key: 'users', label: 'Users', admin: true },
  { key: 'roles', label: 'Roles & access', admin: true },
  { key: 'azure-devops', label: 'Azure DevOps', admin: true },
];
export const OPEN_TABS = TABS.filter((t) => !t.admin).map((t) => t.key);
const ALL_TABS = TABS.map((t) => t.key);

const q = {
  role: db.prepare('SELECT * FROM roles WHERE id = ?'),
  builtin: db.prepare('SELECT * FROM roles WHERE builtin = 1'),
};
const parseTabs = (text) => {
  try { return JSON.parse(text).filter((k) => OPEN_TABS.includes(k)); } catch { return []; }
};

// The role row a non-admin user has: their custom role, else the built-in Employee role.
export function roleOf(user) {
  return (user.role_id && q.role.get(user.role_id)) || q.builtin.get();
}
export function tabsFor(user) {
  if (!user) return [];
  if (user.role === 'admin') return ALL_TABS;
  const role = roleOf(user);
  return role ? parseTabs(role.tabs) : [];
}
export const roleName = (user) => (user.role === 'admin' ? 'Admin' : roleOf(user)?.name || 'Employee');

// The tab an API path belongs to, for refusing data from a tab the user's role doesn't have.
// Paths not listed (login, the user's own account) are open to everyone signed in.
const API_TABS = [
  [/^\/api\/(summary|my\/statements)\b/, 'summary'],
  [/^\/api\/employees\b/, 'employees'],
  [/^\/api\/payments\b/, 'payments'],
  [/^\/api\/(deployments|deployment-options)\b|^\/api\/customers\/\d+\/features\b/, 'deployments'],
  [/^\/api\/(sow|holidays|leaves|tasks|time-logs)\b/, 'sow'],
  [/^\/api\/timesheet\b/, 'timesheet'],
];
export const tabForApi = (path) => API_TABS.find(([re]) => re.test(path))?.[1] || null;
export const tabLabel = (key) => TABS.find((t) => t.key === key)?.label || key;
export { parseTabs };
