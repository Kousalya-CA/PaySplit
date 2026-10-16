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
  -- start month, and the customer's periods are the payments inside its shares: every month for
  -- Monthly, one payment per share for Yearly and Three Years (the Onboarding share there is the
  -- first 12 or 36 months). Percentages are fractions (0.7 = 70%).
  CREATE TABLE IF NOT EXISTS shares (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    from_month  TEXT NOT NULL,                    -- 'YYYY-MM'
    to_month    TEXT,                             -- 'YYYY-MM' (NULL only in old data, filled in below)
    payment_month TEXT,                           -- Yearly / Three Years onboarding: month it's paid
    direct_pct  REAL NOT NULL,
    support_pct REAL NOT NULL,
    others_pct  REAL NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_shares_customer ON shares(customer_id);

  -- One row per billing period (Three Years creates 3 yearly periods, Yearly creates 1 yearly period, Monthly creates monthly periods)
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

  -- Azure DevOps sprint board settings. The PAT is never stored here: it comes from AZ_PAT.
  CREATE TABLE IF NOT EXISTS azdo_settings (
    key   TEXT PRIMARY KEY,                       -- 'org' or 'project'
    value TEXT NOT NULL
  );
  -- Area paths to read tasks from, each with its sprints (iteration paths, about a month each).
  -- Sprint name and dates are copied from Azure DevOps when the sprint is added or refreshed.
  CREATE TABLE IF NOT EXISTS azdo_areas (
    id   INTEGER PRIMARY KEY AUTOINCREMENT,
    path TEXT NOT NULL UNIQUE COLLATE NOCASE,     -- e.g. 'Trisul.Org\\Agentic - Billing and Data Platform'
    name TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS azdo_iterations (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    area_id     INTEGER NOT NULL REFERENCES azdo_areas(id) ON DELETE CASCADE,
    path        TEXT NOT NULL COLLATE NOCASE,     -- e.g. 'Trisul.Org\\Sprint 3'
    name        TEXT NOT NULL,
    start_date  TEXT,                             -- 'YYYY-MM-DD', or NULL if not set in Azure DevOps
    finish_date TEXT,
    UNIQUE (area_id, path)
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

// Three Years customers get three 12-month periods: Year 1, Year 2 (+12 months), Year 3 (+24 months).
// Each year has its own revenue and contributor split, just like a Yearly customer's period.

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

// Yearly / Three Years onboarding is paid once, in a month chosen inside the share
// (payment_month). NULL means the From month.
const shareColumns = new Set(db.prepare('PRAGMA table_info(shares)').all().map((c) => c.name));
if (!shareColumns.has('payment_month')) db.exec('ALTER TABLE shares ADD COLUMN payment_month TEXT');

// A short name for an Azure DevOps area path, shown in the task table instead of the long path.
const areaColumns = new Set(db.prepare('PRAGMA table_info(azdo_areas)').all().map((c) => c.name));
if (!areaColumns.has('display_name')) db.exec('ALTER TABLE azdo_areas ADD COLUMN display_name TEXT');

// How a customer is written in the Azure DevOps "Client" field (comma-separated if more than one).
// NULL means the customer's name.
if (!new Set(db.prepare('PRAGMA table_info(customers)').all().map((c) => c.name)).has('azdo_client')) {
  db.exec('ALTER TABLE customers ADD COLUMN azdo_client TEXT');
}

// A payment's revenue is entered in the customer's currency (amount); share_pct of it goes to the
// employees (10% by default). fx_rate converts that to INR when the admin chooses to; NULL keeps pay
// in the customer's currency. revenue is the employees' pool, in the pay currency:
//   revenue = amount x share_pct x (fx_rate or 1)
// These columns used to be total_usd, usd_pct and usd_inr_rate (a US dollar calculator).
const periodColumns = new Set(db.prepare('PRAGMA table_info(periods)').all().map((c) => c.name));
for (const [from, to] of [['total_usd', 'amount'], ['usd_pct', 'share_pct'], ['usd_inr_rate', 'fx_rate']]) {
  if (periodColumns.has(from) && !periodColumns.has(to)) db.exec(`ALTER TABLE periods RENAME COLUMN ${from} TO ${to}`);
  else if (!periodColumns.has(to)) db.exec(`ALTER TABLE periods ADD COLUMN ${to} REAL`);
}

// Each customer has a currency. Before currencies existed, customers whose payments used the US
// dollar calculator become USD (those payments stay converted to INR at their saved rate); the rest
// stay INR. A payment where the ₹ revenue was typed becomes amount = revenue at 100%, so every
// pay amount stays the same. (In a USD customer such a payment keeps a rate of 1, i.e. stays ₹.)
if (!new Set(db.prepare('PRAGMA table_info(customers)').all().map((c) => c.name)).has('currency')) {
  db.exec(`
    ALTER TABLE customers ADD COLUMN currency TEXT NOT NULL DEFAULT 'INR';
    UPDATE customers SET currency = 'USD'
      WHERE EXISTS (SELECT 1 FROM periods p WHERE p.customer_id = customers.id AND p.amount IS NOT NULL);
    UPDATE periods SET amount = revenue, share_pct = 1,
      fx_rate = CASE (SELECT currency FROM customers c WHERE c.id = periods.customer_id) WHEN 'INR' THEN NULL ELSE 1 END
      WHERE amount IS NULL AND revenue <> 0;
  `);
}

// Every share now has a To month (the customer's periods are the payments inside its shares).
// Shares saved as ongoing end at the last period they already cover, or after 12 months.
db.exec(`
  UPDATE shares SET to_month = COALESCE(
    (SELECT MAX(p.start_month) FROM periods p
      WHERE p.customer_id = shares.customer_id AND p.start_month >= shares.from_month),
    substr(date(from_month || '-01', '+11 months'), 1, 7))
  WHERE to_month IS NULL;
`);

// Yearly and Three Years onboarding shares used to be saved as just the onboard month. They're
// the one-time payment for the first 12 or 36 months, so store those months, stopping before the
// next share if one starts sooner.
db.exec(`
  UPDATE shares SET to_month = MIN(
    substr(date(from_month || '-01',
      CASE (SELECT frequency FROM customers c WHERE c.id = shares.customer_id)
        WHEN 'Three Years' THEN '+35 months' ELSE '+11 months' END), 1, 7),
    COALESCE(
      (SELECT substr(date(MIN(s2.from_month) || '-01', '-1 months'), 1, 7) FROM shares s2
        WHERE s2.customer_id = shares.customer_id AND s2.from_month > shares.from_month),
      '9999-12'))
  WHERE to_month = from_month
    AND from_month = (SELECT onboard_month FROM customers c WHERE c.id = shares.customer_id)
    AND (SELECT frequency FROM customers c WHERE c.id = shares.customer_id) <> 'Monthly';
`);

// Marking a contributor's pay as paid: the date it was paid, the amount paid (the pay at that
// moment, kept as it was) and who marked it. All NULL while unpaid.
const allocationColumns = new Set(db.prepare('PRAGMA table_info(allocations)').all().map((c) => c.name));
for (const [col, type] of [['paid_on', 'TEXT'], ['paid_amount', 'REAL'], ['paid_by', 'TEXT']]) {
  if (!allocationColumns.has(col)) db.exec(`ALTER TABLE allocations ADD COLUMN ${col} ${type}`);
}

// How a payment's employees' share is paid out. pay_month is the payment date (the month it's paid;
// NULL = the payment's own month). payout_type 'once' pays it all in pay_month; 'custom' splits it
// into equal monthly parts from pay_from to pay_to (NULL = pay_month and 12 months on). A share's
// payout_type is the default for its payments that haven't been saved with one. Payments that
// already had an amount or contributors are one time, so nothing moves. part_paid holds paid marks on the parts.
{
  const periodCols = new Set(db.prepare('PRAGMA table_info(periods)').all().map((c) => c.name));
  if (!periodCols.has('payout_type')) {
    db.exec(`
      ALTER TABLE periods ADD COLUMN pay_month TEXT;
      ALTER TABLE periods ADD COLUMN payout_type TEXT;
      ALTER TABLE periods ADD COLUMN pay_from TEXT;
      ALTER TABLE periods ADD COLUMN pay_to TEXT;
      UPDATE periods SET payout_type = 'once'
        WHERE revenue <> 0 OR amount IS NOT NULL OR EXISTS (SELECT 1 FROM allocations a WHERE a.period_id = periods.id);
    `);
  }
  const shareCols = new Set(db.prepare('PRAGMA table_info(shares)').all().map((c) => c.name));
  if (!shareCols.has('payout_type')) db.exec('ALTER TABLE shares ADD COLUMN payout_type TEXT');
  db.exec(`
    CREATE TABLE IF NOT EXISTS part_paid (
      allocation_id INTEGER NOT NULL REFERENCES allocations(id) ON DELETE CASCADE,
      seq           INTEGER NOT NULL,                -- 1 = first monthly part
      month         TEXT NOT NULL,                   -- 'YYYY-MM' the part is for
      paid_on       TEXT NOT NULL,
      paid_amount   REAL NOT NULL,
      paid_by       TEXT,
      PRIMARY KEY (allocation_id, seq)
    );
  `);
}

db.exec(`
  -- Pay is never stored: it is always Revenue x Category % x Weightage %
  -- (the same formula as the Excel workbook), using the share that covers the period.
  -- Allocations in a period with no share are left out (pay 0).
  -- paid is the amount marked as paid (0 while unpaid). Rebuilt on every start so new columns appear.
  DROP VIEW IF EXISTS payments;
  CREATE VIEW payments AS
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
                      ELSE s.others_pct END AS pay,
    a.paid_on      AS paid_on,
    CASE WHEN a.paid_on IS NULL THEN 0 ELSE a.paid_amount END AS paid,
    p.amount       AS amount,
    p.share_pct    AS share_pct,
    p.fx_rate      AS fx_rate,
    c.currency     AS customer_currency,
    -- payout: the payment date, and the months its share is paid in (one part for one time)
    COALESCE(p.pay_month, p.start_month) AS pay_month,
    CASE WHEN COALESCE(p.payout_type, s.payout_type, 'once') = 'custom' THEN 'custom' ELSE 'once' END AS payout_type,
    CASE WHEN COALESCE(p.payout_type, s.payout_type, 'once') = 'custom'
         THEN COALESCE(p.pay_from, p.pay_month, p.start_month) ELSE COALESCE(p.pay_month, p.start_month) END AS part_from,
    CASE WHEN COALESCE(p.payout_type, s.payout_type, 'once') <> 'custom' THEN 1
         WHEN p.pay_to IS NULL THEN 12
         ELSE MAX(1, (CAST(substr(p.pay_to, 1, 4) AS INTEGER) * 12 + CAST(substr(p.pay_to, 6, 2) AS INTEGER)) - (CAST(substr(COALESCE(p.pay_from, p.pay_month, p.start_month), 1, 4) AS INTEGER) * 12 + CAST(substr(COALESCE(p.pay_from, p.pay_month, p.start_month), 6, 2) AS INTEGER)) + 1) END AS parts,
    -- pay, paid and revenue (the employees' pool) are in this currency
    CASE WHEN p.fx_rate IS NOT NULL AND c.currency <> 'INR' THEN 'INR' ELSE c.currency END AS currency
  FROM allocations a
  JOIN periods   p ON p.id = a.period_id
  JOIN customers c ON c.id = p.customer_id
  JOIN employees e ON e.id = a.employee_id
  JOIN shares    s ON s.customer_id = c.id AND p.start_month >= s.from_month
                  AND (s.to_month IS NULL OR p.start_month <= s.to_month);

  -- One row per monthly part of each contributor's pay (one row for one time). Each part is pay split
  -- evenly, the last taking the rounding; part_month is the month it's for.
  DROP VIEW IF EXISTS pay_parts;
  CREATE VIEW pay_parts AS
  WITH RECURSIVE seq(n) AS (SELECT 0 UNION ALL SELECT n + 1 FROM seq WHERE n < 119)
  SELECT x.*, seq.n + 1 AS part,
    substr(date(x.part_from || '-01', '+' || seq.n || ' months'), 1, 7) AS part_month,
    CASE WHEN x.parts = 1 THEN x.pay
         WHEN seq.n = x.parts - 1 THEN x.pay - ROUND(x.pay / x.parts, 2) * (x.parts - 1)
         ELSE ROUND(x.pay / x.parts, 2) END AS part_amount,
    CASE WHEN x.parts = 1 THEN x.paid_on ELSE pp.paid_on END AS part_paid_on,
    CASE WHEN x.parts = 1 THEN x.paid ELSE COALESCE(pp.paid_amount, 0) END AS part_paid
  FROM payments x JOIN seq ON seq.n < x.parts
  LEFT JOIN part_paid pp ON pp.allocation_id = x.id AND pp.seq = seq.n + 1;
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
// Work email, used to match people on the Azure DevOps sprint board. Empty for employees added
// before it existed; no two employees can share one.
addEmployeeColumn('email', 'TEXT');
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_employees_email ON employees(email COLLATE NOCASE) WHERE email IS NOT NULL');
// Company employee ID (for example CA1023). Empty for employees added before it existed; unique.
addEmployeeColumn('employee_code', 'TEXT');
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_employees_code ON employees(employee_code COLLATE NOCASE) WHERE employee_code IS NOT NULL');

// What's deployed at each customer. Anyone signed in can add one. services is a JSON array of
// { name, version } (each service has its own version). features is no longer used (see
// customer_features) and stays '[]' for new deployments.
// Names are stored as text, so removing a choice from the lists keeps old deployments as they were.
db.exec(`
  CREATE TABLE IF NOT EXISTS deployments (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER NOT NULL REFERENCES customers(id),
    product     TEXT NOT NULL,
    environment TEXT NOT NULL,
    deployed_on TEXT NOT NULL,                    -- 'YYYY-MM-DD'
    services    TEXT NOT NULL DEFAULT '[]',
    features    TEXT NOT NULL DEFAULT '[]',
    notes       TEXT,
    created_by_id INTEGER,
    created_by  TEXT NOT NULL,                    -- name of the user who entered it
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_by  TEXT,
    updated_at  TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_deployments_customer ON deployments(customer_id);

  -- The choices offered for a deployment's product, services, features and environment.
  CREATE TABLE IF NOT EXISTS deployment_options (
    id   INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL CHECK (kind IN ('product', 'service', 'feature', 'environment')),
    name TEXT NOT NULL COLLATE NOCASE,
    UNIQUE (kind, name)
  );
`);
// Features enabled belong to the customer, not to a deployment. Customers whose deployments were
// entered with features (before this table) get those features once.
db.exec(`
  CREATE TABLE IF NOT EXISTS customer_features (
    customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    name        TEXT NOT NULL COLLATE NOCASE,
    added_by    TEXT,
    added_at    TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (customer_id, name)
  );
`);
if (db.prepare("SELECT 1 FROM deployments WHERE features <> '[]' LIMIT 1").get()) {
  db.exec(`
    INSERT OR IGNORE INTO customer_features (customer_id, name, added_by, added_at)
    SELECT d.customer_id, f.value, d.created_by, d.created_at FROM deployments d, json_each(d.features) f
    ORDER BY d.deployed_on, d.id;
    UPDATE deployments SET features = '[]';
  `);
}
if (!db.prepare('SELECT 1 FROM deployment_options LIMIT 1').get()) {
  const addOption = db.prepare('INSERT INTO deployment_options (kind, name) VALUES (?, ?)');
  const defaults = {
    product: ['Hybr'],
    service: ['Hybr', 'vConnect', 'Billing', 'CC'],
    feature: ['Billing CSP', 'Billing vConnect', 'vCenter', 'SPF', 'Service Catalog'],
    environment: ['Production', 'UAT', 'Dev'],
  };
  for (const [kind, names] of Object.entries(defaults)) for (const name of names) addOption.run(kind, name);
}

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
