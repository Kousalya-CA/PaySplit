import Logo from '../components/Logo.jsx';

// Two-column layout shared by the login and setup pages.
// The left panel shows a sample quarter's growth pool, so people see what Growthfactor does.
const shares = [
  { initial: 'A', name: 'Arun', weight: '40%', amount: '$398', status: 'Paid', tone: 'paid' },
  { initial: 'D', name: 'Divya', weight: '30%', amount: '$299', status: 'Approved', tone: 'ok' },
  { initial: 'K', name: 'Karthik', weight: '20%', amount: '$199', status: 'Approved', tone: 'ok' },
  { initial: 'M', name: 'Meena', weight: '10%', amount: '$100', status: 'Waiting', tone: 'wait' },
];

export default function AuthLayout({ title, subtitle, children }) {
  return (
    <div className="auth">
      <aside className="auth-brand">
        <Logo />

        <div className="bill" aria-hidden="true">
          <div className="bill-head">
            <span>Growth pool · Q4 2026</span>
            <strong>$996</strong>
          </div>
          <div className="bill-bar">
            {shares.map((s, i) => <span key={s.name} className={`seg-${i}`} style={{ flexGrow: parseInt(s.weight, 10) }} />)}
          </div>
          <ul className="bill-people">
            {shares.map((s, i) => (
              <li key={s.name}>
                <span className={`avatar av-${i}`}>{s.initial}</span>
                <span>{s.name} <small>{s.weight}</small></span>
                <span className="amount">{s.amount}</span>
                <span className={`status ${s.tone}`}>{s.status}</span>
              </li>
            ))}
          </ul>
        </div>

        <p className="tagline">Share revenue growth with the team that earns it.</p>
      </aside>

      <main className="auth-main">
        <div className="auth-card">
          <Logo className="logo logo-mobile" />
          <h1>{title}</h1>
          <p className="subtitle">{subtitle}</p>
          {children}
        </div>
      </main>
    </div>
  );
}
