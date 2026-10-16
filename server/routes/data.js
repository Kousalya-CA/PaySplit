// Employees, customers, periods, contributor splits, payments and summaries.
import { db, transaction } from '../db.js';
import { HttpError } from '../http.js';

export const CATEGORIES = ['Direct', 'Support', 'Others'];
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const EPS = 1e-6;

// Months per period: a month for Monthly, 12 for Yearly, 36 for Three Years.
export const FREQUENCIES = {
  Monthly: { step: 1 },
  Yearly: { step: 12 },
  'Three Years': { step: 36 },
};
const MAX_PERIODS = 600;
const rateCache = new Map(); // currency -> { fetchedAt, value } for /api/exchange-rate

// Currencies a customer can be billed in. Pay is in the customer's currency unless a payment is
// converted to INR.
export const CURRENCIES = ['INR', 'USD', 'EUR', 'GBP', 'AUD', 'SGD', 'AED'];
const PAY_CURRENCY_SQL = "CASE WHEN p.fx_rate IS NOT NULL AND c.currency <> 'INR' THEN 'INR' ELSE c.currency END";

export function addMonths(ym, n) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

const isUniqueError = (err) => /UNIQUE constraint failed/i.test(err?.message || '');

function toNumber(value, label) {
  const n = typeof value === 'string' && value.trim() === '' ? NaN : Number(value);
  if (!Number.isFinite(n)) throw new HttpError(400, `${label} must be a number.`);
  return n;
}

