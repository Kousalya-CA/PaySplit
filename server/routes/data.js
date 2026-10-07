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
let rateCache = null; // { fetchedAt, value } for /api/exchange-rate

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
    SELECT e.id, e.name, e.email, e.active, e.type,
      (SELECT COUNT(*) FROM allocations a WHERE a.employee_id = e.id) AS split_count,
      (SELECT COALESCE(SUM(pay), 0) FROM payments p WHERE p.employee_id = e.id) AS total_pay
    FROM employees e ORDER BY e.active DESC, e.id`),
  employee: db.prepare('SELECT id, name, email, active, type FROM employees WHERE id = ?'),
  insertEmployee: db.prepare('INSERT INTO employees (name, type, email) VALUES (?, ?, ?)'),
  updateEmployee: db.prepare('UPDATE employees SET name = ?, active = ?, type = ?, email = ? WHERE id = ?'),
  deleteEmployee: db.prepare('DELETE FROM employees WHERE id = ?'),
  employeeSplits: db.prepare('SELECT COUNT(*) AS n FROM allocations WHERE employee_id = ?'),

  customers: db.prepare(`
    SELECT c.*,
      (SELECT COUNT(*) FROM periods p WHERE p.customer_id = c.id) AS period_count,
      (SELECT COALESCE(SUM(revenue), 0) FROM periods p WHERE p.customer_id = c.id) AS total_revenue,
      (SELECT COALESCE(SUM(pay), 0) FROM payments x WHERE x.customer_id = c.id) AS total_paid
    FROM customers c ORDER BY c.name`),
  customer: db.prepare('SELECT * FROM customers WHERE id = ?'),
  insertCustomer: db.prepare('INSERT INTO customers (name, onboard_month, frequency) VALUES (?, ?, ?)'),
  updateCustomer: db.prepare('UPDATE customers SET name = ?, onboard_month = ?, frequency = ? WHERE id = ?'),

  allShares: db.prepare('SELECT * FROM shares ORDER BY customer_id, from_month'),
  sharesFor: db.prepare('SELECT * FROM shares WHERE customer_id = ? ORDER BY from_month'),
  deleteSharesFor: db.prepare('DELETE FROM shares WHERE customer_id = ?'),
  insertShare: db.prepare(`
    INSERT INTO shares (customer_id, name, from_month, to_month, payment_month, direct_pct, support_pct, others_pct)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
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
  updatePeriod: db.prepare('UPDATE periods SET revenue = ?, total_usd = ?, usd_pct = ?, usd_inr_rate = ? WHERE id = ?'),
  deletePeriod: db.prepare('DELETE FROM periods WHERE id = ?'),
  periodHasData: db.prepare(`
    SELECT p.revenue <> 0 OR EXISTS (SELECT 1 FROM allocations a WHERE a.period_id = p.id) AS has_data
    FROM periods p WHERE p.id = ?`),

  allocationsForCustomer: db.prepare(`
    SELECT a.id, a.period_id, a.category, a.employee_id, e.name AS employee, e.active, a.weightage
    FROM allocations a
    JOIN periods p ON p.id = a.period_id
    JOIN employees e ON e.id = a.employee_id
    WHERE p.customer_id = ? ORDER BY a.id`),
  clearAllocations: db.prepare('DELETE FROM allocations WHERE period_id = ?'),
  insertAllocation: db.prepare(`
    INSERT INTO allocations (period_id, category, employee_id, weightage) VALUES (?, ?, ?, ?)`),

  payments: db.prepare(`
    SELECT * FROM payments
    ORDER BY start_month, customer,
      CASE category WHEN 'Direct' THEN 1 WHEN 'Support' THEN 2 ELSE 3 END, id`),
  months: db.prepare('SELECT DISTINCT start_month FROM periods ORDER BY start_month'),
  payByEmployeeMonth: db.prepare(`
    SELECT employee_id, start_month, SUM(pay) AS pay FROM payments GROUP BY employee_id, start_month`),
  payByEmployeeCustomerMonth: db.prepare(`
    SELECT employee_id, customer_id, customer, start_month, SUM(pay) AS pay
    FROM payments GROUP BY employee_id, customer_id, start_month ORDER BY customer`),
  totals: db.prepare(`
    SELECT (SELECT COALESCE(SUM(revenue), 0) FROM periods) AS revenue,
           (SELECT COALESCE(SUM(pay), 0) FROM payments) AS paid`),
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

