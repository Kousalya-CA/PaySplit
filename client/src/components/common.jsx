// Shared bits used across pages.
import { moneyIn } from '../format.js';

export function Loading() {
  return <p className="muted" aria-busy="true">Loading…</p>;
}

export function ErrorNote({ children }) {
  return children ? <div className="form-error" role="alert">{children}</div> : null;
}

export function Money({ value, currency = 'INR' }) {
  const zero = Math.abs(value || 0) < 0.005;
  return <span className={zero ? 'num zero' : 'num'}>{zero ? '–' : moneyIn(value, currency)}</span>;
}
