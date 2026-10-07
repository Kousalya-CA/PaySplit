import { useHashRoute } from '../useHashRoute.js';
import SummaryPage from '../pages/SummaryPage.jsx';
import CustomersPage from '../pages/CustomersPage.jsx';
import CustomerDetail from '../pages/CustomerDetail.jsx';
import EmployeesPage from '../pages/EmployeesPage.jsx';
import PaymentsPage from '../pages/PaymentsPage.jsx';
import UsersPage, { roleLabel } from '../pages/UsersPage.jsx';
import EmployeeDetail from '../pages/EmployeeDetail.jsx';
import AzureDevOpsPage from '../pages/AzureDevOpsPage.jsx';

// Employee logins see only Summary, Employees and All payments, each with just their own data.
const NAV = [
  ['summary', 'Summary'],
  ['customers', 'Customers', { admin: true }],
  ['employees', 'Employees'],
  ['payments', 'All payments'],
  ['users', 'Users', { admin: true }],
  ['azure-devops', 'Azure DevOps', { admin: true }],
];

export default function Shell({ user, onLogout }) {
  const [section = 'summary', id] = useHashRoute();
  const isAdmin = user.role === 'admin';

  let page;
  if (section === 'customers' && id && isAdmin) page = <CustomerDetail key={id} id={Number(id)} />;
  else if (section === 'customers' && isAdmin) page = <CustomersPage />;
  else if (section === 'employees' && id) page = <EmployeeDetail key={id} id={Number(id)} />;
  else if (section === 'employees') page = <EmployeesPage isAdmin={isAdmin} />;
  else if (section === 'azure-devops' && isAdmin) page = <AzureDevOpsPage />;
  else if (section === 'payments') page = <PaymentsPage isAdmin={isAdmin} />;
  else if (section === 'users' && isAdmin) page = <UsersPage me={user} />;
  else page = <SummaryPage isAdmin={isAdmin} />;

  return (
    <div className="app">
      <header className="topbar">
        <a className="logo" href="#/summary"><span className="logo-mark" aria-hidden="true" />PaySplit</a>
        <nav aria-label="Main">
          {NAV.filter(([, , opts]) => !opts?.admin || isAdmin).map(([key, label]) => (
            <a key={key} href={`#/${key}`} aria-current={section === key ? 'page' : undefined}>{label}</a>
          ))}
        </nav>
        <div className="topbar-user">
          <span className="avatar" title={`${user.name} (${user.email}), ${roleLabel(user)}`}>{user.name[0].toUpperCase()}</span>
          <button className="ghost" onClick={onLogout}>Log out</button>
        </div>
      </header>
      <main className="page">{page}</main>
    </div>
  );
}
