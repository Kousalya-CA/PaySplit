import { useEffect, useState } from 'react';
import { api } from './api.js';
import Login from './pages/Login.jsx';
import Signup from './pages/Signup.jsx';
import Shell from './components/Shell.jsx';

export default function App() {
  const [user, setUser] = useState(null);
  const [view, setView] = useState('login');
  const [checking, setChecking] = useState(true);

  // Restore an existing session on page load.
  useEffect(() => {
    api.me()
      .then(({ user }) => setUser(user))
      .catch(() => {})
      .finally(() => setChecking(false));
  }, []);

  // If the session expires, any API call sends us back to the login page.
  useEffect(() => {
    const onExpired = () => setUser(null);
    window.addEventListener('paysplit:logout', onExpired);
    return () => window.removeEventListener('paysplit:logout', onExpired);
  }, []);

  const logout = async () => {
    await api.logout().catch(() => {});
    setUser(null);
    setView('login');
  };

  if (checking) return <div className="splash" aria-busy="true">PaySplit</div>;
  if (user) return <Shell user={user} onLogout={logout} />;
  return view === 'login'
    ? <Login onSuccess={setUser} onSwitch={() => setView('signup')} />
    : <Signup onSuccess={setUser} onSwitch={() => setView('login')} />;
}
