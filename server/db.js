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

// Before a table is rebuilt, drop every view (including any left by another version of the app):
// SQLite won't replace a table that a view still points at. The views are recreated further down.
function dropAllViews() {
  for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type = 'view'").all()) {
    db.exec(`DROP VIEW IF EXISTS "${name.replace(/"/g, '""')}"`);
  }
}

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
  dropAllViews();
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
  // A share's custom payout months (for its first payment; later payments move along by the same
  // number of months). NULL = from each payment's month for 12 months.
  if (!shareCols.has('pay_from')) db.exec('ALTER TABLE shares ADD COLUMN pay_from TEXT; ALTER TABLE shares ADD COLUMN pay_to TEXT;');
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

// Custom payments (Yearly and Three Years): each month of the payout has its own contributors and
// weightages, so a contributor row (allocation) can belong to one month: part 1 is the first payout
// month. NULL = the whole payment (one time, and every Monthly payment). The table is rebuilt once to
// add the column, because the "one row per contributor and category" rule has to include it.
if (!db.prepare('PRAGMA table_info(allocations)').all().some((c) => c.name === 'part')) {
  dropAllViews();
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.exec(`
      BEGIN;
      DROP VIEW IF EXISTS pay_parts;
      DROP VIEW IF EXISTS payments;
      CREATE TABLE allocations_new (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        period_id   INTEGER NOT NULL REFERENCES periods(id) ON DELETE CASCADE,
        part        INTEGER,
        category    TEXT NOT NULL CHECK (category IN ('Direct', 'Support', 'Others')),
        employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
        weightage   REAL NOT NULL CHECK (weightage >= 0 AND weightage <= 1),
        paid_on     TEXT,
        paid_amount REAL,
        paid_by     TEXT,
        UNIQUE (period_id, part, category, employee_id)
      );
      INSERT INTO allocations_new (id, period_id, part, category, employee_id, weightage, paid_on, paid_amount, paid_by)
        SELECT id, period_id, NULL, category, employee_id, weightage, paid_on, paid_amount, paid_by FROM allocations;
      DROP TABLE allocations;
      ALTER TABLE allocations_new RENAME TO allocations;
      COMMIT;
    `);
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

// Quarterly payouts. Pay for a month belongs to its calendar quarter and is paid in a payout run for
// that quarter (pay month = N months after the quarter ends, payout_settings 'pay_lag', 1 by default;
// the first quarter paid this way is 'first_quarter'). Each employee gets a line per currency:
// submitted (amount frozen, with a comment) -> approved by a different admin -> paid. payout_items is
// each line's breakdown (contributor row and month), frozen at submission; a row in a line is locked.
// payout_notes holds the comment for an employee before submitting (and the undo comment if its submission was undone).
// payout_log is the history of every step (submitted, approved, undone, paid) with its comment.
// payout_approvals is each admin's approval of a line; a line is approved once it has as many as the
// 'approvals_required' setting (0, 1 or 2; 1 by default). The submitter can't approve their own line.
db.exec(`
  CREATE TABLE IF NOT EXISTS payout_settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  INSERT OR IGNORE INTO payout_settings (key, value) VALUES ('pay_lag', '1'), ('first_quarter', '2026-Q4'), ('approvals_required', '1');
  CREATE TABLE IF NOT EXISTS payout_runs (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    quarter    TEXT NOT NULL UNIQUE,              -- '2026-Q4'
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS payout_lines (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id           INTEGER NOT NULL REFERENCES payout_runs(id) ON DELETE CASCADE,
    employee_id      INTEGER NOT NULL REFERENCES employees(id),
    currency         TEXT NOT NULL,
    amount           REAL NOT NULL,
    comment          TEXT,
    status           TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted', 'approved', 'paid')),
    submitted_by_id  INTEGER,
    submitted_by     TEXT,
    submitted_at     TEXT NOT NULL DEFAULT (datetime('now')),
    approver_comment TEXT,
    approved_by_id   INTEGER,
    approved_by      TEXT,
    approved_at      TEXT,
    paid_on          TEXT,
    paid_by          TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_payout_lines_run ON payout_lines(run_id);
  CREATE TABLE IF NOT EXISTS payout_items (
    line_id       INTEGER NOT NULL REFERENCES payout_lines(id) ON DELETE CASCADE,
    allocation_id INTEGER NOT NULL REFERENCES allocations(id),
    part          INTEGER NOT NULL,               -- 1 for a whole payment, else the month of a custom payment
    part_month    TEXT NOT NULL,
    amount        REAL NOT NULL,
    PRIMARY KEY (allocation_id, part)
  );
  CREATE INDEX IF NOT EXISTS idx_payout_items_line ON payout_items(line_id);
  CREATE TABLE IF NOT EXISTS payout_notes (
    quarter          TEXT NOT NULL,
    employee_id      INTEGER NOT NULL REFERENCES employees(id),
    comment          TEXT,
    sent_back_reason TEXT,
    sent_back_by     TEXT,
    updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (quarter, employee_id)
  );
  -- What happened to each employee's line in a quarter (submit, approve, undo, paid), with the comment.
  CREATE TABLE IF NOT EXISTS payout_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    quarter     TEXT NOT NULL,
    employee_id INTEGER NOT NULL REFERENCES employees(id),
    currency    TEXT NOT NULL,
    amount      REAL NOT NULL,
    action      TEXT NOT NULL,                   -- submitted, approval (1 of 2), approved, undo_approve, undo_submit, paid, undo_paid
    comment     TEXT,
    by_name     TEXT,
    at          TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_payout_log_quarter ON payout_log(quarter);
  CREATE TABLE IF NOT EXISTS payout_approvals (
    line_id   INTEGER NOT NULL REFERENCES payout_lines(id) ON DELETE CASCADE,
    admin_id  INTEGER NOT NULL,
    by_name   TEXT,
    comment   TEXT,
    at        TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (line_id, admin_id)
  );
  -- Lines approved before payout_approvals existed keep their one approval.
  INSERT OR IGNORE INTO payout_approvals (line_id, admin_id, by_name, comment, at)
    SELECT id, approved_by_id, approved_by, approver_comment, COALESCE(approved_at, datetime('now'))
    FROM payout_lines WHERE approved_by_id IS NOT NULL;
`);

// Ratings: an admin rates each employee on each payment, for each month of it (part 0 = the whole
// payment, else the month of a custom payment), 1 Exceptional to 5 Unsatisfactory, with a comment
// giving specific instances. Optional when saving a payment; needed before its pay can be submitted
// in a payout, where the rating is frozen on payout_items with the amount.
db.exec(`
  CREATE TABLE IF NOT EXISTS ratings (
    period_id   INTEGER NOT NULL REFERENCES periods(id) ON DELETE CASCADE,
    part        INTEGER NOT NULL DEFAULT 0,
    employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    rating      INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
    comment     TEXT NOT NULL,
    rated_by    TEXT,
    rated_at    TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (period_id, part, employee_id)
  );
`);
{
  const itemCols = new Set(db.prepare('PRAGMA table_info(payout_items)').all().map((c) => c.name));
  if (!itemCols.has('rating')) db.exec('ALTER TABLE payout_items ADD COLUMN rating INTEGER');
  if (!itemCols.has('rating_comment')) db.exec('ALTER TABLE payout_items ADD COLUMN rating_comment TEXT');
}

// The payments views. payment_base has one row per contributor with its share's category % and the
// payout (payment date, and for custom payments the months: the payment's own, else the share's moved
// along to this payment, else 12 months from the payment month). Monthly payments are always one
// time. payments adds pay = the pool for its month x Category % x Weightage %: a row for one month of
// a custom payment gets that month's equal part of the pool (the last month takes the rounding), a
// whole-payment row gets the whole pool. pay_parts has one row per month: a month's own row, or (for
// rows saved before months had their own weightages) the row split evenly over the months.
// Pay is never stored. Rebuilt on every start so new columns appear.
{
  const MI = (x) => `(CAST(substr(${x}, 1, 4) AS INTEGER) * 12 + CAST(substr(${x}, 6, 2) AS INTEGER))`;
  const K = `(${MI('p.start_month')} - ${MI('COALESCE(s.payment_month, s.from_month)')})`;
  const SHIFT = (col) => `CASE WHEN ${col} IS NULL THEN NULL ELSE substr(date(${col} || '-01', (CASE WHEN ${K} >= 0 THEN '+' ELSE '' END) || ${K} || ' months'), 1, 7) END`;
  const CUSTOM = `(c.frequency <> 'Monthly' AND COALESCE(p.payout_type, s.payout_type, 'once') = 'custom')`;
  const FROM = `COALESCE(p.pay_from, ${SHIFT('s.pay_from')}, p.pay_month, p.start_month)`;
  const TO = `COALESCE(p.pay_to, ${SHIFT('s.pay_to')})`;
  const OLD_PAID_ON = 'CASE WHEN x.alloc_part IS NOT NULL OR x.parts = 1 THEN x.paid_on ELSE pp.paid_on END';
  const OLD_PAID = 'CASE WHEN x.alloc_part IS NOT NULL OR x.parts = 1 THEN x.paid ELSE COALESCE(pp.paid_amount, 0) END';
  // A month's part of a row's pay (the whole pay for one time; legacy rows split evenly, the last part taking the rounding).
  const PART_AMOUNT = 'CASE WHEN x.alloc_part IS NOT NULL OR x.parts = 1 THEN x.pay WHEN seq.n = x.parts - 1 THEN x.pay - ROUND(x.pay / x.parts, 2) * (x.parts - 1) ELSE ROUND(x.pay / x.parts, 2) END';
  db.exec(`
    DROP VIEW IF EXISTS pay_parts;
    DROP VIEW IF EXISTS payments;
    DROP VIEW IF EXISTS payment_base;
    CREATE VIEW payment_base AS
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
      a.part         AS alloc_part,
      a.paid_on      AS paid_on,
      CASE WHEN a.paid_on IS NULL THEN 0 ELSE a.paid_amount END AS paid,
      p.amount       AS amount,
      p.share_pct    AS share_pct,
      p.fx_rate      AS fx_rate,
      c.currency     AS customer_currency,
      COALESCE(p.pay_month, p.start_month) AS pay_month,
      CASE WHEN ${CUSTOM} THEN 'custom' ELSE 'once' END AS payout_type,
      CASE WHEN ${CUSTOM} THEN ${FROM} ELSE COALESCE(p.pay_month, p.start_month) END AS part_from,
      CASE WHEN NOT ${CUSTOM} THEN 1 WHEN ${TO} IS NULL THEN 12 ELSE MAX(1, ${MI(TO)} - ${MI(FROM)} + 1) END AS parts,
      -- pay, paid and revenue (the employees' pool) are in this currency
      CASE WHEN p.fx_rate IS NOT NULL AND c.currency <> 'INR' THEN 'INR' ELSE c.currency END AS currency
    FROM allocations a
    JOIN periods   p ON p.id = a.period_id
    JOIN customers c ON c.id = p.customer_id
    JOIN employees e ON e.id = a.employee_id
    JOIN shares    s ON s.customer_id = c.id AND p.start_month >= s.from_month
                    AND (s.to_month IS NULL OR p.start_month <= s.to_month);

    CREATE VIEW payments AS
    SELECT b.*,
      CASE WHEN b.alloc_part IS NULL OR b.parts <= 1 THEN b.revenue
           WHEN b.alloc_part >= b.parts THEN b.revenue - ROUND(b.revenue / b.parts, 2) * (b.parts - 1)
           ELSE ROUND(b.revenue / b.parts, 2) END * b.category_pct * b.weightage AS pay
    FROM payment_base b;

    CREATE VIEW pay_parts AS
    WITH RECURSIVE seq(n) AS (SELECT 0 UNION ALL SELECT n + 1 FROM seq WHERE n < 119)
    SELECT x.*, COALESCE(x.alloc_part, seq.n + 1) AS part,
      substr(date(x.part_from || '-01', '+' || (COALESCE(x.alloc_part, seq.n + 1) - 1) || ' months'), 1, 7) AS part_month,
      ${PART_AMOUNT} AS part_amount,
      -- paid before quarterly payouts (a paid mark on the row, or on one of its months)
      ${OLD_PAID_ON} AS old_paid_on,
      ${OLD_PAID} AS old_paid,
      -- quarterly payout: the line it's in, if any (paid once that line is paid)
      pi.line_id AS payout_line_id,
      pl.status  AS payout_status,
      pr.quarter AS payout_quarter,
      COALESCE(${OLD_PAID_ON}, CASE WHEN pl.status = 'paid' THEN pl.paid_on END) AS part_paid_on,
      CASE WHEN ${OLD_PAID} > 0 THEN ${OLD_PAID} WHEN pl.status = 'paid' THEN ${PART_AMOUNT} ELSE 0 END AS part_paid
    FROM payments x JOIN seq ON (x.alloc_part IS NOT NULL AND seq.n = 0) OR (x.alloc_part IS NULL AND seq.n < x.parts)
    LEFT JOIN part_paid pp ON x.alloc_part IS NULL AND pp.allocation_id = x.id AND pp.seq = seq.n + 1
    LEFT JOIN payout_items pi ON pi.allocation_id = x.id AND pi.part = COALESCE(x.alloc_part, seq.n + 1)
    LEFT JOIN payout_lines pl ON pl.id = pi.line_id
    LEFT JOIN payout_runs  pr ON pr.id = pl.run_id;
  `);
}

// Custom payments saved before months had their own weightages: give every month its own copy of
// each contributor (same weightage), carrying over months already marked paid.
{
  const legacy = db.prepare('SELECT id, period_id, category, employee_id, weightage, parts FROM payments WHERE alloc_part IS NULL AND parts > 1').all();
  if (legacy.length) {
    const marks = db.prepare('SELECT * FROM part_paid WHERE allocation_id = ?');
    const insert = db.prepare(`
      INSERT INTO allocations (period_id, part, category, employee_id, weightage, paid_on, paid_amount, paid_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    const remove = db.prepare('DELETE FROM allocations WHERE id = ?');
    db.exec('BEGIN');
    try {
      for (const a of legacy) {
        const paid = new Map(marks.all(a.id).map((m) => [m.seq, m]));
        for (let k = 1; k <= a.parts; k++) {
          const m = paid.get(k);
          insert.run(a.period_id, k, a.category, a.employee_id, a.weightage, m?.paid_on ?? null, m?.paid_amount ?? null, m?.paid_by ?? null);
        }
        remove.run(a.id);
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}

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
