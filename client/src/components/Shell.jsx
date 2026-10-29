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
import RolesPage from '../pages/RolesPage.jsx';
import ProfilePage from '../pages/ProfilePage.jsx';
import { useEffect } from 'react';
import Timesheet from '../pages/Timesheet.jsx';
import AzureDevOpsPage from '../pages/AzureDevOpsPage.jsx';
import DeploymentsPage, { CustomerDeployments } from '../pages/Deployments.jsx';
import PayoutsPage from '../pages/PayoutsPage.jsx';

// The tabs. Which ones a person sees comes from their role (user.tabs, set on Roles & access);
// admins and the owner see them all. Employee-type roles see only their own pay data.
const NAV = [
  ['summary', 'Summary'],
  ['customers', 'Customers'],
  ['employees', 'Employees'],
  ['payments', 'All payments'],
  ['payouts', 'Payouts'],
  ['deployments', 'Deployments'],
  ['sow', 'Sprint Tracker'],
  ['timesheet', 'Timesheet'],
  ['users', 'Users'],
  ['roles', 'Roles & access'],
  ['azure-devops', 'Azure DevOps'],
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

export default function Shell({ user, onLogout, onUserChange }) {
  const [asked = 'summary', id, sub] = useHashRoute();
  useBlackTopsWidget();
  const isAdmin = user.role === 'admin';
  // Only the tabs this person's role has; anything else opens their first tab.
  const allowed = new Set(user.tabs || []);
  const nav = NAV.filter(([key]) => allowed.has(key));
  // My profile is open to everyone; other pages need the tab.
  const section = asked === 'profile' || allowed.has(asked) ? asked : nav[0]?.[0] || '';

  let page;
  if (section === 'customers' && id && sub === 'deployments' && isAdmin) page = <CustomerDeployments key={id} customerId={Number(id)} user={user} />;
  else if (section === 'customers' && id && isAdmin) page = <CustomerDetail key={id} id={Number(id)} />;
  else if (section === 'customers' && isAdmin) page = <CustomersPage />;
  else if (section === 'employees' && id) page = <EmployeeDetail key={id} id={Number(id)} isAdmin={isAdmin} />;
  else if (section === 'employees') page = <EmployeesPage isAdmin={isAdmin} />;
  else if (section === 'azure-devops' && isAdmin) page = <AzureDevOpsPage />;
  else if (section === 'deployments') page = <DeploymentsPage user={user} customerId={id ? Number(id) : null} />;
  else if (section === 'timesheet') page = <Timesheet isAdmin={isAdmin} user={user} />;
  else if (section === 'sow') page = <SowTracker isAdmin={isAdmin} user={user} />;
  else if (section === 'payments') page = <PaymentsPage isAdmin={isAdmin} />;
  else if (section === 'users' && isAdmin) page = <UsersPage me={user} />;
  else if (section === 'payouts' && isAdmin) page = <PayoutsPage key={id || 'list'} quarter={id || null} user={user} />;
  else if (section === 'roles' && isAdmin) page = <RolesPage />;
  else if (section === 'profile') page = <ProfilePage onUserChange={onUserChange} />;
  else if (section === 'summary') page = <SummaryPage isAdmin={isAdmin} />;
  else page = <div className="empty"><p>Your role doesn't include any tabs yet. Ask an admin to give it access on Roles &amp; access.</p></div>;

  return (
    <div className="app">
      <header className="topbar">
        <Logo href={`#/${nav[0]?.[0] || ''}`} />
        <nav aria-label="Main">
          {nav.map(([key, label]) => (
            <a key={key} href={`#/${key}`} aria-current={section === key ? 'page' : undefined}>{label}</a>
          ))}
        </nav>
        <div className="topbar-user">
          <a className={`avatar${section === 'profile' ? ' on' : ''}`} href="#/profile" title={`My profile: ${user.name} (${user.email}), ${roleLabel(user)}`}
            aria-current={section === 'profile' ? 'page' : undefined}>
            {user.photo ? <img src={user.photo} alt="My profile" /> : <><span aria-hidden="true">{user.name[0].toUpperCase()}</span><span className="sr-only">My profile</span></>}
          </a>
          <button className="ghost" onClick={onLogout}>Log out</button>
        </div>
      </header>
      <main className="page">{page}</main>
    </div>
  );
}