// ---------- queries ----------------------------------------------------------
const q = {
  employees: db.prepare(`
    SELECT e.id, e.employee_code, e.name, e.email, e.active, e.type,
      (SELECT COUNT(*) FROM allocations a WHERE a.employee_id = e.id) AS split_count
    FROM employees e ORDER BY e.active DESC, e.id`),
  payByEmployeeCurrency: db.prepare('SELECT employee_id, currency, SUM(pay) AS amount FROM payments GROUP BY employee_id, currency ORDER BY currency'),
  employee: db.prepare('SELECT id, employee_code, name, email, active, type FROM employees WHERE id = ?'),
  insertEmployee: db.prepare('INSERT INTO employees (name, type, email, employee_code) VALUES (?, ?, ?, ?)'),
  updateEmployee: db.prepare('UPDATE employees SET name = ?, active = ?, type = ?, email = ?, employee_code = ? WHERE id = ?'),
  deleteEmployee: db.prepare('DELETE FROM employees WHERE id = ?'),
  employeeSplits: db.prepare('SELECT COUNT(*) AS n FROM allocations WHERE employee_id = ?'),

  customers: db.prepare(`
    SELECT c.*,
      (SELECT COUNT(*) FROM periods p WHERE p.customer_id = c.id) AS period_count,
      (SELECT COALESCE(SUM(amount), 0) FROM periods p WHERE p.customer_id = c.id) AS total_revenue
    FROM customers c ORDER BY c.name`),
  payByCustomerCurrency: db.prepare('SELECT customer_id, currency, SUM(pay) AS amount FROM payments GROUP BY customer_id, currency ORDER BY currency'),
  customerHasRevenue: db.prepare('SELECT EXISTS (SELECT 1 FROM periods WHERE customer_id = ? AND (revenue <> 0 OR COALESCE(amount, 0) <> 0)) AS has_revenue'),
  customer: db.prepare('SELECT * FROM customers WHERE id = ?'),
  insertCustomer: db.prepare('INSERT INTO customers (name, onboard_month, frequency, currency) VALUES (?, ?, ?, ?)'),
  updateCustomer: db.prepare('UPDATE customers SET name = ?, onboard_month = ?, frequency = ?, azdo_client = ?, currency = ? WHERE id = ?'),

  allShares: db.prepare('SELECT * FROM shares ORDER BY customer_id, from_month'),
  sharesFor: db.prepare('SELECT * FROM shares WHERE customer_id = ? ORDER BY from_month'),
  deleteSharesFor: db.prepare('DELETE FROM shares WHERE customer_id = ?'),
  insertShare: db.prepare(`
    INSERT INTO shares (customer_id, name, from_month, to_month, payment_month, direct_pct, support_pct, others_pct, payout_type, pay_from, pay_to)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  movePeriod: db.prepare('UPDATE periods SET start_month = ? WHERE id = ?'),
  customerHasData: db.prepare(`
    SELECT EXISTS (
      SELECT 1 FROM periods p WHERE p.customer_id = ?
        AND (p.revenue <> 0 OR EXISTS (SELECT 1 FROM allocations a WHERE a.period_id = p.id))
    ) AS has_data`),
  deletePeriodsFor: db.prepare('DELETE FROM periods WHERE customer_id = ?'),
  deleteCustomer: db.prepare('DELETE FROM customers WHERE id = ?'),

  periodsFor: db.prepare('SELECT * FROM periods WHERE customer_id = ? ORDER BY start_month'),
  period: db.prepare('SELECT * FROM periods WHERE id = ?'),
  insertPeriod: db.prepare('INSERT INTO periods (customer_id, start_month, revenue) VALUES (?, ?, ?)'),
  updatePeriod: db.prepare(`
    UPDATE periods SET revenue = ?, amount = ?, share_pct = ?, fx_rate = ?, pay_month = ?, payout_type = ?, pay_from = ?, pay_to = ?
    WHERE id = ?`),
  deletePeriod: db.prepare('DELETE FROM periods WHERE id = ?'),
  periodHasData: db.prepare(`
    SELECT p.revenue <> 0 OR EXISTS (SELECT 1 FROM allocations a WHERE a.period_id = p.id) AS has_data
    FROM periods p WHERE p.id = ?`),

  allocationsForCustomer: db.prepare(`
    SELECT a.id, a.period_id, a.part, a.category, a.employee_id, e.name AS employee, e.active, a.weightage,
      a.paid_on, a.paid_amount, a.paid_by
    FROM allocations a
    JOIN periods p ON p.id = a.period_id
    JOIN employees e ON e.id = a.employee_id
    WHERE p.customer_id = ? ORDER BY a.id`),
  // Paid rows are never replaced when a period is saved.
  // (Rows with a paid mark, or any monthly part paid, are never replaced.)
  clearAllocations: db.prepare(`
    DELETE FROM allocations WHERE period_id = ? AND paid_on IS NULL
      AND NOT EXISTS (SELECT 1 FROM part_paid pp WHERE pp.allocation_id = allocations.id)`),
  allocationsForPeriod: db.prepare(`
    SELECT a.*, e.name AS employee,
      (a.paid_on IS NOT NULL OR EXISTS (SELECT 1 FROM part_paid pp WHERE pp.allocation_id = a.id)) AS locked
    FROM allocations a JOIN employees e ON e.id = a.employee_id WHERE a.period_id = ?`),
  partsPaidForCustomer: db.prepare(`
    SELECT pp.* FROM part_paid pp JOIN allocations a ON a.id = pp.allocation_id JOIN periods p ON p.id = a.period_id
    WHERE p.customer_id = ?`),
  partsOf: db.prepare('SELECT * FROM part_paid WHERE allocation_id = ?'),
  markPart: db.prepare('INSERT INTO part_paid (allocation_id, seq, month, paid_on, paid_amount, paid_by) VALUES (?, ?, ?, ?, ?, ?)'),
  unmarkPart: db.prepare('DELETE FROM part_paid WHERE allocation_id = ? AND seq = ?'),
  // Contributors with a monthly part paid, with their pay and schedule as they work out now.
  partPaidForCustomer: db.prepare(`
    SELECT DISTINCT a.id, e.name AS employee, p.start_month, x.pay, x.part_from, x.parts
    FROM part_paid pp
    JOIN allocations a ON a.id = pp.allocation_id
    JOIN periods p ON p.id = a.period_id
    JOIN employees e ON e.id = a.employee_id
    LEFT JOIN payments x ON x.id = a.id
    WHERE p.customer_id = ?`),
  partRows: db.prepare(`
    SELECT * FROM pay_parts
    ORDER BY part_month, customer, CASE category WHEN 'Direct' THEN 1 WHEN 'Support' THEN 2 ELSE 3 END, id, part`),
  allocation: db.prepare(`
    SELECT a.*, e.name AS employee, p.customer_id, p.start_month, x.pay, x.parts, x.part_from, x.pay_month
    FROM allocations a
    JOIN periods p ON p.id = a.period_id
    JOIN employees e ON e.id = a.employee_id
    LEFT JOIN payments x ON x.id = a.id
    WHERE a.id = ?`),
  markPaid: db.prepare('UPDATE allocations SET paid_on = ?, paid_amount = ?, paid_by = ? WHERE id = ? AND paid_on IS NULL'),
  unmarkPaid: db.prepare('UPDATE allocations SET paid_on = NULL, paid_amount = NULL, paid_by = NULL WHERE id = ?'),
  // Paid rows of a customer with the pay as it works out now (NULL if no share covers them any more).
  paidForCustomer: db.prepare(`
    SELECT a.id, a.paid_amount, e.name AS employee, p.start_month, x.pay
    FROM allocations a
    JOIN periods p ON p.id = a.period_id
    JOIN employees e ON e.id = a.employee_id
    LEFT JOIN payments x ON x.id = a.id
    WHERE p.customer_id = ? AND a.paid_on IS NOT NULL`),
  insertAllocation: db.prepare(`
    INSERT INTO allocations (period_id, part, category, employee_id, weightage) VALUES (?, ?, ?, ?, ?)`),

  payments: db.prepare(`
    SELECT * FROM payments
    ORDER BY start_month, customer,
      CASE category WHEN 'Direct' THEN 1 WHEN 'Support' THEN 2 ELSE 3 END, id`),
  months: db.prepare('SELECT start_month FROM periods UNION SELECT part_month FROM pay_parts ORDER BY 1'),
  // Currencies pay is in: from contributors' pay, and from payments with revenue entered.
  currenciesUsed: db.prepare(`
    SELECT currency FROM payments
    UNION SELECT ${PAY_CURRENCY_SQL} FROM periods p JOIN customers c ON c.id = p.customer_id WHERE p.revenue <> 0`),
  // Pay is counted in the payment date month (one time) or in each monthly part's month (custom).
  payByEmployeeMonth: db.prepare(`
    SELECT employee_id, part_month AS start_month, SUM(part_amount) AS pay, SUM(part_paid) AS paid FROM pay_parts
    WHERE currency = ? GROUP BY employee_id, part_month`),
  payByEmployeeCustomerMonth: db.prepare(`
    SELECT employee_id, customer_id, customer, part_month AS start_month, SUM(part_amount) AS pay, SUM(part_paid) AS paid
    FROM pay_parts WHERE currency = ? GROUP BY employee_id, customer_id, part_month ORDER BY customer`),
  totals: db.prepare(`
    SELECT (SELECT COALESCE(SUM(p.revenue), 0) FROM periods p JOIN customers c ON c.id = p.customer_id
              WHERE ${PAY_CURRENCY_SQL} = ?1) AS revenue,
           (SELECT COALESCE(SUM(pay), 0) FROM payments WHERE currency = ?1) AS allocated,
           (SELECT COALESCE(SUM(part_paid), 0) FROM pay_parts WHERE currency = ?1) AS paid`),
};

// ---------- validation -------------------------------------------------------
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// An employee's work email: required, stored in lower case.
function parseEmployeeEmail(value) {
  const email = String(value ?? '').trim().toLowerCase();
  if (!email) throw new HttpError(400, 'Enter the employee\'s email address.');
  if (!EMAIL_RE.test(email)) throw new HttpError(400, `${email} doesn't look like an email address.`);
  return email;
}

// The company employee ID: required, letters, digits, - _ / and . only, stored in upper case.
function parseEmployeeCode(value) {
  const code = String(value ?? '').trim().toUpperCase();
  if (!code) throw new HttpError(400, 'Enter the employee ID.');
  if (code.length > 30 || !/^[A-Z0-9][A-Z0-9._/-]*$/.test(code)) {
    throw new HttpError(400, 'An employee ID can have letters, digits, - _ / and . only (up to 30 characters).');
  }
  return code;
}

function employeeUniqueError(err, name, email, code) {
  if (!isUniqueError(err)) return;
  if (/email/i.test(err.message)) throw new HttpError(409, `Another employee already uses ${email}.`);
  if (/employee_code/i.test(err.message)) throw new HttpError(409, `Another employee already has the ID ${code}.`);
  throw new HttpError(409, `${name} is already in the employee list.`);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthLabel = (ym) => `${MONTHS[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`;

function parseSplit(src, name) {
  const pcts = {
    direct: toNumber(src.direct_pct, `${name}: Direct %`),
    support: toNumber(src.support_pct, `${name}: Support %`),
    others: toNumber(src.others_pct, `${name}: Others %`),
  };
  for (const [k, v] of Object.entries(pcts)) {
    if (v < 0 || v > 1) throw new HttpError(400, `${name}: the ${k} share must be between 0% and 100%.`);
  }
  const sum = pcts.direct + pcts.support + pcts.others;
  if (Math.abs(sum - 1) > EPS) {
    throw new HttpError(400, `${name}: Direct, Support and Others must add up to 100%. They add up to ${+(sum * 100).toFixed(2)}%.`);
  }
  return pcts;
}

// Revenue shares. Each starts on its payment date (the month billing starts, which isn't the
// onboard month) and bills to a To month: every month for Monthly, once a year (from the payment
// date) for Yearly and Three Years. The first is always "Onboarding". A share's payment type is the
// default for its payments: one time, or custom with payout months (Payout From/To, for its first
// payment; later payments move along). The customer's periods are the payments inside its shares, so
// shares can't overlap.
function parseShares(list, onboard, frequency) {
  if (!Array.isArray(list) || list.length === 0) throw new HttpError(400, 'Add at least one revenue share.');
  const shares = list.map((s, i) => {
    const name = i === 0 ? 'Onboarding' : String(s.name ?? '').trim();
    if (!name) throw new HttpError(400, `Enter a name for revenue share ${i + 1}.`);
    const from = String(s.from_month ?? (i === 0 ? onboard : ''));
    if (!MONTH_RE.test(from)) throw new HttpError(400, `${name}: choose the payment date.`);
    if (from < onboard) throw new HttpError(400, `${name}'s payment date is before the onboard month (${monthLabel(onboard)}).`);
    const to = String(s.to_month ?? '');
    if (!MONTH_RE.test(to)) throw new HttpError(400, `${name}: choose the billing To month.`);
    if (to < from) throw new HttpError(400, `${name}: the billing To month is before the payment date.`);
    const custom = frequency !== 'Monthly' && s.payout_type === 'custom';
    let payFrom = null;
    let payTo = null;
    if (custom) {
      payFrom = s.pay_from ? String(s.pay_from) : from;
      payTo = s.pay_to ? String(s.pay_to) : addMonths(payFrom, 11);
      if (!MONTH_RE.test(payFrom) || !MONTH_RE.test(payTo)) throw new HttpError(400, `${name}: choose the payout From and To months.`);
      if (payTo < payFrom) throw new HttpError(400, `${name}: the payout To month is before its From month.`);
      if (monthsFrom(payFrom, payTo) > 120) throw new HttpError(400, `${name}: keep the payout to 120 months or fewer.`);
    }
    return { name, from_month: from, to_month: to, payment_month: null, ...parseSplit(s, name),
      payout_type: custom ? 'custom' : 'once', pay_from: payFrom, pay_to: payTo };
  }).sort((a, b) => a.from_month.localeCompare(b.from_month));

  for (let i = 1; i < shares.length; i++) {
    const a = shares[i - 1];
    const b = shares[i];
    if (a.to_month >= b.from_month) {
      throw new HttpError(400, `${a.name} (to ${monthLabel(a.to_month)}) overlaps ${b.name} (from ${monthLabel(b.from_month)}). Each month can only have one revenue share.`);
    }
  }
  const total = shares.reduce((n, s) => n + paymentMonths(s, frequency).length, 0);
  if (total > MAX_PERIODS) throw new HttpError(400, `These shares cover ${total} payments. Keep it to ${MAX_PERIODS} or fewer.`);
  return shares;
}

// The payments inside one share: every month for Monthly, one payment for Yearly.
// Three Years creates 3 yearly periods: Year 1 (from_month), Year 2 (+12 months), Year 3 (+24 months).
function paymentMonths(share, frequency) {
  if (frequency === 'Monthly') {
    const months = [];
    for (let m = share.from_month; m <= share.to_month; m = addMonths(m, 1)) months.push(m);
    return months;
  }
  // Yearly and Three Years: a payment every 12 months from the payment date while inside the share
  // (at least one). Shares saved before payment dates keep their payment_month as the first payment.
  const base = share.payment_month || share.from_month;
  const months = [base];
  for (let m = addMonths(base, 12); share.to_month && m <= share.to_month; m = addMonths(m, 12)) months.push(m);
  return months;
}

// Make a customer's periods match its shares. For Yearly and Three Years a share has one payment,
// so when its month changes the payment is moved (keeping its revenue and split): the payment
// already inside the share's months, or the one the same-named share had before (oldShares).
// Missing payments are added and empty ones no share wants are removed. A payment with revenue
// or a split is never removed: with strict it's an error, otherwise it's left alone.
function syncPeriods(customerId, shares, frequency, strict, oldShares = []) {
  const existing = q.periodsFor.all(customerId);
  const wanted = new Set(shares.flatMap((s) => paymentMonths(s, frequency)));
  if (frequency !== 'Monthly') {
    for (const s of shares) {
      const month = paymentMonths(s, frequency)[0];
      if (existing.some((p) => p.start_month === month)) continue;
      const before = oldShares.find((o) => o.name === s.name);
      const beforeMonth = before && (before.payment_month || before.from_month);
      const inside = existing.find((p) => !wanted.has(p.start_month)
        && ((p.start_month >= s.from_month && p.start_month <= s.to_month) || p.start_month === beforeMonth));
      if (inside) {
        q.movePeriod.run(month, inside.id);
        inside.start_month = month;
      }
    }
  }
  for (const p of existing) {
    if (wanted.has(p.start_month)) continue;
    if (!q.periodHasData.get(p.id).has_data) q.deletePeriod.run(p.id);
    else if (strict) {
      throw new HttpError(409, `The payment in ${monthLabel(p.start_month)} already has revenue or a split, so it has to stay inside a revenue share. Change the share months, or clear that payment first.`);
    }
  }
  const have = new Set(existing.map((p) => p.start_month));
  for (const m of [...wanted].sort()) if (!have.has(m)) q.insertPeriod.run(customerId, m, 0);
}

function saveShares(customerId, shares, frequency) {
  syncPeriods(customerId, shares, frequency, true, q.sharesFor.all(customerId));
  q.deleteSharesFor.run(customerId);
  for (const s of shares) {
    q.insertShare.run(customerId, s.name, s.from_month, s.to_month, s.payment_month, s.direct, s.support, s.others, s.payout_type, s.pay_from, s.pay_to);
  }
}

// Data saved by earlier versions: bring every customer's periods in line with its shares.
transaction(() => {
  for (const c of db.prepare('SELECT id, frequency FROM customers').all()) {
    syncPeriods(c.id, q.sharesFor.all(c.id), c.frequency, false);
  }
});

// The share whose months cover a period, or null.
const shareFor = (shares, month) =>
  shares.find((s) => month >= s.from_month && (s.to_month === null || month <= s.to_month)) || null;

function requireCustomer(id) {
  const c = q.customer.get(id);
  if (!c) throw new HttpError(404, 'Customer not found.');
  return c;
}

function parseCurrency(value) {
  const currency = String(value ?? 'INR').trim().toUpperCase();
  if (!CURRENCIES.includes(currency)) throw new HttpError(400, `Choose the currency: ${CURRENCIES.join(', ')}.`);
  return currency;
}

// [{ currency, amount }] per id, from a "GROUP BY id, currency" query.
function byCurrency(rows, key) {
  const out = new Map();
  for (const r of rows) {
    if (!out.has(r[key])) out.set(r[key], []);
    out.get(r[key]).push({ currency: r.currency, amount: r.amount });
  }
  return out;
}

function parseFrequency(value) {
  if (!Object.hasOwn(FREQUENCIES, value)) throw new HttpError(400, 'Choose Monthly, Yearly or Three Years payment.');
  return value;
}

function customerDetail(id) {
  const customer = requireCustomer(id);
  const shares = q.sharesFor.all(id);
  const allocations = q.allocationsForCustomer.all(id);
  const partMarks = q.partsPaidForCustomer.all(id);
  const periods = q.periodsFor.all(id).map((p) => {
    const share = shareFor(shares, p.start_month);
    const payout = payoutOf(p, share, customer.frequency);
    const pctFor = share
      ? { Direct: share.direct_pct, Support: share.support_pct, Others: share.others_pct }
      : { Direct: 0, Support: 0, Others: 0 };
    // A custom payment's rows each belong to one month (part) and get that month's part of the pool.
    const rows = allocations.filter((a) => a.period_id === p.id).map((a) => {
      const pay = monthPool(p.revenue, payout.parts, a.part) * pctFor[a.category] * a.weightage;
      const marks = partMarks.filter((m) => m.allocation_id === a.id);
      const month = a.part != null ? addMonths(payout.part_from, a.part - 1) : payout.pay_month;
      return { ...a, active: Boolean(a.active), pay, month, locked: Boolean(a.paid_on) || marks.length > 0 };
    });
    // Months the payment covers: the month itself for Monthly; for Yearly and Three Years the year
    // from its payment month (inside its share). start_month is when it's paid.
    const monthly = customer.frequency === 'Monthly';
    const cover_from = p.start_month;
    let end_month = monthly ? p.start_month : addMonths(p.start_month, 11);
    if (!monthly && share?.to_month && end_month > share.to_month) end_month = share.to_month;
    const currency = p.fx_rate != null && customer.currency !== 'INR' ? 'INR' : customer.currency;
    return { ...p, ...payout, currency, cover_from, end_month, share, allocations: rows, paid: rows.reduce((s, r) => s + r.pay, 0) };
  });
  return { ...customer, shares, periods };
}

// ---------- paid ----------------------------------------------------------------
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const round2 = (n) => Math.round(n * 100) / 100;

function parsePaidOn(value) {
  const day = String(value ?? '').trim();
  const date = new Date(`${day}T00:00:00Z`);
  if (!DATE_RE.test(day) || Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== day) {
    throw new HttpError(400, 'Choose the date it was paid.');
  }
  return day;
}

// Paid amounts never change: after changing a customer's shares or months, every paid row must
// still work out to the amount paid, in the same month, and contributors with monthly parts paid must
// keep the same pay and parts. Otherwise the change is refused (rolled back).
function paidSnapshot(customerId) {
  const snap = new Map(q.paidForCustomer.all(customerId).map((r) => [r.id, r.start_month]));
  for (const r of q.partPaidForCustomer.all(customerId)) snap.set(`p${r.id}`, `${r.start_month}|${round2(r.pay)}|${r.part_from}|${r.parts}`);
  return snap;
}
function assertPaidUnchanged(customerId, before) {
  for (const r of q.paidForCustomer.all(customerId)) {
    const moved = before.has(r.id) && before.get(r.id) !== r.start_month;
    if (moved || r.pay == null || Math.abs(round2(r.pay) - r.paid_amount) > 0.005) {
      throw new HttpError(409, `${r.employee}'s pay for ${r.start_month} is marked as paid, so this change would alter a paid amount. Undo the paid mark on that payment first.`);
    }
  }
  for (const r of q.partPaidForCustomer.all(customerId)) {
    const now = r.pay == null ? null : `${r.start_month}|${round2(r.pay)}|${r.part_from}|${r.parts}`;
    if (before.has(`p${r.id}`) && before.get(`p${r.id}`) !== now) {
      throw new HttpError(409, `${r.employee} has monthly parts marked as paid for ${r.start_month}, so this change would alter their pay. Undo those paid marks first.`);
    }
  }
}

// A payment's payout: its payment date (pay_month), one time or custom, and for custom the months
// its share is split over (pay_from to pay_to, 12 months from the payment date by default). Payments
// not saved with a type use their share's. Same rules as the payments view in db.js.
function payoutOf(p, share, frequency) {
  const payMonth = p.pay_month || p.start_month;
  const type = frequency !== 'Monthly' && (p.payout_type || share?.payout_type || 'once') === 'custom' ? 'custom' : 'once';
  if (type === 'once') return { pay_month: payMonth, payout_type: type, pay_from: null, pay_to: null, part_from: payMonth, parts: 1 };
  // The share's payout months are for its first payment; later payments move along by as many months.
  const k = share ? monthsFrom(share.payment_month || share.from_month, p.start_month) - 1 : 0;
  const shareFrom = share?.pay_from ? addMonths(share.pay_from, k) : null;
  const shareTo = share?.pay_to ? addMonths(share.pay_to, k) : null;
  const from = p.pay_from || shareFrom || payMonth;
  const to = p.pay_to || shareTo || addMonths(from, 11);
  return { pay_month: payMonth, payout_type: type, pay_from: from, pay_to: to, part_from: from, parts: Math.max(1, monthsFrom(from, to)) };
}
// The pool for one month of a custom payment: an equal part (to the paisa/cent), the last month
// taking the rounding; the whole pool for a row that isn't for one month (same as the payments view).
function monthPool(revenue, parts, part) {
  if (part == null || parts <= 1) return revenue;
  const each = round2(revenue / parts);
  return part >= parts ? revenue - each * (parts - 1) : each;
}
// Months from a to b, counting both.
function monthsFrom(a, b) {
  const [y1, m1] = a.split('-').map(Number);
  const [y2, m2] = b.split('-').map(Number);
  return (y2 - y1) * 12 + (m2 - m1) + 1;
}
// A contributor's pay split into n monthly parts from a month: even parts to the paisa/cent, the
// last taking the rounding (same as the pay_parts view).
function partsOf(pay, n, fromMonth) {
  const each = round2(pay / n);
  return Array.from({ length: n }, (_, k) => ({
    seq: k + 1, month: addMonths(fromMonth, k), amount: k === n - 1 ? round2(pay - each * (n - 1)) : each,
  }));
}
// Parts can't be paid before their month (a day of slack for India vs UTC).
const thisMonth = () => new Date(Date.now() + 86400000).toISOString().slice(0, 7);

// ---------- who can see what -------------------------------------------------
const employeeByEmail = db.prepare('SELECT id FROM employees WHERE email = ? COLLATE NOCASE');
export const isAdmin = (user) => user?.role === 'admin';
// The employee an Employee login belongs to (same email), or null.
export const myEmployeeId = (user) => (user?.email ? employeeByEmail.get(user.email)?.id ?? null : null);

// ---------- routes -----------------------------------------------------------
export function registerDataRoutes(router) {
  // Admins see and change everything. An Employee login only sees its own employee (matched by
  // email): its row on the Employees page, its pay on the Summary and its rows in All payments.
  const admin = { admin: true };

  // Employees
  router.get('/api/employees', ({ user }) => {
    const mine = isAdmin(user) ? null : myEmployeeId(user);
    const pay = byCurrency(q.payByEmployeeCurrency.all(), 'employee_id');
    return q.employees.all()
      .filter((e) => isAdmin(user) || e.id === mine)
      .map((e) => ({ ...e, active: Boolean(e.active), pay: pay.get(e.id) || [] }));
  });

  router.post('/api/employees', ({ body, setStatus }) => {
    const name = String(body.name ?? '').trim();
    if (!name) throw new HttpError(400, 'Enter the employee name.');
    const email = parseEmployeeEmail(body.email);
    const code = parseEmployeeCode(body.employee_code);
    const type = body.type || 'Product';
    if (!['Product', 'Support', 'Admin'].includes(type)) {
      throw new HttpError(400, 'Type must be Product, Support, or Admin.');
    }
    try {
      const { lastInsertRowid } = q.insertEmployee.run(name, type, email, code);
      setStatus(201);
      return { id: Number(lastInsertRowid), employee_code: code, name, email, active: true, type, split_count: 0, pay: [] };
    } catch (err) {
      employeeUniqueError(err, name, email, code);
      throw err;
    }
  }, admin);


  router.patch('/api/employees/:id', ({ params, body }) => {
    const current = q.employee.get(params.id);
    if (!current) throw new HttpError(404, 'Employee not found.');
    const name = body.name === undefined ? current.name : String(body.name).trim();
    if (!name) throw new HttpError(400, 'Enter the employee name.');
    const active = body.active === undefined ? current.active : (body.active ? 1 : 0);
    const type = body.type === undefined ? current.type : body.type;
    if (!['Product', 'Support', 'Admin'].includes(type)) {
      throw new HttpError(400, 'Type must be Product, Support, or Admin.');
    }
    const email = body.email === undefined ? current.email : parseEmployeeEmail(body.email);
    const code = body.employee_code === undefined ? current.employee_code : parseEmployeeCode(body.employee_code);
    try {
      q.updateEmployee.run(name, active, type, email, code, params.id);
    } catch (err) {
      employeeUniqueError(err, name, email, code);
      throw err;
    }
    return { id: params.id, employee_code: code, name, email, active: Boolean(active), type };
  }, admin);

  router.delete('/api/employees/:id', ({ params }) => {
    const current = q.employee.get(params.id);
    if (!current) throw new HttpError(404, 'Employee not found.');
    const { n } = q.employeeSplits.get(params.id);
    if (n > 0) {
      throw new HttpError(409, `${current.name} is part of ${n} payment split${n === 1 ? '' : 's'}, so their history can't be deleted. Mark them inactive instead.`);
    }
    q.deleteEmployee.run(params.id);
  }, admin);

  // Customers
  router.get('/api/customers', () => {
    const shares = q.allShares.all();
    const allocated = byCurrency(q.payByCustomerCurrency.all(), 'customer_id');
    return q.customers.all().map((c) => ({ ...c, shares: shares.filter((s) => s.customer_id === c.id), allocated: allocated.get(c.id) || [] }));
  }, admin);

  router.post('/api/customers', ({ body, setStatus }) => {
    const name = String(body.name ?? '').trim();
    const onboard = String(body.onboard_month ?? '');
    if (!name) throw new HttpError(400, 'Enter the customer name.');
    if (!MONTH_RE.test(onboard)) throw new HttpError(400, 'Choose the onboard month.');
    const frequency = parseFrequency(body.frequency);
    const currency = parseCurrency(body.currency);
    const shares = parseShares(body.shares, onboard, frequency);

    const id = transaction(() => {
      let customerId;
      try {
        customerId = Number(q.insertCustomer.run(name, onboard, frequency, currency).lastInsertRowid);
      } catch (err) {
        if (isUniqueError(err)) throw new HttpError(409, `A customer called ${name} already exists.`);
        throw err;
      }
      saveShares(customerId, shares, frequency);
      return customerId;
    });
    setStatus(201);
    return customerDetail(id);
  }, admin);

  router.get('/api/customers/:id', ({ params }) => customerDetail(params.id), admin);

  router.patch('/api/customers/:id', ({ params, body }) => {
    const current = requireCustomer(params.id);
    const name = body.name === undefined ? current.name : String(body.name).trim();
    if (!name) throw new HttpError(400, 'Enter the customer name.');
    const frequency = body.frequency === undefined ? current.frequency : parseFrequency(body.frequency);
    const onboard = body.onboard_month === undefined ? current.onboard_month : String(body.onboard_month);
    if (!MONTH_RE.test(onboard)) throw new HttpError(400, 'Choose the onboard month.');
    // The Onboarding share starts in the onboard month, so moving either needs the shares too.
    if ((frequency !== current.frequency || onboard !== current.onboard_month) && body.shares === undefined) {
      throw new HttpError(400, 'Send the revenue shares when changing the onboard month or payment frequency.');
    }
    const shares = body.shares === undefined ? null : parseShares(body.shares, onboard, frequency);
    // The customer's name(s) in the Azure DevOps "Client" field; empty means the customer name.
    const azdoClient = body.azdo_client === undefined ? current.azdo_client
      : String(body.azdo_client ?? '').split(',').map((n) => n.trim()).filter(Boolean).join(', ') || null;
    if (azdoClient && azdoClient.length > 200) throw new HttpError(400, 'Keep the Azure DevOps client name to 200 characters or fewer.');
    // Revenue already entered is in the old currency, so the currency only changes before that.
    const currency = body.currency === undefined ? current.currency : parseCurrency(body.currency);
    if (currency !== current.currency && q.customerHasRevenue.get(params.id).has_revenue) {
      throw new HttpError(409, `${current.name} already has revenue entered in ${current.currency}, so its currency can't change. Clear that revenue first, or add a new customer.`);
    }

    // Each frequency has a different period length (1, 12 or 36 months), so switching replaces the
    // periods. That's only allowed before any revenue or split is entered.
    const frequencyChanged = frequency !== current.frequency;
    if (frequencyChanged && q.customerHasData.get(params.id).has_data) {
      throw new HttpError(409, `${current.name} already has revenue or splits entered, so it can't switch between ${current.frequency} and ${frequency}. Clear them first, or add a new customer.`);
    }

    const paidBefore = paidSnapshot(params.id);
    transaction(() => {
      try {
        q.updateCustomer.run(name, onboard, frequency, azdoClient, currency, params.id);
      } catch (err) {
        if (isUniqueError(err)) throw new HttpError(409, `A customer called ${name} already exists.`);
        throw err;
      }
      if (frequencyChanged) q.deletePeriodsFor.run(params.id);
      if (shares) saveShares(params.id, shares, frequency);
      assertPaidUnchanged(params.id, paidBefore);
    });
    return customerDetail(params.id);
  }, admin);

  router.delete('/api/customers/:id', ({ params }) => {
    const customer = requireCustomer(params.id);
    if (paidSnapshot(params.id).size) {
      throw new HttpError(409, `${customer.name} has pay (or monthly parts) marked as paid, so it can't be deleted. Undo the paid marks first.`);
    }
    const { n: deployments } = db.prepare('SELECT COUNT(*) AS n FROM deployments WHERE customer_id = ?').get(params.id);
    if (deployments) {
      throw new HttpError(409, `${customer.name} has ${deployments} deployment${deployments === 1 ? '' : 's'} recorded, so it can't be deleted. Delete them on the Deployments page first.`);
    }
    q.deleteCustomer.run(params.id);
  }, admin);

  // Today's rate from a currency to INR (European Central Bank reference rate via frankfurter.dev,
  // no key needed), cached for an hour. Offered when a payment is converted to INR; it can still be
  // changed by hand. The ECB doesn't publish every currency (AED, for example).
  router.get('/api/exchange-rate', async ({ req }) => {
    const from = String(new URL(req.url, 'http://x').searchParams.get('from') || 'USD').toUpperCase();
    if (!CURRENCIES.includes(from) || from === 'INR') throw new HttpError(400, 'Choose a currency other than INR.');
    const cached = rateCache.get(from);
    if (cached && Date.now() - cached.fetchedAt < 60 * 60 * 1000) return cached.value;
    try {
      const res = await fetch(`https://api.frankfurter.dev/v1/latest?base=${from}&symbols=INR`, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const rate = Number(data?.rates?.INR);
      if (!Number.isFinite(rate) || rate <= 0) throw new Error('no INR rate');
      const value = { from, rate, date: data.date, source: 'European Central Bank (frankfurter.dev)' };
      rateCache.set(from, { fetchedAt: Date.now(), value });
      return value;
    } catch {
      throw new HttpError(502, `Couldn't get today's ${from} to INR rate. Type the rate in yourself.`);
    }
  }, admin);

  // Periods are created and removed by the customer's revenue shares (saveShares).
  // Save a period: revenue plus the full list of contributors (replaces the old list).
  router.put('/api/periods/:id', ({ params, body }) => {
    const period = q.period.get(params.id);
    if (!period) throw new HttpError(404, 'Period not found.');
    // Revenue is entered in the customer's currency; share_pct of it is the employees' pool. With
    // fx_rate (customers not in INR) the pool is converted to INR. Rounded to 2 decimals.
    const { currency } = requireCustomer(period.customer_id);
    const blank = body.amount == null || body.amount === '';
    const usd = {
      total: blank ? null : toNumber(body.amount, `Total revenue (${currency})`),
      pct: blank ? null : toNumber(body.share_pct, 'Share for employees'),
      rate: blank || currency === 'INR' || body.fx_rate == null || body.fx_rate === '' ? null : toNumber(body.fx_rate, `${currency} to INR rate`),
    };
    if (usd.total != null && usd.total < 0) throw new HttpError(400, 'Revenue cannot be negative.');
    if (usd.pct != null && (usd.pct < 0 || usd.pct > 1)) throw new HttpError(400, 'The share for employees must be between 0% and 100%.');
    if (usd.rate != null && usd.rate <= 0) throw new HttpError(400, `The ${currency} to INR rate must be more than 0.`);
    const revenue = blank ? 0 : Math.round(usd.total * usd.pct * (usd.rate ?? 1) * 100) / 100;
    const list = Array.isArray(body.allocations) ? body.allocations : [];
    // Payout: the payment date, and one time or custom (split into monthly parts from pay_from to pay_to).
    const payMonth = body.pay_month == null || body.pay_month === '' ? period.start_month : String(body.pay_month);
    if (!MONTH_RE.test(payMonth)) throw new HttpError(400, 'Choose the payment date (month).');
    const customer = requireCustomer(period.customer_id);
    const payoutType = customer.frequency !== 'Monthly' && body.payout_type === 'custom' ? 'custom' : 'once';
    let payFrom = null;
    let payTo = null;
    if (payoutType === 'custom') {
      payFrom = body.pay_from ? String(body.pay_from) : payMonth;
      payTo = body.pay_to ? String(body.pay_to) : addMonths(payFrom, 11);
      if (!MONTH_RE.test(payFrom) || !MONTH_RE.test(payTo)) throw new HttpError(400, 'Choose the From and To months for the custom payout.');
      if (payTo < payFrom) throw new HttpError(400, 'The custom payout\'s To month is before its From month.');
      if (monthsFrom(payFrom, payTo) > 120) throw new HttpError(400, 'Keep the custom payout to 120 months or fewer.');
    }
    // A custom payment over several months has contributors for each month (part 1 = the first month).
    const nParts = payoutType === 'custom' ? monthsFrom(payFrom, payTo) : 1;
    const partOf = (a) => (nParts > 1 ? Number(a.part) : null);
    const monthName = (part) => (part == null ? '' : `${monthLabel(addMonths(payFrom, part - 1))}: `);
    // Once anyone in this payment is marked paid, its revenue is locked and paid rows can't change.
    const paidRows = q.allocationsForPeriod.all(params.id).filter((a) => a.locked);
    if (paidRows.length) {
      const same = (x, y) => (x == null && y == null) || (x != null && y != null && Math.abs(x - y) < 1e-6);
      if (!same(revenue, period.revenue) || !same(usd.total, period.amount) || !same(usd.pct, period.share_pct) || !same(usd.rate, period.fx_rate)) {
        throw new HttpError(409, 'Someone in this payment is marked as paid, so its revenue is locked. Undo every paid mark to change it.');
      }
      const before = payoutOf(period, shareFor(q.sharesFor.all(period.customer_id), period.start_month), customer.frequency);
      if (before.pay_month !== payMonth || before.payout_type !== payoutType || before.pay_from !== payFrom || before.pay_to !== payTo) {
        throw new HttpError(409, 'Someone in this payment is marked as paid, so its payment date and payout are locked. Undo every paid mark to change them.');
      }
      for (const p of paidRows) {
        const sent = list.find((a) => a.category === p.category && Number(a.employee_id) === p.employee_id && partOf(a) === p.part);
        if (!sent || !same(Number(sent.weightage), p.weightage)) {
          throw new HttpError(409, `${p.employee}'s ${p.category} pay is marked as paid (or has monthly parts paid), so it can't be changed or removed. Undo the paid marks first.`);
        }
      }
    }

    const seen = new Set();
    const sums = new Map(); // 'part|category' -> total weightage
    const rows = list.map((a, i) => {
      const label = `Row ${i + 1}`;
      if (!CATEGORIES.includes(a.category)) throw new HttpError(400, `${label}: unknown category.`);
      const part = partOf(a);
      if (part != null && (!Number.isInteger(part) || part < 1 || part > nParts)) throw new HttpError(400, `${label}: choose a month of the payout.`);
      const employee = q.employee.get(Number(a.employee_id));
      if (!employee) throw new HttpError(400, `${monthName(part)}${a.category}: choose an employee for every row.`);
      const w = toNumber(a.weightage, `${a.category} weightage for ${employee.name}`);
      if (w < 0 || w > 1) throw new HttpError(400, `${monthName(part)}${employee.name}'s ${a.category} weightage must be between 0% and 100%.`);
      const key = `${part}|${a.category}|${employee.id}`;
      if (seen.has(key)) throw new HttpError(400, `${monthName(part)}${employee.name} is listed twice under ${a.category}.`);
      seen.add(key);
      sums.set(`${part}|${a.category}`, (sums.get(`${part}|${a.category}`) || 0) + w);
      return { part, category: a.category, employee_id: employee.id, weightage: w };
    });
    for (const [k, sum] of sums) {
      if (sum > 1 + 1e-4) {
        const [part, cat] = k.split('|');
        throw new HttpError(400, `${monthName(part === 'null' ? null : Number(part))}${cat} weightages add up to ${+(sum * 100).toFixed(2)}%. Reduce them to 100% or less.`);
      }
    }

    transaction(() => {
      q.updatePeriod.run(revenue, usd.total, usd.pct, usd.rate, payMonth, payoutType, payFrom, payTo, params.id);
      q.clearAllocations.run(params.id);
      for (const r of rows) {
        if (paidRows.some((p) => p.category === r.category && p.employee_id === r.employee_id && p.part === r.part)) continue;
        q.insertAllocation.run(params.id, r.part, r.category, r.employee_id, r.weightage);
      }
    });
    return customerDetail(period.customer_id);
  }, admin);

  // Mark one contributor's pay as paid on a date. The amount paid is the pay as it works out now.
  const monthOfRow = (a) => (a.part != null ? addMonths(a.part_from, a.part - 1) : null);
  const markOne = (a, paidOn, user) => {
    if (a.paid_on) return false;
    if (a.pay == null) throw new HttpError(400, `No revenue share covers ${a.start_month}, so ${a.employee}'s pay can't be marked as paid.`);
    const month = monthOfRow(a);
    if (month && month > thisMonth()) throw new HttpError(400, `${a.employee}'s pay for ${monthLabel(month)} can't be marked as paid before then.`);
    q.markPaid.run(paidOn, round2(a.pay), user?.email || null, a.id);
    return true;
  };

  router.post('/api/allocations/:id/paid', ({ params, body, user }) => {
    const a = q.allocation.get(params.id);
    if (!a) throw new HttpError(404, 'That contributor wasn\'t found. Reload the page.');
    if (a.paid_on) throw new HttpError(409, `${a.employee}'s pay is already marked as paid.`);
    if (a.part == null && (a.parts || 1) > 1) throw new HttpError(400, `${a.employee}'s pay is split into ${a.parts} monthly parts. Mark each month as paid.`);
    markOne(a, parsePaidOn(body.paid_on), user);
    return customerDetail(a.customer_id);
  }, admin);

  router.delete('/api/allocations/:id/paid', ({ params }) => {
    const a = q.allocation.get(params.id);
    if (!a) throw new HttpError(404, 'That contributor wasn\'t found. Reload the page.');
    q.unmarkPaid.run(a.id);
    return customerDetail(a.customer_id);
  }, admin);

  // Custom payout: mark one monthly part as paid (only once its month has arrived), or undo it.
  const markPart = (a, seq, paidOn, user) => {
    if (a.pay == null) throw new HttpError(400, `No revenue share covers ${a.start_month}, so ${a.employee}'s pay can't be marked as paid.`);
    const part = partsOf(a.pay, a.parts || 1, a.part_from).find((x) => x.seq === seq);
    if (!part) throw new HttpError(404, 'That month wasn\'t found. Reload the page.');
    if (part.month > thisMonth()) throw new HttpError(400, `${a.employee}'s part for ${monthLabel(part.month)} can't be marked as paid before then.`);
    if (q.partsOf.all(a.id).some((m) => m.seq === seq)) return false;
    q.markPart.run(a.id, seq, part.month, paidOn, part.amount, user?.email || null);
    return true;
  };
  router.post('/api/allocations/:id/parts/:seq/paid', ({ params, body, user }) => {
    const a = q.allocation.get(params.id);
    if (!a) throw new HttpError(404, 'That contributor wasn\'t found. Reload the page.');
    if (!markPart(a, Number(params.seq), parsePaidOn(body.paid_on), user)) throw new HttpError(409, 'That month is already marked as paid.');
    return customerDetail(a.customer_id);
  }, admin);
  router.delete('/api/allocations/:id/parts/:seq/paid', ({ params }) => {
    const a = q.allocation.get(params.id);
    if (!a) throw new HttpError(404, 'That contributor wasn\'t found. Reload the page.');
    q.unmarkPart.run(a.id, Number(params.seq));
    return customerDetail(a.customer_id);
  }, admin);

  // Mark everyone in a payment who isn't paid yet as paid on a date. With a custom payout: every
  // monthly part whose month has arrived and isn't paid yet.
  router.post('/api/periods/:id/paid', ({ params, body, user }) => {
    const period = q.period.get(params.id);
    if (!period) throw new HttpError(404, 'Period not found.');
    const paidOn = parsePaidOn(body.paid_on);
    let marked = 0;
    transaction(() => {
      for (const row of q.allocationsForPeriod.all(params.id)) {
        const a = q.allocation.get(row.id);
        if (a.part != null) {
          if (!a.paid_on && monthOfRow(a) <= thisMonth() && markOne(a, paidOn, user)) marked += 1;
        } else if ((a.parts || 1) > 1) {
          const paid = new Set(q.partsOf.all(a.id).map((m) => m.seq));
          for (const part of partsOf(a.pay ?? 0, a.parts, a.part_from)) {
            if (!paid.has(part.seq) && part.month <= thisMonth() && markPart(a, part.seq, paidOn, user)) marked += 1;
          }
        } else if (!a.paid_on && markOne(a, paidOn, user)) marked += 1;
      }
      if (!marked) throw new HttpError(400, 'Nothing to mark: everyone is paid, or the remaining months haven\'t arrived yet.');
    });
    return customerDetail(period.customer_id);
  }, admin);

  // Consolidated log: the "All Payments" sheet
  // One row per monthly part (one row for one-time pay): pay and paid are the part's, month is the
  // month it's for, total_pay is the contributor's whole pay for the payment.
  router.get('/api/payments', ({ user }) => {
    const mine = isAdmin(user) ? null : myEmployeeId(user);
    return q.partRows.all()
      .filter((r) => isAdmin(user) || r.employee_id === mine)
      .map(({ part_amount, part_paid, part_paid_on, ...r }) => ({
        ...r, allocation_id: r.id, id: `${r.id}-${r.part}`, month: r.part_month,
        total_pay: r.pay, pay: part_amount, paid: part_paid, paid_on: part_paid_on,
      }));
  });

  // The "Monthly Summary" sheet: pay per employee per month, plus yearly totals.
  // For an Employee login: only their own row and months, and no company-wide revenue figures.
  // Pay in different currencies is never added together: the summary is for one currency
  // (?currency=, INR by default), and lists the currencies there's pay in.
  router.get('/api/summary', ({ user, req }) => {
    const self = !isAdmin(user);
    const mine = self ? myEmployeeId(user) : null;
    const currencies = self
      ? [...new Set(q.payments.all().filter((r) => r.employee_id === mine).map((r) => r.currency))]
      : q.currenciesUsed.all().map((r) => r.currency);
    currencies.sort((a, b) => CURRENCIES.indexOf(a) - CURRENCIES.indexOf(b));
    const asked = String(new URL(req.url, 'http://x').searchParams.get('currency') || '').toUpperCase();
    const currency = currencies.includes(asked) ? asked : currencies.includes('INR') ? 'INR' : currencies[0] || 'INR';
    let pay = q.payByEmployeeMonth.all(currency);
    let customerPay = q.payByEmployeeCustomerMonth.all(currency);
    if (self) {
      pay = pay.filter((p) => p.employee_id === mine);
      customerPay = customerPay.filter((p) => p.employee_id === mine);
    }
    const months = self ? [...new Set(pay.map((p) => p.start_month))].sort() : q.months.all().map((r) => r.start_month);
    const years = [...new Set(months.map((m) => m.slice(0, 4)))];
    const employees = q.employees.all()
      .filter((e) => !self || e.id === mine)
      .map((e) => {
        // Allocated (pay worked out) and paid (marked as paid), by the month the pay is for.
        const byMonth = {};
        const byYear = {};
        const paidByMonth = {};
        const paidByYear = {};
        let paidTotal = 0;
        let total = 0;
        for (const r of pay.filter((p) => p.employee_id === e.id)) {
          total += r.pay;
          const y = r.start_month.slice(0, 4);
          byMonth[r.start_month] = (byMonth[r.start_month] || 0) + r.pay;
          byYear[y] = (byYear[y] || 0) + r.pay;
          paidByMonth[r.start_month] = (paidByMonth[r.start_month] || 0) + r.paid;
          paidByYear[y] = (paidByYear[y] || 0) + r.paid;
          paidTotal += r.paid;
        }
        // Drill-down: the same pay split up by customer.
        const customers = new Map();
        for (const r of customerPay.filter((p) => p.employee_id === e.id)) {
          if (!customers.has(r.customer_id)) {
            customers.set(r.customer_id, { id: r.customer_id, name: r.customer, byMonth: {}, byYear: {}, total: 0, paidByMonth: {}, paidByYear: {}, paidTotal: 0 });
          }
          const c = customers.get(r.customer_id);
          const y = r.start_month.slice(0, 4);
          c.byMonth[r.start_month] = (c.byMonth[r.start_month] || 0) + r.pay;
          c.byYear[y] = (c.byYear[y] || 0) + r.pay;
          c.total += r.pay;
          c.paidByMonth[r.start_month] = (c.paidByMonth[r.start_month] || 0) + r.paid;
          c.paidByYear[y] = (c.paidByYear[y] || 0) + r.paid;
          c.paidTotal += r.paid;
        }
        return {
          id: e.id, name: e.name, active: Boolean(e.active), byMonth, byYear, total, paidByMonth, paidByYear, paidTotal,
          customers: [...customers.values()],
        };
      })
      .filter((e) => self || e.active || e.total !== 0);
    const sumBy = (key, cols) => Object.fromEntries(cols.map((c) => [c, employees.reduce((s, e) => s + (e[key][c] || 0), 0)]));
    const monthTotals = sumBy('byMonth', months);
    const yearTotals = sumBy('byYear', years);
    const paidMonthTotals = sumBy('paidByMonth', months);
    const paidYearTotals = sumBy('paidByYear', years);
    if (self) {
      const message = mine ? null
        : 'Your login isn\'t linked to an employee yet. Ask an admin to add your email to your entry on the Employees page.';
      const allocated = employees.reduce((s, e) => s + e.total, 0);
      const paid = employees.reduce((s, e) => s + e.paidTotal, 0);
      return { self: true, message, currency, currencies, months, years, employees, monthTotals, yearTotals, paidMonthTotals, paidYearTotals, totals: { revenue: null, allocated, paid } };
    }
    const totals = q.totals.get(currency);
    return { self: false, currency, currencies, months, years, employees, monthTotals, yearTotals, paidMonthTotals, paidYearTotals, totals };
  });
}
