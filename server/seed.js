// Loads the sample data from "Employee_Contribution_Split.xlsx" so the app
// starts with the same employees, customers and splits as the workbook.
// Run with: npm run seed   (only runs when there are no customers yet)
import { db, transaction } from './db.js';
import { addMonths, FREQUENCIES } from './routes/data.js';

const EMPLOYEES = ['Soundarya', 'Aswin', 'Akash', 'Roja', 'Vijaisri', 'Divya', 'Giri',
  'Kousalya', 'Keerthivasan', 'Kamesh', 'Rahul', 'Hari', 'Sanjay', 'Gokul'];

const CUSTOMERS = [
  {
    name: 'Ces Africa', onboard: '2026-09', frequency: 'Yearly', split: [0.7, 0.2, 0.1],
    periods: [{
      revenue: 117000,
      Direct: [['Soundarya', 0.5], ['Aswin', 0.2], ['Akash', 0.3]],
      Support: [['Roja', 0.2], ['Vijaisri', 0.2], ['Divya', 0.1], ['Giri', 0.2], ['Kousalya', 0.3]],
      Others: ['Keerthivasan', 'Kamesh', 'Rahul', 'Hari', 'Sanjay', 'Gokul'].map((n) => [n, 1 / 7]),
    }],
  },
  {
    name: 'Axians Phase 2', onboard: '2026-10', frequency: 'Monthly', split: [0.7, 0.2, 0.1],
    periods: [{
      revenue: 10000,
      Direct: [['Rahul', 0.4], ['Kamesh', 0.5], ['Akash', 0.1]],
      Support: [['Divya', 0.1], ['Giri', 0.05], ['Kousalya', 0.3], ['Hari', 0.3], ['Sanjay', 0.25]],
      Others: ['Soundarya', 'Aswin', 'Keerthivasan', 'Vijaisri', 'Roja', 'Gokul'].map((n) => [n, 1 / 6]),
    }],
  },
];

const { n } = db.prepare('SELECT COUNT(*) AS n FROM customers').get();
if (n > 0) {
  console.log('Customers already exist, so sample data was not added.');
  process.exit(0);
}

transaction(() => {
  const addEmp = db.prepare('INSERT OR IGNORE INTO employees (name, type) VALUES (?, ?)');
  EMPLOYEES.forEach((name) => addEmp.run(name, 'Product'));
  const empId = (name) => db.prepare('SELECT id FROM employees WHERE name = ?').get(name).id;

  for (const c of CUSTOMERS) {
    const customerId = Number(db.prepare('INSERT INTO customers (name, onboard_month, frequency) VALUES (?, ?, ?)')
      .run(c.name, c.onboard, c.frequency).lastInsertRowid);
    const { step } = FREQUENCIES[c.frequency];
    // One "Onboarding" share: 12 months for Monthly, the one-time payment for Yearly.
    const count = c.frequency === 'Monthly' ? 12 : 1;
    db.prepare(`
      INSERT INTO shares (customer_id, name, from_month, to_month, direct_pct, support_pct, others_pct)
      VALUES (?, 'Onboarding', ?, ?, ?, ?, ?)`)
      .run(customerId, c.onboard, addMonths(c.onboard, (count - 1) * step), ...c.split);
    for (let i = 0; i < count; i++) {
      const data = c.periods[i] || { revenue: 0 };
      const periodId = Number(db.prepare('INSERT INTO periods (customer_id, start_month, revenue) VALUES (?, ?, ?)')
        .run(customerId, addMonths(c.onboard, i * step), data.revenue).lastInsertRowid);
      for (const cat of ['Direct', 'Support', 'Others']) {
        for (const [name, w] of data[cat] || []) {
          db.prepare('INSERT INTO allocations (period_id, category, employee_id, weightage) VALUES (?, ?, ?, ?)')
            .run(periodId, cat, empId(name), w);
        }
      }
    }
  }
});
console.log(`Added ${EMPLOYEES.length} employees and ${CUSTOMERS.length} customers from the workbook.`);
