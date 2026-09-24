const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export const money = (n) => inr.format(Math.abs(n) < 0.005 ? 0 : n || 0);

// '2026-09' -> 'Sep 2026'
export const monthLabel = (ym) => {
  const [y, m] = ym.split('-').map(Number);
  return `${MONTHS[m - 1]} ${y}`;
};

export const addMonths = (ym, n) => {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};

export const periodLabel = (ym, frequency) =>
  frequency === 'Yearly' ? `${monthLabel(ym)} to ${monthLabel(addMonths(ym, 11))}` : monthLabel(ym);

// 0.142857 -> '14.29%'
export const pct = (fraction) => `${+(fraction * 100).toFixed(2)}%`;

// Fraction -> editable percent text. (The editor keeps the exact stored value unless the field is retyped.)
export const toPctInput = (fraction) => String(+(fraction * 100).toFixed(2));

export const parseNum = (text) => {
  if (typeof text === 'number') return text;
  const n = Number(String(text).replace(/,/g, '').trim());
  return String(text).trim() === '' || !Number.isFinite(n) ? NaN : n;
};