function employeeUniqueError(err, name, email) {
  if (!isUniqueError(err)) return;
  if (/email/i.test(err.message)) throw new HttpError(409, `Another employee already uses ${email}.`);
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

// Revenue shares. The first is always "Onboarding" and starts in the onboard month: for Monthly
// it runs to a To month you choose; for Yearly and Three Years it covers the first 12 or 36 months
// and is paid once, in a payment month you choose inside them. Every share added after it
// (Renewal, ...) has From and To months. The customer's periods are the payments inside its
// shares, so shares can't overlap.
function parseShares(list, onboard, frequency) {
  if (!Array.isArray(list) || list.length === 0) throw new HttpError(400, 'Add at least one revenue share.');
  const oneTimeOnboarding = frequency !== 'Monthly';
  const shares = list.map((s, i) => {
    const name = i === 0 ? 'Onboarding' : String(s.name ?? '').trim();
    if (!name) throw new HttpError(400, `Enter a name for revenue share ${i + 1}.`);
    const from = i === 0 ? onboard : String(s.from_month ?? '');
    if (!MONTH_RE.test(from)) throw new HttpError(400, `${name}: choose the From month.`);
    if (from < onboard) throw new HttpError(400, `${name} starts before the onboard month (${monthLabel(onboard)}).`);
    let to;
    let payment = null;
    if (i === 0 && oneTimeOnboarding) {
      to = addMonths(from, FREQUENCIES[frequency].step - 1);
      payment = s.payment_month ? String(s.payment_month) : from;
      if (!MONTH_RE.test(payment) || payment < from || payment > to) {
        throw new HttpError(400, `Onboarding: choose a payment month from ${monthLabel(from)} to ${monthLabel(to)}.`);
      }
    } else {
      to = String(s.to_month ?? '');
      if (!MONTH_RE.test(to)) throw new HttpError(400, `${name}: choose the To month.`);
      if (to < from) throw new HttpError(400, `${name}: the To month is before the From month.`);
    }
    return { name, from_month: from, to_month: to, payment_month: payment, ...parseSplit(s, name) };
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

// The payments inside one share: every month for Monthly. A Yearly or Three Years share is one
// payment covering From to To, paid in its payment month (the From month unless one was chosen).
function paymentMonths(share, frequency) {
  if (frequency !== 'Monthly') return [share.payment_month || share.from_month];
  const months = [];
  for (let m = share.from_month; m <= share.to_month; m = addMonths(m, 1)) months.push(m);
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
    q.insertShare.run(customerId, s.name, s.from_month, s.to_month, s.payment_month, s.direct, s.support, s.others);
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

function parseFrequency(value) {
  if (!Object.hasOwn(FREQUENCIES, value)) throw new HttpError(400, 'Choose Monthly, Yearly or Three Years payment.');
  return value;
}

function customerDetail(id) {
  const customer = requireCustomer(id);
  const shares = q.sharesFor.all(id);
  const allocations = q.allocationsForCustomer.all(id);
  const periods = q.periodsFor.all(id).map((p) => {
    const share = shareFor(shares, p.start_month);
    const pctFor = share
      ? { Direct: share.direct_pct, Support: share.support_pct, Others: share.others_pct }
      : { Direct: 0, Support: 0, Others: 0 };
    const rows = allocations.filter((a) => a.period_id === p.id)
      .map((a) => ({ ...a, active: Boolean(a.active), pay: p.revenue * pctFor[a.category] * a.weightage }));
    // Months the payment covers: the month itself for Monthly; for Yearly and Three Years its
    // share's From to To (12 or 36 months if no share covers it). start_month is when it's paid.
    const monthly = customer.frequency === 'Monthly';
    const cover_from = !monthly && share ? share.from_month : p.start_month;
    const end_month = monthly ? p.start_month
      : share ? share.to_month : addMonths(p.start_month, FREQUENCIES[customer.frequency].step - 1);
    return { ...p, cover_from, end_month, share, allocations: rows, paid: rows.reduce((s, r) => s + r.pay, 0) };
  });
  return { ...customer, shares, periods };
}

// ---------- routes -----------------------------------------------------------
export function registerDataRoutes(router) {
  // Employees
  router.get('/api/employees', () =>
    q.employees.all().map((e) => ({ ...e, active: Boolean(e.active) })));

  router.post('/api/employees', ({ body, setStatus }) => {
    const name = String(body.name ?? '').trim();
    if (!name) throw new HttpError(400, 'Enter the employee name.');
    const email = parseEmployeeEmail(body.email);
    const type = body.type || 'Product';
    if (!['Product', 'Support', 'Admin'].includes(type)) {
      throw new HttpError(400, 'Type must be Product, Support, or Admin.');
    }
    try {
      const { lastInsertRowid } = q.insertEmployee.run(name, type, email);
      setStatus(201);
      return { id: Number(lastInsertRowid), name, email, active: true, type, split_count: 0, total_pay: 0 };
    } catch (err) {
      employeeUniqueError(err, name, email);
      throw err;
    }
  });


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
    try {
      q.updateEmployee.run(name, active, type, email, params.id);
    } catch (err) {
      employeeUniqueError(err, name, email);
      throw err;
    }
    return { id: params.id, name, email, active: Boolean(active), type };
  });

  router.delete('/api/employees/:id', ({ params }) => {
    const current = q.employee.get(params.id);
    if (!current) throw new HttpError(404, 'Employee not found.');
    const { n } = q.employeeSplits.get(params.id);
    if (n > 0) {
      throw new HttpError(409, `${current.name} is part of ${n} payment split${n === 1 ? '' : 's'}, so their history can't be deleted. Mark them inactive instead.`);
    }
    q.deleteEmployee.run(params.id);
  });

  // Customers
  router.get('/api/customers', () => {
    const shares = q.allShares.all();
    return q.customers.all().map((c) => ({ ...c, shares: shares.filter((s) => s.customer_id === c.id) }));
  });

  router.post('/api/customers', ({ body, setStatus }) => {
    const name = String(body.name ?? '').trim();
    const onboard = String(body.onboard_month ?? '');
    if (!name) throw new HttpError(400, 'Enter the customer name.');
    if (!MONTH_RE.test(onboard)) throw new HttpError(400, 'Choose the onboard month.');
    const frequency = parseFrequency(body.frequency);
    const shares = parseShares(body.shares, onboard, frequency);

    const id = transaction(() => {
      let customerId;
      try {
        customerId = Number(q.insertCustomer.run(name, onboard, frequency).lastInsertRowid);
      } catch (err) {
        if (isUniqueError(err)) throw new HttpError(409, `A customer called ${name} already exists.`);
        throw err;
      }
      saveShares(customerId, shares, frequency);
      return customerId;
    });
    setStatus(201);
    return customerDetail(id);
  });

  router.get('/api/customers/:id', ({ params }) => customerDetail(params.id));

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

    // Each frequency has a different period length (1, 12 or 36 months), so switching replaces the
    // periods. That's only allowed before any revenue or split is entered.
    const frequencyChanged = frequency !== current.frequency;
    if (frequencyChanged && q.customerHasData.get(params.id).has_data) {
      throw new HttpError(409, `${current.name} already has revenue or splits entered, so it can't switch between ${current.frequency} and ${frequency}. Clear them first, or add a new customer.`);
    }

    transaction(() => {
      try {
        q.updateCustomer.run(name, onboard, frequency, params.id);
      } catch (err) {
        if (isUniqueError(err)) throw new HttpError(409, `A customer called ${name} already exists.`);
        throw err;
      }
      if (frequencyChanged) q.deletePeriodsFor.run(params.id);
      if (shares) saveShares(params.id, shares, frequency);
    });
    return customerDetail(params.id);
  });

  router.delete('/api/customers/:id', ({ params }) => {
    requireCustomer(params.id);
    q.deleteCustomer.run(params.id);
  });

  // Today's USD to INR rate (European Central Bank reference rate via frankfurter.dev, no key
  // needed), cached for an hour. The period editor fills it in; it can still be changed by hand.
  router.get('/api/exchange-rate', async () => {
    if (rateCache && Date.now() - rateCache.fetchedAt < 60 * 60 * 1000) return rateCache.value;
    try {
      const res = await fetch('https://api.frankfurter.dev/v1/latest?base=USD&symbols=INR', { signal: AbortSignal.timeout(8000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const rate = Number(data?.rates?.INR);
      if (!Number.isFinite(rate) || rate <= 0) throw new Error('no INR rate');
      rateCache = { fetchedAt: Date.now(), value: { rate, date: data.date, source: 'European Central Bank (frankfurter.dev)' } };
      return rateCache.value;
    } catch {
      throw new HttpError(502, "Couldn't get today's USD to INR rate. Type the rate in yourself.");
    }
  });

  // Periods are created and removed by the customer's revenue shares (saveShares).
  // Save a period: revenue plus the full list of contributors (replaces the old list).
  router.put('/api/periods/:id', ({ params, body }) => {
    const period = q.period.get(params.id);
    if (!period) throw new HttpError(404, 'Period not found.');
    // Revenue is either typed in ₹, or worked out from a US dollar total:
    // Total revenue ($) x % x USD to INR rate, rounded to paise.
    let revenue;
    let usd = { total: null, pct: null, rate: null };
    if (body.total_usd != null && body.total_usd !== '') {
      usd = {
        total: toNumber(body.total_usd, 'Total revenue ($)'),
        pct: toNumber(body.usd_pct, 'Percentage of total revenue'),
        rate: toNumber(body.usd_inr_rate, 'USD to INR rate'),
      };
      if (usd.total < 0) throw new HttpError(400, 'Total revenue ($) cannot be negative.');
      if (usd.pct < 0 || usd.pct > 1) throw new HttpError(400, 'The percentage of total revenue must be between 0% and 100%.');
      if (usd.rate <= 0) throw new HttpError(400, 'The USD to INR rate must be more than 0.');
      revenue = Math.round(usd.total * usd.pct * usd.rate * 100) / 100;
    } else {
      revenue = toNumber(body.revenue, 'Revenue');
      if (revenue < 0) throw new HttpError(400, 'Revenue cannot be negative.');
    }
    const list = Array.isArray(body.allocations) ? body.allocations : [];

    const seen = new Set();
    const sums = { Direct: 0, Support: 0, Others: 0 };
    const rows = list.map((a, i) => {
      const label = `Row ${i + 1}`;
      if (!CATEGORIES.includes(a.category)) throw new HttpError(400, `${label}: unknown category.`);
      const employee = q.employee.get(Number(a.employee_id));
      if (!employee) throw new HttpError(400, `${a.category}: choose an employee for every row.`);
      const w = toNumber(a.weightage, `${a.category} weightage for ${employee.name}`);
      if (w < 0 || w > 1) throw new HttpError(400, `${employee.name}'s ${a.category} weightage must be between 0% and 100%.`);
      const key = `${a.category}|${employee.id}`;
      if (seen.has(key)) throw new HttpError(400, `${employee.name} is listed twice under ${a.category}.`);
      seen.add(key);
      sums[a.category] += w;
      return { category: a.category, employee_id: employee.id, weightage: w };
    });
    for (const [cat, sum] of Object.entries(sums)) {
      if (sum > 1 + 1e-4) {
        throw new HttpError(400, `${cat} weightages add up to ${+(sum * 100).toFixed(2)}%. Reduce them to 100% or less.`);
      }
    }

    transaction(() => {
      q.updatePeriod.run(revenue, usd.total, usd.pct, usd.rate, params.id);
      q.clearAllocations.run(params.id);
      for (const r of rows) q.insertAllocation.run(params.id, r.category, r.employee_id, r.weightage);
    });
    return customerDetail(period.customer_id);
  });

  // Consolidated log: the "All Payments" sheet
  router.get('/api/payments', () => q.payments.all());

  // The "Monthly Summary" sheet: pay per employee per month, plus yearly totals
  router.get('/api/summary', () => {
    const months = q.months.all().map((r) => r.start_month);
    const years = [...new Set(months.map((m) => m.slice(0, 4)))];
    const pay = q.payByEmployeeMonth.all();
    const customerPay = q.payByEmployeeCustomerMonth.all();
    const employees = q.employees.all()
      .map((e) => {
        const byMonth = {};
        const byYear = {};
        for (const r of pay.filter((p) => p.employee_id === e.id)) {
          byMonth[r.start_month] = (byMonth[r.start_month] || 0) + r.pay;
          const y = r.start_month.slice(0, 4);
          byYear[y] = (byYear[y] || 0) + r.pay;
        }
        // Drill-down: the same pay split up by customer.
        const customers = new Map();
        for (const r of customerPay.filter((p) => p.employee_id === e.id)) {
          if (!customers.has(r.customer_id)) {
            customers.set(r.customer_id, { id: r.customer_id, name: r.customer, byMonth: {}, byYear: {}, total: 0 });
          }
          const c = customers.get(r.customer_id);
          const y = r.start_month.slice(0, 4);
          c.byMonth[r.start_month] = (c.byMonth[r.start_month] || 0) + r.pay;
          c.byYear[y] = (c.byYear[y] || 0) + r.pay;
          c.total += r.pay;
        }
        return {
          id: e.id, name: e.name, active: Boolean(e.active), byMonth, byYear, total: e.total_pay,
          customers: [...customers.values()],
        };
      })
      .filter((e) => e.active || e.total !== 0);
    const monthTotals = Object.fromEntries(months.map((m) => [m, employees.reduce((s, e) => s + (e.byMonth[m] || 0), 0)]));
    const yearTotals = Object.fromEntries(years.map((y) => [y, employees.reduce((s, e) => s + (e.byYear[y] || 0), 0)]));
    const totals = q.totals.get();
    return { months, years, employees, monthTotals, yearTotals, totals };
  });
}
