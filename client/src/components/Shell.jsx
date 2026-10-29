import { useHashRoute } from '../useHashRoute.js';
import SummaryPage from '../pages/SummaryPage.jsx';
import CustomersPage from '../pages/CustomersPage.jsx';
import CustomerDetail from '../pages/CustomerDetail.jsx';
import EmployeesPage from '../pages/EmployeesPage.jsx';
import PaymentsPage from '../pages/PaymentsPage.jsx';
import UsersPage, { roleLabel } from '../pages/UsersPage.jsx';
import EmployeeDetail from '../pages/EmployeeDetail.jsx';
import SowTracker from '../pages/SowTracker.jsx';
import Logo from './Logo.jsx';
import { useEffect } from 'react';
import Timesheet from '../pages/Timesheet.jsx';
import AzureDevOpsPage from '../pages/AzureDevOpsPage.jsx';
import DeploymentsPage, { CustomerDeployments } from '../pages/Deployments.jsx';
import PayoutsPage from '../pages/PayoutsPage.jsx';

// Employee logins see only Summary, Employees and All payments, each with just their own data,
// plus Deployments (customer names only), which anyone can add to.
const NAV = [
  ['summary', 'Summary'],
  ['customers', 'Customers', { admin: true }],
  ['employees', 'Employees'],
  ['payments', 'All payments'],
  ['payouts', 'Payouts', { admin: true }],
  ['deployments', 'Deployments'],
  ['sow', 'SOW Tracker'],
  ['timesheet', 'Timesheet'],
  ['users', 'Users', { admin: true }],
  ['azure-devops', 'Azure DevOps', { admin: true }],
];

// The BlackTops widget is for signed-in people only, so it's loaded here and never on the login page.
function useBlackTopsWidget() {
  useEffect(() => {
    if (document.getElementById('blacktops-widget')) return;
    const s = document.createElement('script');
    s.id = 'blacktops-widget';
    s.src = 'https://api.blacktops.ai/widget/blacktop.js';
    s.async = true;
    s.dataset.projectId = 'growthfactor-dev';
    s.dataset.environment = 'dev';
    document.head.appendChild(s);
  }, []);
}

export default function Shell({ user, onLogout }) {
  const [section = 'summary', id, sub] = useHashRoute();
  useBlackTopsWidget();
  const isAdmin = user.role === 'admin';

  let page;
  if (section === 'customers' && id && sub === 'deployments' && isAdmin) page = <CustomerDeployments key={id} customerId={Number(id)} user={user} />;
  else if (section === 'customers' && id && isAdmin) page = <CustomerDetail key={id} id={Number(id)} />;
  else if (section === 'customers' && isAdmin) page = <CustomersPage />;
  else if (section === 'employees' && id) page = <EmployeeDetail key={id} id={Number(id)} isAdmin={isAdmin} />;
  else if (section === 'employees') page = <EmployeesPage isAdmin={isAdmin} />;
  else if (section === 'azure-devops' && isAdmin) page = <AzureDevOpsPage />;
  else if (section === 'deployments') page = <DeploymentsPage user={user} customerId={id ? Number(id) : null} />;
  else if (section === 'timesheet') page = <Timesheet isAdmin={isAdmin} />;
  else if (section === 'sow') page = <SowTracker isAdmin={isAdmin} user={user} />;
  else if (section === 'payments') page = <PaymentsPage isAdmin={isAdmin} />;
  else if (section === 'users' && isAdmin) page = <UsersPage me={user} />;
  else if (section === 'payouts' && isAdmin) page = <PayoutsPage key={id || 'list'} quarter={id || null} user={user} />;
  else page = <SummaryPage isAdmin={isAdmin} />;

  return (
    <div className="app">
      <header className="topbar">
        <Logo href="#/summary" />
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
