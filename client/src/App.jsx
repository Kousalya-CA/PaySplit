import { useEffect, useState } from 'react';
import { api } from './api.js';
import Login from './pages/Login.jsx';
import Setup from './pages/Setup.jsx';
import SetPassword from './pages/SetPassword.jsx';
import Shell from './components/Shell.jsx';

// '#/set-password/<token>' is the link an admin sends a new user.
const inviteToken = () => window.location.hash.match(/^#\/set-password\/([a-f0-9]+)/)?.[1];

export default function App() {
  const [user, setUser] = useState(null);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [token, setToken] = useState(inviteToken);
  const [checking, setChecking] = useState(true);

  // Restore an existing session on page load; if there is none, check whether the app has any accounts yet.
  useEffect(() => {
    api.me()
      .then(({ user }) => setUser(user))
      .catch(() => api.status().then((s) => setNeedsSetup(s.needsSetup)).catch(() => {}))
      .finally(() => setChecking(false));
  }, []);

  // If the session expires, any API call sends us back to the login page.
  useEffect(() => {
    const onExpired = () => setUser(null);
    const onHash = () => setToken(inviteToken());
    window.addEventListener('paysplit:logout', onExpired);
    window.addEventListener('hashchange', onHash);
    return () => {
      window.removeEventListener('paysplit:logout', onExpired);
      window.removeEventListener('hashchange', onHash);
    };
  }, []);

  const logout = async () => {
    await api.logout().catch(() => {});
    setUser(null);
  };

  const signedIn = (u) => {
    setNeedsSetup(false);
    setUser(u);
  };

  if (checking) return <div className="splash" aria-busy="true">PaySplit</div>;
  if (token) {
    return (
      <SetPassword
        token={token}
        onSuccess={(u) => { window.location.hash = '#/summary'; setToken(null); signedIn(u); }}
        onCancel={() => { window.location.hash = ''; setToken(null); }}
      />
    );
  }
  if (user) return <Shell user={user} onLogout={logout} />;
  if (needsSetup) return <Setup onSuccess={signedIn} />;
  return <Login onSuccess={signedIn} />;
}
