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

// Months in one period: 36 for Three Years, 12 for Yearly, 1 for Monthly.
export const periodMonths = (frequency) => ({ 'Three Years': 36, Yearly: 12 }[frequency] || 1);

// The months a period covers: 'Oct 2026' for one month, otherwise 'Oct 2026 to Sep 2027'.
// Yearly and Three Years periods cover their revenue share (cover_from / end_month from the server).
export const periodLabel = (period) => {
  const from = period.cover_from || period.start_month;
  const to = period.end_month || period.start_month;
  return from === to ? monthLabel(from) : `${monthLabel(from)} to ${monthLabel(to)}`;
};

// 'Paid in Dec 2026' when a payment is paid in a different month than it starts covering.
export const paidIn = (period) =>
  period.cover_from && period.cover_from !== period.start_month ? `Paid in ${monthLabel(period.start_month)}` : '';

// 0.142857 -> '14.29%'
export const pct = (fraction) => `${+(fraction * 100).toFixed(2)}%`;

// Fraction -> editable percent text. (The editor keeps the exact stored value unless the field is retyped.)
export const toPctInput = (fraction) => String(+(fraction * 100).toFixed(2));

export const parseNum = (text) => {
  if (typeof text === 'number') return text;
  const n = Number(String(text).replace(/,/g, '').trim());
  return String(text).trim() === '' || !Number.isFinite(n) ? NaN : n;
};
