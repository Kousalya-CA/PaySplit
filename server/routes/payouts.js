// Quarterly payouts: pay for a month belongs to its calendar quarter and is paid in that quarter's
// payout, in the pay month (N months after the quarter ends). An admin writes a comment for each
// employee and submits the quarter (amounts are frozen); other admins approve each employee's line
// (or all at once): 0, 1 or 2 approvals as set ('approvals_required'), never by the admin who
// submitted it; then lines are marked paid with the payroll date. Until paid, an approval can
// be undone (back to submitted), a submission undone (back to "to submit") and a payment undone (back
// to approved), each with a comment.
// Pay (not submitted, submitted or approved) can be moved to the next quarter with a comment, and moved
// back. Every step is written to payout_log with its comment.
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
  approvals: db.prepare('SELECT * FROM payout_approvals WHERE line_id = ? ORDER BY at, rowid'),
  addApproval: db.prepare('INSERT INTO payout_approvals (line_id, admin_id, by_name, comment) VALUES (?, ?, ?, ?)'),
  clearApprovals: db.prepare('DELETE FROM payout_approvals WHERE line_id = ?'),
  submittedLines: db.prepare(`SELECT l.*, r.quarter, e.name AS employee FROM payout_lines l JOIN payout_runs r ON r.id = l.run_id
    JOIN employees e ON e.id = l.employee_id WHERE l.status = 'submitted'`),
  paid: db.prepare("UPDATE payout_lines SET status = 'paid', paid_on = ?, paid_by = ? WHERE id = ? AND status = 'approved'"),
  unpaid: db.prepare("UPDATE payout_lines SET status = 'approved', paid_on = NULL, paid_by = NULL WHERE id = ? AND status = 'paid'"),
  unapprove: db.prepare(`UPDATE payout_lines SET status = 'submitted', approved_by_id = NULL, approved_by = NULL, approved_at = NULL,
    approver_comment = NULL WHERE id = ? AND status IN ('submitted', 'approved')`),
  deleteLine: db.prepare('DELETE FROM payout_lines WHERE id = ?'),
  log: db.prepare('INSERT INTO payout_log (quarter, employee_id, currency, amount, action, comment, by_name) VALUES (?, ?, ?, ?, ?, ?, ?)'),
  history: db.prepare(`SELECT g.*, e.name AS employee FROM payout_log g JOIN employees e ON e.id = g.employee_id
    WHERE g.quarter = ? ORDER BY g.id DESC`),
  notes: db.prepare('SELECT * FROM payout_notes WHERE quarter = ?'),
  activeMoveItems: db.prepare(`SELECT m.id, m.from_quarter, m.to_quarter, m.comment, m.by_name, m.at, i.allocation_id, i.part
    FROM payout_moves m JOIN payout_move_items i ON i.move_id = m.id WHERE m.reverted_at IS NULL ORDER BY m.id`),
  move: db.prepare('SELECT m.*, e.name AS employee FROM payout_moves m JOIN employees e ON e.id = m.employee_id WHERE m.id = ?'),
  moveItems: db.prepare('SELECT allocation_id, part FROM payout_move_items WHERE move_id = ?'),
  movesFrom: db.prepare(`SELECT m.*, e.name AS employee FROM payout_moves m JOIN employees e ON e.id = m.employee_id
    WHERE m.from_quarter = ? AND m.reverted_at IS NULL ORDER BY e.name`),
  insertMove: db.prepare(`INSERT INTO payout_moves (employee_id, currency, amount, from_quarter, to_quarter, comment, by_name)
    VALUES (?, ?, ?, ?, ?, ?, ?)`),
  insertMoveItem: db.prepare('INSERT INTO payout_move_items (move_id, allocation_id, part) VALUES (?, ?, ?)'),
  revertMove: db.prepare("UPDATE payout_moves SET reverted_at = datetime('now'), reverted_by = ?, revert_comment = ? WHERE id = ? AND reverted_at IS NULL"),
  lineItemKeys: db.prepare('SELECT allocation_id, part FROM payout_items WHERE line_id = ?'),
  itemInLine: db.prepare('SELECT 1 FROM payout_items WHERE allocation_id = ? AND part = ?'),
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
  const required = Number(v.approvals_required ?? 1);
  return {
    pay_lag: Number(v.pay_lag ?? 1),
    first_quarter: QUARTER_RE.test(v.first_quarter) ? v.first_quarter : '2026-Q4',
    approvals_required: [0, 1, 2].includes(required) ? required : 1,
  };
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
  // Pay moved to a later quarter waits there (the latest move wins).
  const moved = new Map(q.activeMoveItems.all().map((m) => [`${m.allocation_id}|${m.part}`, m]));
  for (const p of q.parts.all()) {
    if (p.old_paid_on || p.payout_line_id || Math.abs(p.amount || 0) < 0.005) continue;
    const own = quarterOf(p.part_month);
    const mv = moved.get(`${p.allocation_id}|${p.part}`);
    let qq = mv ? mv.to_quarter : own < cfg.first_quarter ? cfg.first_quarter : own;
    while (closed(qq)) qq = nextQuarter(qq);
    if (!draft.has(qq)) draft.set(qq, new Map());
    const key = `${p.employee_id}|${p.currency}`;
    const groups = draft.get(qq);
    if (!groups.has(key)) groups.set(key, { employee_id: p.employee_id, employee: p.employee, currency: p.currency, amount: 0, items: [] });
    const g = groups.get(key);
    g.amount = round2(g.amount + p.amount);
    const r = ratings.get(`${p.period_id}|${p.alloc_part ?? 0}|${p.employee_id}`);
    g.items.push({
      ...p, carried: !mv && own !== qq, rating: r?.rating ?? null, rating_comment: r?.comment ?? null,
      moved: mv ? { id: mv.id, from_quarter: mv.from_quarter, comment: mv.comment, by_name: mv.by_name, at: mv.at } : null,
    });
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
// A line needs 'approvals_required' approvals (0, 1 or 2), each from a different admin who isn't the
// one who submitted it. With 0, it's approved when it's submitted (or by any admin's Approve).
const approvalsNeeded = () => settings().approvals_required;
const tooFewAdmins = (needed) => new HttpError(409, `Each line needs ${needed} approval${needed === 1 ? '' : 's'} from admins other than the one who submits, so there have to be at least ${needed + 1} admins. Add another admin on the Users page, or lower the approvals needed on the Payouts page.`);
// Why this admin can't approve this line, or null if they can.
function cantApprove(line, user, needed, approvals) {
  if (line.status !== 'submitted') return `${line.employee}'s line is already ${line.status}.`;
  if (needed === 0) return null;
  if (line.submitted_by_id === user.id) return `You submitted ${line.employee}'s line, so other admins have to approve it.`;
  if (approvals.some((a) => a.admin_id === user.id)) return `You've already approved ${line.employee}'s line; it needs another admin's approval.`;
  return null;
}
// Add this admin's approval; the line is approved once it has enough.
function addApproval(line, user, comment, needed) {
  const approvals = q.approvals.all(line.id);
  if (needed > 0) {
    q.addApproval.run(line.id, user.id, byName(user), comment);
    approvals.push({ admin_id: user.id, by_name: byName(user), comment });
  }
  if (approvals.length >= needed) {
    q.approve.run(user.id, needed === 0 ? byName(user) : approvals.map((a) => a.by_name).join(', '), comment, line.id);
    logLine(line, 'approved', comment || (needed === 0 ? 'No approval needed' : null), user);
  } else {
    logLine(line, 'approval', [`Approval ${approvals.length} of ${needed}`, comment].filter(Boolean).join(': '), user);
  }
}
// After the approvals needed is lowered, waiting lines that already have enough are approved.
function approveReady(user) {
  const needed = approvalsNeeded();
  let n = 0;
  for (const line of q.submittedLines.all()) {
    const approvals = q.approvals.all(line.id);
    if (needed > 0 && approvals.length < needed) continue;
    const by = needed === 0 ? byName(user) : approvals.map((a) => a.by_name).join(', ');
    q.approve.run(approvals.at(-1)?.admin_id ?? user.id, by, null, line.id);
    logLine(line, 'approved', `Approvals needed changed to ${needed}`, user);
    n += 1;
  }
  return n;
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
    const needed = cfg.approvals_required;
    const enoughAdmins = needed === 0 || adminCount > needed;
    return {
      ...quarterInfo(quarter, cfg.pay_lag),
      running: thisMonth() <= quarterMonths(quarter).to,
      settings: cfg,
      draft: [...(draft.get(quarter)?.values() || [])].sort((a, b) => a.employee.localeCompare(b.employee)).map((g) => {
        const note = notes.get(g.employee_id);
        return { ...g, comment: note?.comment || '', sent_back_reason: note?.sent_back_reason || null, sent_back_by: note?.sent_back_by || null };
      }),
      lines: (linesBy.get(quarter) || []).map((l) => {
        const approvals = q.approvals.all(l.id);
        return {
          ...withItems(l),
          approvals,
          can_approve: enoughAdmins && !cantApprove(l, user, needed, approvals),
          // Who can still approve: any admin except the submitter and those who already approved.
          approvers: l.status === 'submitted' && enoughAdmins
            ? admins.filter((a) => needed === 0 || (a.id !== l.submitted_by_id && !approvals.some((x) => x.admin_id === a.id))).map((a) => a.name)
            : [],
        };
      }),
      admin_count: adminCount,
      admins,
      history: q.history.all(quarter),
      // Pay moved from this quarter to the next (still there), with whether it can be moved back.
      moved_out: q.movesFrom.all(quarter).map((m) => ({ ...m, can_move_back: !moveBackBlocker(m) })),
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
    const needed = approvalsNeeded();
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
        if (needed === 0) addApproval(requireLine(lineId), user, null, 0);
      }
    });
    return { ok: true };
  }, admin);

  router.post('/api/payout-lines/:id/approve', ({ params, body, user }) => {
    const line = requireLine(params.id);
    const needed = approvalsNeeded();
    if (line.status === 'submitted' && needed > 0 && q.adminCount.get().n <= needed) throw tooFewAdmins(needed);
    const why = cantApprove(line, user, needed, q.approvals.all(line.id));
    if (why) throw new HttpError(line.status === 'submitted' ? 403 : 409, why);
    const comment = String(body?.comment ?? '').trim() || null;
    if (comment && comment.length > 2000) throw new HttpError(400, 'Keep the comment to 2000 characters or fewer.');
    transaction(() => addApproval(line, user, comment, needed));
    return { ok: true, status: requireLine(line.id).status };
  }, admin);

  // Add this admin's approval to every waiting line they can approve (not their own, not approved by them yet).
  router.post('/api/payouts/:quarter/approve-all', ({ params, user }) => {
    const quarter = requireQuarter(params.quarter);
    const lines = (state().linesBy.get(quarter) || []).filter((l) => l.status === 'submitted');
    if (!lines.length) throw new HttpError(400, 'No lines are waiting for approval.');
    const needed = approvalsNeeded();
    if (needed > 0 && q.adminCount.get().n <= needed) throw tooFewAdmins(needed);
    const mine = lines.filter((l) => !cantApprove(l, user, needed, q.approvals.all(l.id)));
    if (!mine.length) throw new HttpError(403, 'You submitted or already approved every waiting line, so other admins have to approve them.');
    transaction(() => { for (const l of mine) addApproval(l, user, 'Approve all', needed); });
    const done = mine.filter((l) => requireLine(l.id).status === 'approved').length;
    return { ok: true, approved: done, partly: mine.length - done, skipped: lines.length - mine.length };
  }, admin);

  // Undo the approvals (with a comment), including a first approval of two: the line is back to
  // submitted with none, and needs approving again.
  router.post('/api/payout-lines/:id/undo-approve', ({ params, body, user }) => {
    const line = requireLine(params.id);
    const approved = line.status === 'approved' || (line.status === 'submitted' && q.approvals.all(line.id).length > 0);
    if (!approved) throw new HttpError(409, `${line.employee}'s line is ${line.status}, not approved.`);
    const comment = requireComment(body, 'approval');
    transaction(() => {
      q.unapprove.run(line.id);
      q.clearApprovals.run(line.id);
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

  // Move pay to the next quarter, with a comment: an employee's pay not submitted yet, or a submitted
  // or approved line (the line is removed and its pay waits in the next quarter's To submit).
  const moveComment = (body) => {
    const comment = String(body?.comment ?? '').trim();
    if (!comment) throw new HttpError(400, 'Add a comment saying why the pay moves to the next quarter.');
    if (comment.length > 2000) throw new HttpError(400, 'Keep the comment to 2000 characters or fewer.');
    return comment;
  };
  const recordMove = (employeeId, currency, amount, from, keys, comment, user) => {
    const to = nextQuarter(from);
    const id = Number(q.insertMove.run(employeeId, currency, amount, from, to, comment, byName(user)).lastInsertRowid);
    for (const k of keys) q.insertMoveItem.run(id, k.allocation_id, k.part);
    // An undone submission's note would keep the quarter open; the pay has left it.
    q.clearSentBack.run(from, employeeId);
    q.log.run(from, employeeId, currency, amount, 'moved', `To ${to}: ${comment}`, byName(user));
    q.log.run(to, employeeId, currency, amount, 'moved', `From ${from}: ${comment}`, byName(user));
    return to;
  };
  router.post('/api/payouts/:quarter/move', ({ params, body, user }) => {
    const quarter = requireQuarter(params.quarter);
    const comment = moveComment(body);
    const g = state().draft.get(quarter)?.get(`${Number(body?.employee_id)}|${body?.currency}`);
    if (!g) throw new HttpError(404, 'That employee has no pay waiting to be submitted in this quarter. Reload the page.');
    const to = transaction(() => recordMove(g.employee_id, g.currency, g.amount, quarter, g.items, comment, user));
    return { ok: true, to_quarter: to };
  }, admin);
  router.post('/api/payout-lines/:id/move', ({ params, body, user }) => {
    const line = requireLine(params.id);
    if (line.status === 'paid') throw new HttpError(409, `${line.employee}'s line is already paid, so it can't move. Undo paid first.`);
    const comment = moveComment(body);
    const to = transaction(() => {
      const keys = q.lineItemKeys.all(line.id);
      q.deleteLine.run(line.id);
      return recordMove(line.employee_id, line.currency, line.amount, line.quarter, keys, comment, user);
    });
    return { ok: true, to_quarter: to };
  }, admin);

  // Why a move can't be moved back, or null: its pay was submitted in the new quarter, or moved on again.
  function moveBackBlocker(m) {
    const keys = q.moveItems.all(m.id);
    if (keys.some((k) => q.itemInLine.get(k.allocation_id, k.part))) return `${m.employee}'s moved pay is already submitted in ${m.to_quarter}. Undo that submission first.`;
    const later = q.activeMoveItems.all().filter((x) => x.id > m.id && keys.some((k) => k.allocation_id === x.allocation_id && k.part === x.part));
    if (later.length) return `${m.employee}'s pay was moved on again to ${later[0].to_quarter}. Move it back from there first.`;
    return null;
  }
  // Move pay back to the quarter it came from (with a comment); it's waiting to be submitted there again.
  router.post('/api/payout-moves/:id/move-back', ({ params, body, user }) => {
    const m = q.move.get(params.id);
    if (!m || m.reverted_at) throw new HttpError(404, 'That move wasn\'t found or was already moved back. Reload the page.');
    const why = moveBackBlocker(m);
    if (why) throw new HttpError(409, why);
    const comment = String(body?.comment ?? '').trim();
    if (!comment) throw new HttpError(400, 'Add a comment saying why the pay moves back.');
    if (comment.length > 2000) throw new HttpError(400, 'Keep the comment to 2000 characters or fewer.');
    transaction(() => {
      q.revertMove.run(byName(user), comment, m.id);
      q.clearSentBack.run(m.to_quarter, m.employee_id);
      q.log.run(m.to_quarter, m.employee_id, m.currency, m.amount, 'move_back', `Back to ${m.from_quarter}: ${comment}`, byName(user));
      q.log.run(m.from_quarter, m.employee_id, m.currency, m.amount, 'move_back', `Back from ${m.to_quarter}: ${comment}`, byName(user));
    });
    return { ok: true, to_quarter: m.from_quarter };
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

  // Undo "paid" (with a comment): the line is approved and not paid again. For a line marked paid by mistake.
  router.post('/api/payout-lines/:id/undo-paid', ({ params, body, user }) => {
    const line = requireLine(params.id);
    if (line.status !== 'paid') throw new HttpError(409, `${line.employee}'s line is ${line.status}, not paid.`);
    const comment = requireComment(body, 'payment');
    transaction(() => {
      q.unpaid.run(line.id);
      logLine(line, 'undo_paid', comment, user);
    });
    return { ok: true };
  }, admin);

  // Undo "paid" on every paid line in a quarter, with one comment.
  router.post('/api/payouts/:quarter/undo-paid', ({ params, body, user }) => {
    const quarter = requireQuarter(params.quarter);
    const lines = (state().linesBy.get(quarter) || []).filter((l) => l.status === 'paid');
    if (!lines.length) throw new HttpError(400, 'No paid lines in this quarter.');
    const comment = requireComment(body, 'payment');
    transaction(() => {
      for (const l of lines) {
        q.unpaid.run(l.id);
        logLine(l, 'undo_paid', comment, user);
      }
    });
    return { ok: true, undone: lines.length };
  }, admin);

  router.put('/api/payout-settings', ({ body, user }) => {
    const lag = Number(body?.pay_lag);
    if (!Number.isInteger(lag) || lag < 0 || lag > 12) throw new HttpError(400, 'Pay month must be 0 to 12 months after the quarter ends.');
    let approved = 0;
    transaction(() => {
      q.saveSetting.run('pay_lag', String(lag));
      if (body?.approvals_required !== undefined) {
        const needed = Number(body.approvals_required);
        if (![0, 1, 2].includes(needed)) throw new HttpError(400, 'Approvals needed must be 0, 1 or 2.');
        if (needed > 0 && q.adminCount.get().n <= needed) throw tooFewAdmins(needed);
        q.saveSetting.run('approvals_required', String(needed));
        // Lowering it approves waiting lines that now have enough approvals.
        approved = approveReady(user);
      }
    });
    return { ...settings(), approved };
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
