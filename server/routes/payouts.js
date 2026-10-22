// Quarterly payouts: pay for a month belongs to its calendar quarter and is paid in that quarter's
// payout, in the pay month (N months after the quarter ends). An admin writes a comment for each
// employee and submits the quarter (amounts are frozen); a different admin approves each employee's
// line (or all at once); then lines are marked paid with the payroll date. Until paid, an approval can
// be undone (back to submitted) and a submission undone (back to "to submit"), each with a comment.
// Every step is written to payout_log with its comment.
// Employees see their own submitted statements. See payout_* tables in db.js.
import { db, transaction } from '../db.js';
import { HttpError } from '../http.js';
import { isAdmin, myEmployeeId, monthLabel } from './data.js';

const QUARTER_RE = /^\d{4}-Q[1-4]$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const round2 = (n) => Math.round(n * 100) / 100;

function addMonths(ym, n) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
// '2026-11' -> '2026-Q4'; a quarter's first and last month; the quarter after.
export const quarterOf = (m) => `${m.slice(0, 4)}-Q${Math.ceil(Number(m.slice(5, 7)) / 3)}`;
export function quarterMonths(q) {
  const from = `${q.slice(0, 4)}-${String(Number(q.slice(6)) * 3 - 2).padStart(2, '0')}`;
  return { from, to: addMonths(from, 2) };
}
const nextQuarter = (q) => quarterOf(addMonths(quarterMonths(q).to, 1));
// Today's month in India (a payout's month can't be paid before then).
const thisMonth = () => new Date(Date.now() + 5.5 * 3600000).toISOString().slice(0, 7);

const q = {
  settings: db.prepare('SELECT key, value FROM payout_settings'),
  saveSetting: db.prepare('INSERT INTO payout_settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value'),
  parts: db.prepare(`
    SELECT id AS allocation_id, part, part_month, part_amount AS amount, currency, employee_id, employee,
      customer_id, customer, category, start_month, old_paid_on, payout_line_id, period_id, alloc_part, weightage
    FROM pay_parts ORDER BY part_month, customer, employee`),
  ratings: db.prepare('SELECT period_id, part, employee_id, rating, comment FROM ratings'),
  runs: db.prepare('SELECT * FROM payout_runs'),
  run: db.prepare('SELECT * FROM payout_runs WHERE quarter = ?'),
  insertRun: db.prepare('INSERT INTO payout_runs (quarter) VALUES (?)'),
  lines: db.prepare(`
    SELECT l.*, r.quarter, e.name AS employee FROM payout_lines l
    JOIN payout_runs r ON r.id = l.run_id JOIN employees e ON e.id = l.employee_id
    ORDER BY e.name, l.currency`),
  line: db.prepare('SELECT l.*, r.quarter, e.name AS employee FROM payout_lines l JOIN payout_runs r ON r.id = l.run_id JOIN employees e ON e.id = l.employee_id WHERE l.id = ?'),
  insertLine: db.prepare(`
    INSERT INTO payout_lines (run_id, employee_id, currency, amount, comment, submitted_by_id, submitted_by)
    VALUES (?, ?, ?, ?, ?, ?, ?)`),
  insertItem: db.prepare(`INSERT INTO payout_items (line_id, allocation_id, part, part_month, amount, rating, rating_comment)
    VALUES (?, ?, ?, ?, ?, ?, ?)`),
  items: db.prepare(`
    SELECT i.*, c.id AS customer_id, c.name AS customer, a.category, a.weightage, p.start_month,
      p.id AS period_id, a.part AS alloc_part
    FROM payout_items i JOIN allocations a ON a.id = i.allocation_id
    JOIN periods p ON p.id = a.period_id JOIN customers c ON c.id = p.customer_id
    WHERE i.line_id = ? ORDER BY i.part_month, c.name`),
  approve: db.prepare(`UPDATE payout_lines SET status = 'approved', approved_by_id = ?, approved_by = ?, approved_at = datetime('now'),
    approver_comment = ? WHERE id = ? AND status = 'submitted'`),
  paid: db.prepare("UPDATE payout_lines SET status = 'paid', paid_on = ?, paid_by = ? WHERE id = ? AND status = 'approved'"),
  unapprove: db.prepare(`UPDATE payout_lines SET status = 'submitted', approved_by_id = NULL, approved_by = NULL, approved_at = NULL,
    approver_comment = NULL WHERE id = ? AND status = 'approved'`),
  deleteLine: db.prepare('DELETE FROM payout_lines WHERE id = ?'),
  log: db.prepare('INSERT INTO payout_log (quarter, employee_id, currency, amount, action, comment, by_name) VALUES (?, ?, ?, ?, ?, ?, ?)'),
  history: db.prepare(`SELECT g.*, e.name AS employee FROM payout_log g JOIN employees e ON e.id = g.employee_id
    WHERE g.quarter = ? ORDER BY g.id DESC`),
  notes: db.prepare('SELECT * FROM payout_notes WHERE quarter = ?'),
  saveNote: db.prepare(`
    INSERT INTO payout_notes (quarter, employee_id, comment) VALUES (?, ?, ?)
    ON CONFLICT (quarter, employee_id) DO UPDATE SET comment = excluded.comment, updated_at = datetime('now')`),
  sendBackNote: db.prepare(`
    INSERT INTO payout_notes (quarter, employee_id, comment, sent_back_reason, sent_back_by) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (quarter, employee_id) DO UPDATE SET comment = excluded.comment, sent_back_reason = excluded.sent_back_reason,
      sent_back_by = excluded.sent_back_by, updated_at = datetime('now')`),
  clearSentBack: db.prepare('UPDATE payout_notes SET sent_back_reason = NULL, sent_back_by = NULL WHERE quarter = ? AND employee_id = ?'),
  adminCount: db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'"),
  admins: db.prepare("SELECT id, name, is_owner, password_hash = '' AS invited FROM users WHERE role = 'admin' ORDER BY is_owner DESC, name"),
  sentBackQuarters: db.prepare('SELECT DISTINCT quarter FROM payout_notes WHERE sent_back_reason IS NOT NULL'),
};

