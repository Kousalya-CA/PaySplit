// SQLite via Node's built-in module (no npm package needed).
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// On Azure App Service (Linux) the app folder is replaced on every deploy, so keep the
// database under /home, which persists. Override with DB_PATH.
const onAzureLinux = Boolean(process.env.WEBSITE_SITE_NAME) && process.platform === 'linux';
const dbPath = process.env.DB_PATH || (onAzureLinux ? '/home/data/paysplit.db' : join(root, 'data', 'paysplit.db'));
mkdirSync(dirname(dbPath), { recursive: true });

export const db = new DatabaseSync(dbPath);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  -- Login accounts
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT NOT NULL,
    email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL
  );

  -- Employees who can receive a share of customer revenue
  CREATE TABLE IF NOT EXISTS employees (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL UNIQUE COLLATE NOCASE,
    active     INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Customers: onboard month and billing frequency. The Direct/Support/Others split is in shares.
  CREATE TABLE IF NOT EXISTS customers (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT NOT NULL UNIQUE COLLATE NOCASE,
    onboard_month TEXT NOT NULL,                  -- 'YYYY-MM'
    frequency     TEXT NOT NULL CHECK (frequency IN ('Monthly', 'Yearly', 'Three Years')),
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Revenue shares: the Direct/Support/Others split for a range of months. The first one is
  -- "Onboarding"; more can be added (e.g. "Renewal"). A period uses the share covering its
  -- start month. to_month NULL means ongoing. For Yearly and Three Years the Onboarding share is
  -- the one-time onboarding payment (from_month = to_month). Percentages are fractions (0.7 = 70%).
  CREATE TABLE IF NOT EXISTS shares (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    from_month  TEXT NOT NULL,                    -- 'YYYY-MM'
    to_month    TEXT,                             -- 'YYYY-MM', or NULL for ongoing
    direct_pct  REAL NOT NULL,
    support_pct REAL NOT NULL,
    others_pct  REAL NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_shares_customer ON shares(customer_id);

  -- One row per billing period (36 months for Three Years, a year for Yearly, a month for Monthly)
  CREATE TABLE IF NOT EXISTS periods (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    start_month TEXT NOT NULL,                    -- 'YYYY-MM'
    revenue     REAL NOT NULL DEFAULT 0,
    UNIQUE (customer_id, start_month)
  );

  -- Who gets credit in a period, in which category, and with what weightage
  CREATE TABLE IF NOT EXISTS allocations (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    period_id   INTEGER NOT NULL REFERENCES periods(id) ON DELETE CASCADE,
    category    TEXT NOT NULL CHECK (category IN ('Direct', 'Support', 'Others')),
    employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
    weightage   REAL NOT NULL CHECK (weightage >= 0 AND weightage <= 1),
    UNIQUE (period_id, category, employee_id)
  );

  CREATE INDEX IF NOT EXISTS idx_periods_customer ON periods(customer_id);
  CREATE INDEX IF NOT EXISTS idx_alloc_period ON allocations(period_id);
  CREATE INDEX IF NOT EXISTS idx_alloc_employee ON allocations(employee_id);
`);

// Databases created before "Three Years" existed have the old frequency CHECK. SQLite can't
// alter a CHECK, so rebuild the customers table. Foreign keys are off during the swap so the
// periods (ON DELETE CASCADE) survive, and the view is dropped and recreated below.
const customersSql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'customers'").get().sql;
if (!customersSql.includes('Three Years')) {
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    transaction(() => db.exec(`
      DROP VIEW IF EXISTS payments;
      CREATE TABLE customers_new (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        name          TEXT NOT NULL UNIQUE COLLATE NOCASE,
        onboard_month TEXT NOT NULL,                  -- 'YYYY-MM'
        frequency     TEXT NOT NULL CHECK (frequency IN ('Monthly', 'Yearly', 'Three Years')),
        direct_pct    REAL NOT NULL,
        support_pct   REAL NOT NULL,
        others_pct    REAL NOT NULL,
        created_at    TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO customers_new SELECT id, name, onboard_month, frequency, direct_pct, support_pct, others_pct, created_at
        FROM customers;
      DROP TABLE customers;
      ALTER TABLE customers_new RENAME TO customers;
    `));
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

// Three Years customers used to get three 12-month periods; now they get one 36-month period.
// Remove the old empty Year 2 / Year 3 periods (any that start between the 36-month steps).
// Periods with revenue or a split are kept so no entered pay is lost.
db.exec(`
  DELETE FROM periods
  WHERE customer_id IN (SELECT id FROM customers WHERE frequency = 'Three Years')
    AND ((CAST(substr(start_month, 1, 4) AS INTEGER) * 12 + CAST(substr(start_month, 6, 2) AS INTEGER))
       - (SELECT CAST(substr(onboard_month, 1, 4) AS INTEGER) * 12 + CAST(substr(onboard_month, 6, 2) AS INTEGER)
          FROM customers c WHERE c.id = periods.customer_id)) % 36 <> 0
    AND revenue = 0
    AND NOT EXISTS (SELECT 1 FROM allocations a WHERE a.period_id = periods.id);
`);

// Customers used to hold one Direct/Support/Others split. Move it into shares so nothing's pay
// changes: Monthly customers get one ongoing "Onboarding" share; Yearly and Three Years customers
// get one share per existing payment ("Onboarding" for the first, "Renewal" after that).
const customerColumns = new Set(db.prepare('PRAGMA table_info(customers)').all().map((c) => c.name));
if (customerColumns.has('direct_pct')) {
  transaction(() => db.exec(`
    DROP VIEW IF EXISTS payments;
    INSERT INTO shares (customer_id, name, from_month, to_month, direct_pct, support_pct, others_pct)
      SELECT id, 'Onboarding', onboard_month, NULL, direct_pct, support_pct, others_pct
      FROM customers WHERE frequency = 'Monthly';
    INSERT INTO shares (customer_id, name, from_month, to_month, direct_pct, support_pct, others_pct)
      SELECT c.id, CASE WHEN p.start_month = c.onboard_month THEN 'Onboarding' ELSE 'Renewal' END,
             p.start_month, p.start_month, c.direct_pct, c.support_pct, c.others_pct
      FROM customers c JOIN periods p ON p.customer_id = c.id
      WHERE c.frequency <> 'Monthly';
    INSERT INTO shares (customer_id, name, from_month, to_month, direct_pct, support_pct, others_pct)
      SELECT id, 'Onboarding', onboard_month, onboard_month, direct_pct, support_pct, others_pct
      FROM customers c WHERE NOT EXISTS (SELECT 1 FROM shares s WHERE s.customer_id = c.id);
    ALTER TABLE customers DROP COLUMN direct_pct;
    ALTER TABLE customers DROP COLUMN support_pct;
    ALTER TABLE customers DROP COLUMN others_pct;
  `));
}

db.exec(`
  -- Pay is never stored: it is always Revenue x Category % x Weightage %
  -- (the same formula as the Excel workbook), using the share that covers the period.
  -- Allocations in a period with no share are left out (pay 0).
  CREATE VIEW IF NOT EXISTS payments AS
  SELECT
    a.id           AS id,
    c.id           AS customer_id,
    c.name         AS customer,
    c.frequency    AS frequency,
    p.id           AS period_id,
    p.start_month  AS start_month,
    a.category     AS category,
    e.id           AS employee_id,
    e.name         AS employee,
    s.name         AS share,
    p.revenue      AS revenue,
    CASE a.category WHEN 'Direct' THEN s.direct_pct
                    WHEN 'Support' THEN s.support_pct
                    ELSE s.others_pct END AS category_pct,
    a.weightage    AS weightage,
    p.revenue * a.weightage *
      CASE a.category WHEN 'Direct' THEN s.direct_pct
                      WHEN 'Support' THEN s.support_pct
                      ELSE s.others_pct END AS pay
  FROM allocations a
  JOIN periods   p ON p.id = a.period_id
  JOIN customers c ON c.id = p.customer_id
  JOIN employees e ON e.id = a.employee_id
  JOIN shares    s ON s.customer_id = c.id AND p.start_month >= s.from_month
                  AND (s.to_month IS NULL OR p.start_month <= s.to_month);
`);

// Users added before roles existed get the new columns. Invited users have an empty
// password_hash until they open their setup link and choose a password.
const userColumns = new Set(db.prepare('PRAGMA table_info(users)').all().map((c) => c.name));
const addUserColumn = (name, definition) => {
  if (!userColumns.has(name)) db.exec(`ALTER TABLE users ADD COLUMN ${name} ${definition}`);
};
addUserColumn('role', "TEXT NOT NULL DEFAULT 'employee' CHECK (role IN ('admin', 'employee'))");
addUserColumn('is_owner', 'INTEGER NOT NULL DEFAULT 0');
addUserColumn('invite_token_hash', 'TEXT');
addUserColumn('invite_expires_at', 'TEXT');
addUserColumn('last_login_at', 'TEXT');

// Employees added before types existed get the new type column. Default to 'Product' for existing employees.
const employeeColumns = new Set(db.prepare('PRAGMA table_info(employees)').all().map((c) => c.name));
const addEmployeeColumn = (name, definition) => {
  if (!employeeColumns.has(name)) db.exec(`ALTER TABLE employees ADD COLUMN ${name} ${definition}`);
};
addEmployeeColumn('type', "TEXT NOT NULL DEFAULT 'Product' CHECK (type IN ('Product', 'Support', 'Admin'))");

// The owner is the permanent admin: OWNER_EMAIL if set, otherwise the first account created.
if (!db.prepare('SELECT 1 FROM users WHERE is_owner = 1').get()) {
  const owner = (process.env.OWNER_EMAIL && db.prepare('SELECT id FROM users WHERE email = ?').get(process.env.OWNER_EMAIL))
    || db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get();
  if (owner) db.prepare("UPDATE users SET is_owner = 1, role = 'admin' WHERE id = ?").run(owner.id);
}

// Run several statements as one all-or-nothing change.
export function transaction(fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
