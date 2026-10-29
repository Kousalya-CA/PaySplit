import Logo from '../components/Logo.jsx';

// Two-column layout shared by the login and setup pages. The left panel shows a team climbing a
// growth chart (gently animated), so people see what GrowthFactor is about.
export default function AuthLayout({ title, subtitle, children }) {
  return (
    <div className="auth">
      <aside className="auth-brand">
        <Logo />

        <div className="hero" aria-hidden="true">
          <div className="hero-card">
            <img src="/login-growth.avif" alt="" width="626" height="417" />
            <span className="hero-shine" />
          </div>
          <span className="hero-chip chip-growth"><b>▲ 18%</b> growth this quarter</span>
        </div>

        <p className="tagline">Share revenue growth with the team that earns it.</p>
      </aside>

      <main className="auth-main">
        <div className="auth-card">
          <Logo className="logo logo-mobile" />
          <img className="hero-mobile" src="/login-growth.avif" alt="" width="626" height="417" aria-hidden="true" />
          <h1>{title}</h1>
          <p className="subtitle">{subtitle}</p>
          {children}
        </div>
      </main>
    </div>
  );
}
