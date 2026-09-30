import { useHashRoute } from '../useHashRoute.js';
import SummaryPage from '../pages/SummaryPage.jsx';
import CustomersPage from '../pages/CustomersPage.jsx';
import CustomerDetail from '../pages/CustomerDetail.jsx';
import EmployeesPage from '../pages/EmployeesPage.jsx';
import PaymentsPage from '../pages/PaymentsPage.jsx';
import UsersPage, { roleLabel } from '../pages/UsersPage.jsx';

const NAV = [
  ['summary', 'Summary'],
  ['customers', 'Customers'],
  ['employees', 'Employees'],
  ['payments', 'All payments'],
  ['users', 'Users', { admin: true }],
];

export default function Shell({ user, onLogout }) {
  const [section = 'summary', id] = useHashRoute();
  const isAdmin = user.role === 'admin';

  let page;
  if (section === 'customers' && id) page = <CustomerDetail key={id} id={Number(id)} />;
  else if (section === 'customers') page = <CustomersPage />;
  else if (section === 'employees') page = <EmployeesPage />;
  else if (section === 'payments') page = <PaymentsPage />;
  else if (section === 'users' && isAdmin) page = <UsersPage me={user} />;
  else page = <SummaryPage />;

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