function settings() {
  const v = Object.fromEntries(q.settings.all().map((r) => [r.key, r.value]));
  return { pay_lag: Number(v.pay_lag ?? 1), first_quarter: QUARTER_RE.test(v.first_quarter) ? v.first_quarter : '2026-Q4' };
}
const quarterInfo = (quarter, lag) => {
  const { from, to } = quarterMonths(quarter);
  return { quarter, from, to, pay_month: addMonths(to, lag) };
};

// Everything the pages need: lines per quarter, and the pay not in a line yet ("draft") placed in
// its quarter. Pay before the first quarterly payout goes into the first one; pay for a quarter whose
// lines are all paid goes into the next quarter that isn't (it's late, so it's carried over).
function state() {
  const cfg = settings();
  const lines = q.lines.all();
  const linesBy = new Map();
  for (const l of lines) {
    if (!linesBy.has(l.quarter)) linesBy.set(l.quarter, []);
    linesBy.get(l.quarter).push(l);
  }
  // A quarter is done once every line is paid and nothing undone is waiting to be resubmitted.
  const waiting = new Set(q.sentBackQuarters.all().map((r) => r.quarter));
  const closed = (qq) => !waiting.has(qq) && (linesBy.get(qq) || []).length > 0 && linesBy.get(qq).every((l) => l.status === 'paid');
  const draft = new Map(); // quarter -> Map('employee|currency' -> group)
  const ratings = new Map(q.ratings.all().map((r) => [`${r.period_id}|${r.part}|${r.employee_id}`, r]));
  for (const p of q.parts.all()) {
    if (p.old_paid_on || p.payout_line_id || Math.abs(p.amount || 0) < 0.005) continue;
    const own = quarterOf(p.part_month);
    let qq = own < cfg.first_quarter ? cfg.first_quarter : own;
    while (closed(qq)) qq = nextQuarter(qq);
    if (!draft.has(qq)) draft.set(qq, new Map());
    const key = `${p.employee_id}|${p.currency}`;
    const groups = draft.get(qq);
    if (!groups.has(key)) groups.set(key, { employee_id: p.employee_id, employee: p.employee, currency: p.currency, amount: 0, items: [] });
    const g = groups.get(key);
    g.amount = round2(g.amount + p.amount);
    const r = ratings.get(`${p.period_id}|${p.alloc_part ?? 0}|${p.employee_id}`);
    g.items.push({ ...p, carried: own !== qq, rating: r?.rating ?? null, rating_comment: r?.comment ?? null });
  }
  return { cfg, linesBy, draft };
}

