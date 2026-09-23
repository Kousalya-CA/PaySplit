// Two-column layout shared by the login and signup pages.
// The left panel shows a sample bill being split, so people see what PaySplit does.
const shares = [
  { initial: 'A', name: 'Arun', paid: true },
  { initial: 'D', name: 'Divya', paid: true },
  { initial: 'K', name: 'Karthik', paid: false },
  { initial: 'M', name: 'Meena', paid: false },
];

export default function AuthLayout({ title, subtitle, children }) {
  return (
    <div className="auth">
      <aside className="auth-brand">
        <div className="logo"><span className="logo-mark" aria-hidden="true" />PaySplit</div>

        <div className="bill" aria-hidden="true">
          <div className="bill-head">
            <span>Dinner on Friday</span>
            <strong>₹1,240</strong>
          </div>
          <div className="bill-bar">
            {shares.map((s) => <span key={s.name} className={s.paid ? 'paid' : ''} />)}
          </div>
          <ul className="bill-people">
            {shares.map((s) => (
              <li key={s.name}>
                <span className="avatar">{s.initial}</span>
                <span>{s.name}</span>
                <span className="amount">₹310</span>
                <span className={`status ${s.paid ? 'paid' : ''}`}>{s.paid ? 'Paid' : 'Owes'}</span>
              </li>
            ))}
          </ul>
        </div>

        <p className="tagline">Split bills with friends and always know who owes what.</p>
      </aside>

      <main className="auth-main">
        <div className="auth-card">
          <div className="logo logo-mobile"><span className="logo-mark" aria-hidden="true" />PaySplit</div>
          <h1>{title}</h1>
          <p className="subtitle">{subtitle}</p>
          {children}
        </div>
      </main>
    </div>
  );
}
