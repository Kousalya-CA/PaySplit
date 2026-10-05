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

// Yearly and Three Years customers both have one period per year; Monthly ones one per month.
export const isYearly = (frequency) => frequency === 'Yearly' || frequency === 'Three Years';
export const periodStep = (frequency) => (isYearly(frequency) ? 12 : 1);

export const periodLabel = (ym, frequency) =>
  isYearly(frequency) ? `${monthLabel(ym)} to ${monthLabel(addMonths(ym, 11))}` : monthLabel(ym);

// Three Years customers: 'Year 1 of 3' for the period starting in the onboard month, and so on.
// Years added after the contract ends are just 'Year 4', 'Year 5'. Null for other frequencies.
export const contractYearLabel = (customer, ym) => {
  if (customer.frequency !== 'Three Years') return null;
  const [y1, m1] = customer.onboard_month.split('-').map(Number);
  const [y2, m2] = ym.split('-').map(Number);
  const n = Math.floor(((y2 - y1) * 12 + (m2 - m1)) / 12) + 1;
  return n >= 1 && n <= 3 ? `Year ${n} of 3` : `Year ${n}`;
};

// 0.142857 -> '14.29%'
export const pct = (fraction) => `${+(fraction * 100).toFixed(2)}%`;

// Fraction -> editable percent text. (The editor keeps the exact stored value unless the field is retyped.)
export const toPctInput = (fraction) => String(+(fraction * 100).toFixed(2));

export const parseNum = (text) => {
  if (typeof text === 'number') return text;
  const n = Number(String(text).replace(/,/g, '').trim());
  return String(text).trim() === '' || !Number.isFinite(n) ? NaN : n;
};