function parsePaidOn(value) {
  const day = String(value ?? '').trim();
  const date = new Date(`${day}T00:00:00Z`);
  if (!DATE_RE.test(day) || Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== day) {
    throw new HttpError(400, 'Choose the date it was paid.');
  }
  return day;
}
function requireQuarter(value) {
  const quarter = String(value ?? '').toUpperCase();
  if (!QUARTER_RE.test(quarter)) throw new HttpError(404, 'Quarter not found.');
  return quarter;
}
const byName = (user) => user.name || user.email;
const logLine = (line, action, comment, user) =>
  q.log.run(line.quarter, line.employee_id, line.currency, line.amount, action, comment || null, byName(user));
// The comment an undo needs.
function requireComment(body, what) {
  const comment = String(body?.comment ?? '').trim();
  if (!comment) throw new HttpError(400, `Add a comment saying why the ${what} is undone.`);
  if (comment.length > 2000) throw new HttpError(400, 'Keep the comment to 2000 characters or fewer.');
  return comment;
}
function requireLine(id) {
  const line = q.line.get(id);
  if (!line) throw new HttpError(404, 'That payout line wasn\'t found. Reload the page.');
  return line;
}
// Four-eyes: a line is approved by an admin other than the one who submitted it.
function assertCanApprove(line, user) {
  if (q.adminCount.get().n < 2) throw new HttpError(409, 'Approving needs a second admin: the admin who submits can\'t approve. Add another admin on the Users page.');
  if (line.submitted_by_id === user.id) throw new HttpError(403, `You submitted ${line.employee}'s line, so another admin has to approve it.`);
}
const withItems = (l) => ({ ...l, items: q.items.all(l.id) });
// A quarter's status from its lines and the pay not submitted yet.
function statusOf(lines, draftCount) {
  if (!lines.length) return draftCount ? 'Draft' : 'Nothing to pay';
  const counts = { submitted: 0, approved: 0, paid: 0 };
  for (const l of lines) counts[l.status] += 1;
  if (!draftCount && counts.paid === lines.length) return 'Paid';
  const parts = [];
  if (draftCount) parts.push(`${draftCount} to submit`);
  if (counts.submitted) parts.push(`${counts.submitted} waiting for approval`);
  if (counts.approved) parts.push(`${counts.approved} approved, not paid`);
  if (counts.paid) parts.push(`${counts.paid} paid`);
  return parts.join(' · ');
}
const totalsBy = (rows) => {
  const out = new Map();
  for (const r of rows) out.set(r.currency, round2((out.get(r.currency) || 0) + r.amount));
  return [...out].map(([currency, amount]) => ({ currency, amount }));
};

