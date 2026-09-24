// Shared bits used across pages.
export function Loading() {
  return <p className="muted" aria-busy="true">Loading…</p>;
}

export function ErrorNote({ children }) {
  return children ? <div className="form-error" role="alert">{children}</div> : null;
}

export function Money({ value }) {
  const zero = Math.abs(value || 0) < 0.005;
  const text = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(zero ? 0 : value);
  return <span className={zero ? 'num zero' : 'num'}>{zero ? '–' : `₹${text}`}</span>;
}
