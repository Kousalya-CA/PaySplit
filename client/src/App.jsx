import { useEffect, useState } from 'react';
import { api } from './api.js';
import Login from './pages/Login.jsx';
import Signup from './pages/Signup.jsx';
import Dashboard from './pages/Dashboard.jsx';

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

  const logout = async () => {
    await api.logout().catch(() => {});
    setUser(null);
    setView('login');
  };

  if (checking) return <div className="splash" aria-busy="true">PaySplit</div>;
  if (user) return <Dashboard user={user} onLogout={logout} />;
  return view === 'login'
    ? <Login onSuccess={setUser} onSwitch={() => setView('signup')} />
    : <Signup onSuccess={setUser} onSwitch={() => setView('login')} />;
}