export function registerPayoutRoutes(router) {
  const admin = { admin: true };

  router.get('/api/payouts', () => {
    const { cfg, linesBy, draft } = state();
    const current = quarterOf(thisMonth());
    const quarters = new Set([...linesBy.keys(), ...draft.keys()]);
    if (current >= cfg.first_quarter) quarters.add(current);
    const list = [...quarters].sort().reverse().map((quarter) => {
      const lines = linesBy.get(quarter) || [];
      const groups = [...(draft.get(quarter)?.values() || [])];
      const employees = new Set([...lines.map((l) => l.employee_id), ...groups.map((g) => g.employee_id)]);
      return {
        ...quarterInfo(quarter, cfg.pay_lag),
        employees: employees.size,
        totals: totalsBy([...lines, ...groups]),
        status: statusOf(lines, groups.length),
      };
    });
    return { settings: cfg, quarters: list };
  }, admin);

  router.get('/api/payouts/:quarter', ({ params, user }) => {
    const quarter = requireQuarter(params.quarter);
    const { cfg, linesBy, draft } = state();
    const notes = new Map(q.notes.all(quarter).map((n) => [n.employee_id, n]));
    const admins = q.admins.all().map((a) => ({ ...a, is_owner: !!a.is_owner, invited: !!a.invited }));
    const adminCount = admins.length;
    return {
      ...quarterInfo(quarter, cfg.pay_lag),
      running: thisMonth() <= quarterMonths(quarter).to,
      settings: cfg,
      draft: [...(draft.get(quarter)?.values() || [])].sort((a, b) => a.employee.localeCompare(b.employee)).map((g) => {
        const note = notes.get(g.employee_id);
        return { ...g, comment: note?.comment || '', sent_back_reason: note?.sent_back_reason || null, sent_back_by: note?.sent_back_by || null };
      }),
      lines: (linesBy.get(quarter) || []).map((l) => ({
        ...withItems(l),
        can_approve: l.status === 'submitted' && adminCount >= 2 && l.submitted_by_id !== user.id,
        // Four-eyes: any admin except the one who submitted the line.
        approvers: adminCount >= 2 ? admins.filter((a) => a.id !== l.submitted_by_id).map((a) => a.name) : [],
      })),
      admin_count: adminCount,
      admins,
      history: q.history.all(quarter),
    };
  }, admin);

  // The comment for an employee before submitting.
  router.put('/api/payouts/:quarter/notes/:employeeId', ({ params, body }) => {
    const quarter = requireQuarter(params.quarter);
    const comment = String(body.comment ?? '').trim();
    if (comment.length > 2000) throw new HttpError(400, 'Keep the comment to 2000 characters or fewer.');
    q.saveNote.run(quarter, Number(params.employeeId), comment || null);
    return { ok: true };
  }, admin);

  // Submit the quarter: every employee's pay not in a line yet becomes a line (amount frozen) with
  // its comment. Comments sent with the request are saved first.
  router.post('/api/payouts/:quarter/submit', ({ params, body, user }) => {
    const quarter = requireQuarter(params.quarter);
    const comments = body?.comments && typeof body.comments === 'object' ? body.comments : {};
    transaction(() => {
      for (const [employeeId, text] of Object.entries(comments)) {
        const comment = String(text ?? '').trim();
        if (comment.length > 2000) throw new HttpError(400, 'Keep each comment to 2000 characters or fewer.');
        q.saveNote.run(quarter, Number(employeeId), comment || null);
      }
      const groups = [...(state().draft.get(quarter)?.values() || [])];
      if (!groups.length) throw new HttpError(400, 'There\'s nothing to submit in this quarter.');
      // Every employee needs a rating and comment on every payment month in the quarter first.
      const missing = new Map();
      for (const g of groups) {
        for (const it of g.items) {
          if (it.rating == null) missing.set(`${it.period_id}|${it.alloc_part ?? 0}|${g.employee_id}`, `${g.employee} (${it.customer}, ${monthLabel(it.part_month)})`);
        }
      }
      if (missing.size) {
        const list = [...missing.values()];
        throw new HttpError(400, `Rate every employee before submitting. Not rated yet: ${list.slice(0, 5).join('; ')}${list.length > 5 ? ` and ${list.length - 5} more` : ''}. Add ratings on the payment pages.`);
      }
      const run = q.run.get(quarter) || { id: Number(q.insertRun.run(quarter).lastInsertRowid) };
      const notes = new Map(q.notes.all(quarter).map((n) => [n.employee_id, n]));
      for (const g of groups) {
        const lineId = Number(q.insertLine.run(run.id, g.employee_id, g.currency, g.amount, notes.get(g.employee_id)?.comment || null,
          user.id, user.name || user.email).lastInsertRowid);
        for (const it of g.items) q.insertItem.run(lineId, it.allocation_id, it.part, it.part_month, round2(it.amount), it.rating, it.rating_comment);
        q.clearSentBack.run(quarter, g.employee_id);
        q.log.run(quarter, g.employee_id, g.currency, g.amount, 'submitted', notes.get(g.employee_id)?.comment || null, byName(user));
      }
    });
    return { ok: true };
  }, admin);

  router.post('/api/payout-lines/:id/approve', ({ params, body, user }) => {
    const line = requireLine(params.id);
    if (line.status !== 'submitted') throw new HttpError(409, `${line.employee}'s line is already ${line.status}.`);
    assertCanApprove(line, user);
    const comment = String(body?.comment ?? '').trim() || null;
    transaction(() => {
      q.approve.run(user.id, byName(user), comment, line.id);
      logLine(line, 'approved', comment, user);
    });
    return { ok: true };
  }, admin);

  // Approve every submitted line this admin didn't submit.
  router.post('/api/payouts/:quarter/approve-all', ({ params, user }) => {
    const quarter = requireQuarter(params.quarter);
    const lines = (state().linesBy.get(quarter) || []).filter((l) => l.status === 'submitted');
    if (!lines.length) throw new HttpError(400, 'No lines are waiting for approval.');
    if (q.adminCount.get().n < 2) throw new HttpError(409, 'Approving needs a second admin: the admin who submits can\'t approve. Add another admin on the Users page.');
    const mine = lines.filter((l) => l.submitted_by_id !== user.id);
    if (!mine.length) throw new HttpError(403, 'You submitted every waiting line, so another admin has to approve them.');
    transaction(() => {
      for (const l of mine) {
        q.approve.run(user.id, byName(user), null, l.id);
        logLine(l, 'approved', 'Approve all', user);
      }
    });
    return { ok: true, approved: mine.length, skipped: lines.length - mine.length };
  }, admin);

  // Undo an approval (with a comment): the line is back to submitted and needs approving again.
  router.post('/api/payout-lines/:id/undo-approve', ({ params, body, user }) => {
    const line = requireLine(params.id);
    if (line.status !== 'approved') throw new HttpError(409, `${line.employee}'s line is ${line.status}, not approved.`);
    const comment = requireComment(body, 'approval');
    transaction(() => {
      q.unapprove.run(line.id);
      logLine(line, 'undo_approve', comment, user);
    });
    return { ok: true };
  }, admin);

  // Undo a submission (with a comment): the line is removed, its pay is back to "to submit" in the
  // quarter, and its comment and the undo comment are kept for the next submission. An approved line's
  // approval is undone first.
  router.post('/api/payout-lines/:id/undo-submit', ({ params, body, user }) => {
    const line = requireLine(params.id);
    if (line.status !== 'submitted') {
      throw new HttpError(409, line.status === 'approved'
        ? `${line.employee}'s line is approved. Undo the approval first.`
        : `${line.employee}'s line is already paid, so it can't be undone.`);
    }
    const comment = requireComment(body, 'submission');
    transaction(() => {
      q.sendBackNote.run(line.quarter, line.employee_id, line.comment, comment, byName(user));
      q.deleteLine.run(line.id);
      logLine(line, 'undo_submit', comment, user);
    });
    return { ok: true };
  }, admin);

  router.post('/api/payout-lines/:id/paid', ({ params, body, user }) => {
    const line = requireLine(params.id);
    if (line.status !== 'approved') throw new HttpError(409, `${line.employee}'s line has to be approved before it's paid.`);
    const paidOn = parsePaidOn(body?.paid_on);
    transaction(() => {
      q.paid.run(paidOn, user.email || null, line.id);
      logLine(line, 'paid', `Paid on ${paidOn}`, user);
    });
    return { ok: true };
  }, admin);

  router.post('/api/payouts/:quarter/paid', ({ params, body, user }) => {
    const quarter = requireQuarter(params.quarter);
    const paidOn = parsePaidOn(body?.paid_on);
    const lines = (state().linesBy.get(quarter) || []).filter((l) => l.status === 'approved');
    if (!lines.length) throw new HttpError(400, 'No approved lines to mark as paid.');
    transaction(() => {
      for (const l of lines) {
        q.paid.run(paidOn, user.email || null, l.id);
        logLine(l, 'paid', `Paid on ${paidOn}`, user);
      }
    });
    return { ok: true, paid: lines.length };
  }, admin);

  router.put('/api/payout-settings', ({ body }) => {
    const lag = Number(body?.pay_lag);
    if (!Number.isInteger(lag) || lag < 0 || lag > 12) throw new HttpError(400, 'Pay month must be 0 to 12 months after the quarter ends.');
    q.saveSetting.run('pay_lag', String(lag));
    return settings();
  }, admin);

  // An employee's own quarterly statements (submitted, approved or paid), with the comment for them.
  // Their ratings and rating comments show once the line is approved.
  router.get('/api/my/statements', ({ user }) => {
    const mine = myEmployeeId(user);
    if (!mine) return [];
    const { cfg } = state();
    return q.lines.all().filter((l) => l.employee_id === mine).sort((a, b) => b.quarter.localeCompare(a.quarter)).map((l) => {
      const { approver_comment, approved_by_id, submitted_by_id, ...rest } = l;
      const shown = l.status !== 'submitted';
      const items = q.items.all(l.id).map((it) => (shown ? it : { ...it, rating: null, rating_comment: null }));
      return { ...rest, ...quarterInfo(l.quarter, cfg.pay_lag), items, viewer_is_admin: isAdmin(user) };
    });
  });
}
