// Employees, customers, periods, contributor splits, payments and summaries.
import { db, transaction } from '../db.js';
import { HttpError } from '../http.js';

export const CATEGORIES = ['Direct', 'Support', 'Others'];
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const EPS = 1e-6;

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
    SELECT e.id, e.name, e.active,
      (SELECT COUNT(*) FROM allocations a WHERE a.employee_id = e.id) AS split_count,
      (SELECT COALESCE(SUM(pay), 0) FROM payments p WHERE p.employee_id = e.id) AS total_pay
    FROM employees e ORDER BY e.active DESC, e.id`),
  employee: db.prepare('SELECT id, name, active FROM employees WHERE id = ?'),
  insertEmployee: db.prepare('INSERT INTO employees (name) VALUES (?)'),
  updateEmployee: db.prepare('UPDATE employees SET name = ?, active = ? WHERE id = ?'),
  deleteEmployee: db.prepare('DELETE FROM employees WHERE id = ?'),
  employeeSplits: db.prepare('SELECT COUNT(*) AS n FROM allocations WHERE employee_id = ?'),

  customers: db.prepare(`
    SELECT c.*,
      (SELECT COUNT(*) FROM periods p WHERE p.customer_id = c.id) AS period_count,
      (SELECT COALESCE(SUM(revenue), 0) FROM periods p WHERE p.customer_id = c.id) AS total_revenue,
      (SELECT COALESCE(SUM(pay), 0) FROM payments x WHERE x.customer_id = c.id) AS total_paid
    FROM customers c ORDER BY c.name`),
  customer: db.prepare('SELECT * FROM customers WHERE id = ?'),
  insertCustomer: db.prepare(`
    INSERT INTO customers (name, onboard_month, frequency, direct_pct, support_pct, others_pct)
    VALUES (?, ?, ?, ?, ?, ?)`),
  updateCustomer: db.prepare(`
    UPDATE customers SET name = ?, direct_pct = ?, support_pct = ?, others_pct = ? WHERE id = ?`),
  deleteCustomer: db.prepare('DELETE FROM customers WHERE id = ?'),

  periodsFor: db.prepare('SELECT * FROM periods WHERE customer_id = ? ORDER BY start_month'),
  period: db.prepare('SELECT * FROM periods WHERE id = ?'),
  lastPeriod: db.prepare('SELECT start_month FROM periods WHERE customer_id = ? ORDER BY start_month DESC LIMIT 1'),
  insertPeriod: db.prepare('INSERT INTO periods (customer_id, start_month, revenue) VALUES (?, ?, ?)'),
  updatePeriod: db.prepare('UPDATE periods SET revenue = ? WHERE id = ?'),
  deletePeriod: db.prepare('DELETE FROM periods WHERE id = ?'),

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
  totals: db.prepare(`
    SELECT (SELECT COALESCE(SUM(revenue), 0) FROM periods) AS revenue,
           (SELECT COALESCE(SUM(pay), 0) FROM payments) AS paid`),
};

// ---------- validation -------------------------------------------------------
function parseSplit(body) {
  const pcts = {
    direct: toNumber(body.direct_pct, 'Direct %'),
    support: toNumber(body.support_pct, 'Support %'),
    others: toNumber(body.others_pct, 'Others %'),
  };
  for (const [k, v] of Object.entries(pcts)) {
    if (v < 0 || v > 1) throw new HttpError(400, `The ${k} share must be between 0% and 100%.`);
  }
  const sum = pcts.direct + pcts.support + pcts.others;
  if (Math.abs(sum - 1) > EPS) {
    throw new HttpError(400, `Direct, Support and Others must add up to 100%. They add up to ${+(sum * 100).toFixed(2)}%.`);
  }
  return pcts;
}

function requireCustomer(id) {
  const c = q.customer.get(id);
  if (!c) throw new HttpError(404, 'Customer not found.');
  return c;
}

function customerDetail(id) {
  const customer = requireCustomer(id);
  const pctFor = { Direct: customer.direct_pct, Support: customer.support_pct, Others: customer.others_pct };
  const allocations = q.allocationsForCustomer.all(id);
  const periods = q.periodsFor.all(id).map((p) => {
    const rows = allocations.filter((a) => a.period_id === p.id)
      .map((a) => ({ ...a, active: Boolean(a.active), pay: p.revenue * pctFor[a.category] * a.weightage }));
    return { ...p, allocations: rows, paid: rows.reduce((s, r) => s + r.pay, 0) };
  });
  return { ...customer, periods };
}

// ---------- routes -----------------------------------------------------------
export function registerDataRoutes(router) {
  // Employees
  router.get('/api/employees', () =>
    q.employees.all().map((e) => ({ ...e, active: Boolean(e.active) })));

  router.post('/api/employees', ({ body, setStatus }) => {
    const name = String(body.name ?? '').trim();
    if (!name) throw new HttpError(400, 'Enter the employee name.');
    try {
      const { lastInsertRowid } = q.insertEmployee.run(name);
      setStatus(201);
      return { id: Number(lastInsertRowid), name, active: true, split_count: 0, total_pay: 0 };
    } catch (err) {
      if (isUniqueError(err)) throw new HttpError(409, `${name} is already in the employee list.`);
      throw err;
    }
  });


  router.patch('/api/employees/:id', ({ params, body }) => {
    const current = q.employee.get(params.id);
    if (!current) throw new HttpError(404, 'Employee not found.');
    const name = body.name === undefined ? current.name : String(body.name).trim();
    if (!name) throw new HttpError(400, 'Enter the employee name.');
    const active = body.active === undefined ? current.active : (body.active ? 1 : 0);
    try {
      q.updateEmployee.run(name, active, params.id);
    } catch (err) {
      if (isUniqueError(err)) throw new HttpError(409, `${name} is already in the employee list.`);
      throw err;
    }
    return { id: params.id, name, active: Boolean(active) };
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
  router.get('/api/customers', () => q.customers.all());

  router.post('/api/customers', ({ body, setStatus }) => {
    const name = String(body.name ?? '').trim();
    const onboard = String(body.onboard_month ?? '');
    const frequency = body.frequency;
    if (!name) throw new HttpError(400, 'Enter the customer name.');
    if (!MONTH_RE.test(onboard)) throw new HttpError(400, 'Choose the onboard month.');
    if (!['Yearly', 'Monthly'].includes(frequency)) throw new HttpError(400, 'Choose Yearly or Monthly payment.');
    const split = parseSplit(body);

    const id = transaction(() => {
      let customerId;
      try {
        customerId = Number(q.insertCustomer.run(name, onboard, frequency, split.direct, split.support, split.others).lastInsertRowid);
      } catch (err) {
        if (isUniqueError(err)) throw new HttpError(409, `A customer called ${name} already exists.`);
        throw err;
      }
      // Same as the workbook: 1 block for yearly customers, 12 monthly blocks for monthly ones.
      const count = frequency === 'Yearly' ? 1 : 12;
      for (let i = 0; i < count; i++) q.insertPeriod.run(customerId, addMonths(onboard, i), 0);
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
    const split = body.direct_pct === undefined
      ? { direct: current.direct_pct, support: current.support_pct, others: current.others_pct }
      : parseSplit(body);
    try {
      q.updateCustomer.run(name, split.direct, split.support, split.others, params.id);
    } catch (err) {
      if (isUniqueError(err)) throw new HttpError(409, `A customer called ${name} already exists.`);
      throw err;
    }
    return customerDetail(params.id);
  });

  router.delete('/api/customers/:id', ({ params }) => {
    requireCustomer(params.id);
    q.deleteCustomer.run(params.id);
  });

  // Periods
  router.post('/api/customers/:id/periods', ({ params, setStatus }) => {
    const customer = requireCustomer(params.id);
    const last = q.lastPeriod.get(params.id)?.start_month;
    const next = last ? addMonths(last, customer.frequency === 'Yearly' ? 12 : 1) : customer.onboard_month;
    q.insertPeriod.run(params.id, next, 0);
    setStatus(201);
    return customerDetail(params.id);
  });

  // Save a period: revenue plus the full list of contributors (replaces the old list).
  router.put('/api/periods/:id', ({ params, body }) => {
    const period = q.period.get(params.id);
    if (!period) throw new HttpError(404, 'Period not found.');
    const revenue = toNumber(body.revenue, 'Revenue');
    if (revenue < 0) throw new HttpError(400, 'Revenue cannot be negative.');
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
      q.updatePeriod.run(revenue, params.id);
      q.clearAllocations.run(params.id);
      for (const r of rows) q.insertAllocation.run(params.id, r.category, r.employee_id, r.weightage);
    });
    return customerDetail(period.customer_id);
  });

  router.delete('/api/periods/:id', ({ params }) => {
    const period = q.period.get(params.id);
    if (!period) throw new HttpError(404, 'Period not found.');
    q.deletePeriod.run(params.id);
    return customerDetail(period.customer_id);
  });

  // Consolidated log: the "All Payments" sheet
  router.get('/api/payments', () => q.payments.all());

  // The "Monthly Summary" sheet: pay per employee per month, plus yearly totals
  router.get('/api/summary', () => {
    const months = q.months.all().map((r) => r.start_month);
    const years = [...new Set(months.map((m) => m.slice(0, 4)))];
    const pay = q.payByEmployeeMonth.all();
    const employees = q.employees.all()
      .map((e) => {
        const byMonth = {};
        const byYear = {};
        for (const r of pay.filter((p) => p.employee_id === e.id)) {
          byMonth[r.start_month] = (byMonth[r.start_month] || 0) + r.pay;
          const y = r.start_month.slice(0, 4);
          byYear[y] = (byYear[y] || 0) + r.pay;
        }
        return { id: e.id, name: e.name, active: Boolean(e.active), byMonth, byYear, total: e.total_pay };
      })
      .filter((e) => e.active || e.total !== 0);
    const monthTotals = Object.fromEntries(months.map((m) => [m, employees.reduce((s, e) => s + (e.byMonth[m] || 0), 0)]));
    const yearTotals = Object.fromEntries(years.map((y) => [y, employees.reduce((s, e) => s + (e.byYear[y] || 0), 0)]));
    const totals = q.totals.get();
    return { months, years, employees, monthTotals, yearTotals, totals };
  });
}
