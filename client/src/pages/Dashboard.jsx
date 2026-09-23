// Placeholder page shown after login. Build groups and expenses from here.
export default function Dashboard({ user, onLogout }) {
  const first = user.name.split(' ')[0];
  return (
    <div className="dash">
      <header className="dash-top">
        <div className="logo"><span className="logo-mark" aria-hidden="true" />PaySplit</div>
        <div className="dash-user">
          <span className="avatar">{first[0].toUpperCase()}</span>
          <span className="dash-email">{user.email}</span>
          <button className="secondary" onClick={onLogout}>Log out</button>
        </div>
      </header>
      <main className="dash-main">
        <h1>Hi {first}, you're all settled up.</h1>
        <p>You don't have any groups yet. Create one for a trip, a flat or a dinner, then add bills to split.</p>
        <button className="primary" disabled title="Coming next">Create a group</button>
      </main>
    </div>
  );
}
