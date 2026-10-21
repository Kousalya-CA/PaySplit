const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export const money = (n, currency = 'INR') => moneyIn(n, currency);

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

// '2026-Q4' -> 'Q4 2026'
export const quarterLabel = (q) => `${q.slice(5)} ${q.slice(0, 4)}`;
// A quarterly payout line's status in words.
export const payoutStatusLabel = { submitted: 'Waiting for approval', approved: 'Approved, not paid', paid: 'Paid' };

// Employee ratings on each payment month: 1 is the best.
export const RATINGS = [[1, 'Exceptional'], [2, 'Exceeds expectation'], [3, 'Meets expectation'], [4, 'Needs Improvement'], [5, 'Unsatisfactory']];
export const ratingLabel = (n) => (n ? `${n} · ${RATINGS.find(([v]) => v === n)?.[1] || ''}` : 'Not rated');

// '2026-10-06' -> '6 Oct 2026'
export const dayLabel = (iso) => {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
};

// Currencies a customer can be billed in (the server has the same list).
export const CURRENCIES = ['INR', 'USD', 'EUR', 'GBP', 'AUD', 'SGD', 'AED'];
const formatters = new Map();
const formatter = (currency) => {
  if (!formatters.has(currency)) {
    formatters.set(currency, new Intl.NumberFormat(currency === 'INR' ? 'en-IN' : 'en-US',
      { style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  }
  return formatters.get(currency);
};
// moneyIn(1200, 'USD') -> '$1,200.00'; INR by default.
export const moneyIn = (n, currency = 'INR') => formatter(currency).format(Math.abs(n) < 0.005 ? 0 : n || 0);
// 'USD' -> '$', 'AED' -> 'AED'
export const currencySymbol = (currency) =>
  formatter(currency).formatToParts(0).find((p) => p.type === 'currency')?.value || currency;
// [{ currency, amount }] -> '₹1,10,000.00 · $300.00'
export const moneyList = (list) => (list.length ? list.map((x) => moneyIn(x.amount, x.currency)).join(' · ') : null);
