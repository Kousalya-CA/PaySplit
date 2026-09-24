import { useEffect, useState } from 'react';

// Tiny hash router: '#/customers/3' -> ['customers', '3']
const read = () => window.location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);

export function useHashRoute() {
  const [parts, setParts] = useState(read);
  useEffect(() => {
    const onChange = () => { setParts(read()); window.scrollTo(0, 0); };
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return parts;
}

export const navigate = (path) => { window.location.hash = path; };
