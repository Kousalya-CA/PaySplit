import { Fragment, useEffect, useState } from 'react';
import { api } from '../api.js';
import { moneyIn, monthLabel, dayLabel, quarterLabel, payoutStatusLabel, ratingLabel, pct } from '../format.js';
import { Loading, ErrorNote } from '../components/common.jsx';
import { EmpName, EmpTags, useEmployeeMap } from '../components/EmpStatus.jsx';

// Quarterly payouts (admins). Pay for a month belongs to its calendar quarter and is paid in the pay
// month (N months after the quarter ends). For a quarter: write a comment for each employee and
// submit (amounts are frozen); a different admin approves each employee's line (or all at once); then
// approved lines are marked paid with the payroll date. Until paid, an approval or a submission can be
// undone with a comment. The History list shows every step with its comment.
// How many admins approve each line (0, 1 or 2) is set on the Payouts list.
// Pay not submitted yet, or a submitted or approved line, can be moved to the next quarter (with a
// comment) and moved back.
export default function PayoutsPage({ quarter, user }) {
  return quarter ? <QuarterPayout quarter={quarter} user={user} /> : <PayoutList />;
}

const APPROVAL_CHOICES = [
  [0, 'No approval (approved when submitted)'],
  [1, '1 admin approves'],
  [2, '2 admins approve'],
];
// What the approval rule means, for the quarter page.
const approvalRule = (n) => (n === 0
  ? 'no approval needed: lines are approved as soon as they are submitted.'
  : n === 1
    ? 'one submits, and any other admin approves (1 approval).'
    : 'one submits, and two other admins each approve (2 approvals, from two different admins).');
// '2026-Q4' -> '2027-Q1'.
const nextQuarterOf = (q) => (q.endsWith('Q4') ? `${Number(q.slice(0, 4)) + 1}-Q1` : `${q.slice(0, 6)}${Number(q.slice(6)) + 1}`);
const historyLabel = { submitted: 'Submitted', approval: 'Approval added', approved: 'Approved', undo_approve: 'Approval undone', undo_submit: 'Submission undone', paid: 'Paid', undo_paid: 'Payment undone', moved: 'Moved to next quarter', move_back: 'Moved back' };
// A line's breakdown grouped by payment month: each customer once, with the employee's categories
// and weightages, the amount, and their rating and comment.
const byPayment = (items) => {
  const out = new Map();
  for (const it of items) {
    const key = `${it.period_id}|${it.alloc_part ?? 0}|${it.part_month}`;
    if (!out.has(key)) out.set(key, { key, customer_id: it.customer_id, customer: it.customer, month: it.part_month, roles: [], amount: 0, rating: it.rating, comment: it.rating_comment, carried: it.carried });
    const g = out.get(key);
    g.roles.push(`${it.category} ${pct(it.weightage)}`);
    g.amount += it.amount;
  }
  return [...out.values()];
};
const unratedCount = (items) => byPayment(items).filter((g) => g.rating == null).length;
const avgRating = (items) => {
  const rated = byPayment(items).filter((g) => g.rating != null);
  return rated.length ? (rated.reduce((s, g) => s + g.rating, 0) / rated.length).toFixed(1) : null;
};
const todayIso = () => new Date().toLocaleDateString('en-CA');
const moneyList = (list) => (list.length ? list.map((x) => moneyIn(x.amount, x.currency)).join(' · ') : '–');

function PayoutList() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [lag, setLag] = useState('1');
  const [approvals, setApprovals] = useState('1');
  const [notice, setNotice] = useState('');
  const load = () => api.payouts.list().then((d) => { setData(d); setLag(String(d.settings.pay_lag)); setApprovals(String(d.settings.approvals_required)); }).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  if (error && !data) return <ErrorNote>{error}</ErrorNote>;
  if (!data) return <Loading />;

  const saveLag = async (e) => {
    e.preventDefault();
    setError('');
    setNotice('');
    try {
      const r = await api.payouts.saveSettings(Number(lag), Number(approvals));
      setNotice(r.approved ? `Saved. ${r.approved} waiting line${r.approved === 1 ? ' now has' : 's now have'} enough approvals and ${r.approved === 1 ? 'is' : 'are'} approved.` : 'Saved.');
      load();
    } catch (err) { setError(err.message); }
  };

  return (
    <section>
      <h1>Payouts</h1>
      <p className="muted">
        Pay is paid every quarter: Oct to Dec in January, Jan to Mar in April, and so on. Open a quarter to write a comment for
        each employee and submit it; other admins approve (as many as Approvals needed); then mark it paid. Quarterly payouts start with {quarterLabel(data.settings.first_quarter)}.
      </p>
      <ErrorNote>{error}</ErrorNote>
      <form className="row payout-settings" onSubmit={saveLag}>
        <label>
          <span>Pay month</span>
          <span className="suffix-input">
            <input type="number" min="0" max="12" step="1" value={lag} onChange={(e) => setLag(e.target.value)} required />
            <span aria-hidden="true">months after the quarter</span>
          </span>
        </label>
        <label>
          <span>Approvals needed</span>
          <select value={approvals} onChange={(e) => setApprovals(e.target.value)}>
            {APPROVAL_CHOICES.map(([n, label]) => <option key={n} value={n}>{label}</option>)}
          </select>
        </label>
        <button className="secondary" type="submit">Save</button>
        {notice && <span className="ok-text small">{notice}</span>}
      </form>

      {data.quarters.length === 0 ? (
        <div className="empty"><p>Nothing to pay yet.</p></div>
      ) : (
        <div className="table-wrap">
          <table className="grid list">
            <thead>
              <tr>
                <th scope="col">Quarter</th><th scope="col">Months</th><th scope="col">Pay in</th>
                <th scope="col" className="num">Employees</th><th scope="col" className="num">Total</th><th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {data.quarters.map((q) => (
                <tr key={q.quarter}>
                  <th scope="row"><a href={`#/payouts/${q.quarter}`}>{quarterLabel(q.quarter)}</a></th>
                  <td>{monthLabel(q.from)} to {monthLabel(q.to)}</td>
                  <td>{monthLabel(q.pay_month)}</td>
                  <td className="num">{q.employees}</td>
                  <td className="num">{moneyList(q.totals)}</td>
                  <td className={q.status === 'Paid' ? 'ok-text' : ''}>{q.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function QuarterPayout({ quarter, user }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState('');
  const [comments, setComments] = useState({}); // employee id -> comment being typed
  const [paidOn, setPaidOn] = useState(todayIso());
  const [open, setOpen] = useState(() => new Set());
  const emps = useEmployeeMap(); // PIP / Relieved highlights

  const load = () => api.payouts.get(quarter).then((d) => {
    setData(d);
    setComments(Object.fromEntries(d.draft.map((g) => [g.employee_id, g.comment || ''])));
  }).catch((e) => setError(e.message));
  useEffect(() => { load(); }, [quarter]);

  if (error && !data) return <ErrorNote>{error}</ErrorNote>;
  if (!data) return <Loading />;

  const act = async (key, fn, message) => {
    setBusy(key);
    setError('');
    setNotice('');
    try {
      const res = await fn();
      setNotice(typeof message === 'function' ? message(res) : message);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  };
  const toggle = (key) => setOpen((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });
  // Comments save when the box loses focus (and are sent again with Submit).
  const saveComment = (employeeId) => api.payouts.saveNote(quarter, employeeId, comments[employeeId] || '').catch((e) => setError(e.message));
  const approve = (line) => {
    const comment = window.prompt(`Approve ${line.employee}'s ${moneyIn(line.amount, line.currency)}? Add a note if you like (optional).`, '');
    if (comment === null) return;
    act(`line-${line.id}`, () => api.payouts.approve(line.id, comment),
      (r) => (r.status === 'approved' ? `Approved ${line.employee}.` : `Added your approval for ${line.employee}; it needs another admin's approval.`));
  };
  // Undo needs a comment saying why.
  const undo = (line, what, fn, done) => {
    const comment = window.prompt(`Undo the ${what} of ${line.employee}'s ${moneyIn(line.amount, line.currency)}? Add a comment saying why:`, '');
    if (comment === null) return;
    if (!comment.trim()) { setError(`Add a comment saying why the ${what} is undone.`); return; }
    act(`line-${line.id}`, () => fn(line.id, comment), done);
  };
  const undoApprove = (line) => undo(line, 'approval', api.payouts.undoApprove, `${line.employee}'s approval was undone; it's waiting for approval again.`);
  const undoPaid = (line) => undo(line, 'payment', api.payouts.undoPaid, `${line.employee} is back to approved, not paid.`);
  const undoAllPaid = () => {
    const comment = window.prompt(`Undo "paid" on all ${paidLines.length} paid lines in ${quarterLabel(quarter)}? They go back to approved. Add a comment saying why:`, '');
    if (comment === null) return;
    if (!comment.trim()) { setError('Add a comment saying why the payment is undone.'); return; }
    act('unpaid-all', () => api.payouts.undoAllPaid(quarter, comment), (r) => `${r.undone} line${r.undone === 1 ? ' is' : 's are'} back to approved, not paid.`);
  };
  // Move to the next quarter / move back: a comment is needed.
  const askComment = (question) => {
    const comment = window.prompt(question, '');
    if (comment === null) return null;
    if (!comment.trim()) { setError('Add a comment saying why.'); return null; }
    return comment;
  };
  const next = nextQuarterOf(quarter);
  const moveDraft = (g) => {
    const comment = askComment(`Move ${g.employee}'s ${moneyIn(g.amount, g.currency)} to ${quarterLabel(next)}? Add a comment saying why:`);
    if (comment !== null) act(`move-d-${g.employee_id}`, () => api.payouts.moveDraft(quarter, g.employee_id, g.currency, comment), `Moved ${g.employee}'s pay to ${quarterLabel(next)}.`);
  };
  const moveLine = (l) => {
    const comment = askComment(`Move ${l.employee}'s ${l.status} ${moneyIn(l.amount, l.currency)} to ${quarterLabel(next)}? The line is removed here${l.status === 'approved' ? ' (with its approvals)' : ''} and waits in ${quarterLabel(next)}'s To submit. Add a comment saying why:`);
    if (comment !== null) act(`line-${l.id}`, () => api.payouts.moveLine(l.id, comment), `Moved ${l.employee}'s pay to ${quarterLabel(next)}.`);
  };
  const moveBack = (m) => {
    const comment = askComment(`Move ${m.employee ? `${m.employee}'s` : 'this'} pay back to ${quarterLabel(m.from_quarter)}? It waits there to be submitted again. Add a comment saying why:`);
    if (comment !== null) act(`move-${m.id}`, () => api.payouts.moveBack(m.id, comment), `Moved back to ${quarterLabel(m.from_quarter)}.`);
  };
  // The moves that brought a group's pay into this quarter.
  const movesIn = (items) => [...new Map(items.filter((i) => i.moved).map((i) => [i.moved.id, i.moved])).values()];
  const undoSubmit = (line) => undo(line, 'submission', api.payouts.undoSubmit, `${line.employee}'s submission was undone; it's back in To submit.`);

  const submitted = data.lines.filter((l) => l.status === 'submitted');
  const approvable = submitted.filter((l) => l.can_approve);
  const approved = data.lines.filter((l) => l.status === 'approved');
  const paidLines = data.lines.filter((l) => l.status === 'paid');
  const totals = (rows) => {
    const by = new Map();
    for (const r of rows) by.set(r.currency, (by.get(r.currency) || 0) + r.amount);
    return [...by].map(([currency, amount]) => ({ currency, amount }));
  };

  const Breakdown = ({ items, currency, colSpan, emp }) => (
    <tr className="drill-row">
      <td colSpan={colSpan}>
        <table className="alloc payout-items">
          <thead>
            <tr><th scope="col">Month</th><th scope="col">Customer</th><th scope="col">Weightage</th><th scope="col" className="num">Amount</th><th scope="col">Rating</th><th scope="col">Comment</th></tr>
          </thead>
          <tbody>
            {byPayment(items).map((g) => (
              <tr key={g.key}>
                <td>{monthLabel(g.month)}{g.carried && <span className="tag">Carried over</span>}<EmpTags emp={emp} from={g.month} /></td>
                <td><a href={`#/customers/${g.customer_id}`}>{g.customer}</a></td>
                <td className="small">{g.roles.join(' · ')}</td>
                <td className="num">{moneyIn(g.amount, currency)}</td>
                <td className={g.rating == null ? 'warn-text small' : 'small'}>{ratingLabel(g.rating)}</td>
                <td className="small payout-comment">{g.comment || <span className="muted">–</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </td>
    </tr>
  );
  // Every submit / approve / undo / paid step for one employee in this quarter, oldest first.
  const LineHistory = ({ employeeId, colSpan }) => {
    const steps = data.history.filter((h) => h.employee_id === employeeId).reverse();
    return (
      <tr className="drill-row">
        <td colSpan={colSpan}>
          <h3 className="line-history-title">Submission and approval history</h3>
          {steps.length === 0 ? <p className="muted small">No steps yet.</p> : (
            <ol className="line-history small">
              {steps.map((h) => (
                <li key={h.id}>
                  <span className="muted">{h.at.slice(0, 16)} UTC</span>{' '}
                  <strong className={h.action.startsWith('undo') ? 'warn-text' : ''}>{historyLabel[h.action] || h.action}</strong>{' '}
                  by {h.by_name} · {moneyIn(h.amount, h.currency)}
                  {h.comment && <div className="muted">“{h.comment}”</div>}
                </li>
              ))}
            </ol>
          )}
        </td>
      </tr>
    );
  };
  const ratingSummary = (items) => {
    const avg = avgRating(items);
    const missing = unratedCount(items);
    const n = byPayment(items).length;
    return (
      <div className="small">
        <span className="muted">{n} payment month{n === 1 ? '' : 's'}{avg ? ` · avg rating ${avg}` : ''}</span>
        {missing > 0 && <span className="warn-text"> · {missing} not rated</span>}
      </div>
    );
  };
  const needed = data.settings.approvals_required;
  const unratedDraft = data.draft.reduce((s, g) => s + unratedCount(g.items), 0);

  return (
    <section>
      <a className="back" href="#/payouts">Payouts</a>
      <div className="page-head">
        <div>
          <h1>{quarterLabel(quarter)} payout</h1>
          <p className="muted">{monthLabel(data.from)} to {monthLabel(data.to)} · pay in <strong>{monthLabel(data.pay_month)}</strong></p>
        </div>
      </div>
      {data.running && <p className="warn-text small">This quarter hasn't ended yet, so more pay may still come in. You can submit now; pay added later goes in as another submission.</p>}
      <div className="approvers-panel small">
        <strong>Who approves:</strong> {approvalRule(needed)}{needed > 0 && " The admin who submits a line can't approve it."} Change this with Approvals needed on the <a href="#/payouts">Payouts</a> page.
        <div>
          Admins ({data.admins.length}):{' '}
          {data.admins.map((a, i) => (
            <span key={a.id}>{i ? ', ' : ''}{a.name}{a.is_owner ? ' (owner)' : ''}{a.invited ? ' (invited)' : ''}{a.id === user.id ? ' (you)' : ''}</span>
          ))}
        </div>
      </div>
      {needed > 0 && data.admin_count <= needed && (
        <p className="warn-text small">
          Each line needs {needed} approval{needed === 1 ? '' : 's'} from admins other than the one who submits, so there have to be at least {needed + 1} admins.
          Add another admin on the Users page, or lower Approvals needed.
        </p>
      )}
      <ErrorNote>{error}</ErrorNote>
      {notice && <p className="ok-text" role="status">{notice}</p>}

      <h2>To submit</h2>
      {data.draft.length === 0 ? (
        <p className="muted">Nothing waiting to be submitted.</p>
      ) : (
        <>
          <div className="table-wrap">
            <table className="grid list">
              <thead>
                <tr><th scope="col">Employee</th><th scope="col" className="num">Amount</th><th scope="col">Comment for this employee</th><th><span className="sr-only">Actions</span></th></tr>
              </thead>
              <tbody>
                {data.draft.map((g) => {
                  const key = `d-${g.employee_id}-${g.currency}`;
                  return (
                    <Fragment key={key}>
                      <tr>
                        <th scope="row">
                          <button type="button" className="drill" aria-expanded={open.has(key)} onClick={() => toggle(key)}>
                            <span className="drill-caret" aria-hidden="true">▸</span><EmpName emp={emps.get(g.employee_id)} name={g.employee} from={data.from} to={data.to} />
                          </button>
                          {ratingSummary(g.items)}
                          {g.sent_back_reason && <div className="warn-text small">Submission undone by {g.sent_back_by}: {g.sent_back_reason}</div>}
                          {movesIn(g.items).map((m) => (
                            <div key={m.id} className="small moved-note">
                              <span className="tag">Moved from {quarterLabel(m.from_quarter)}</span> by {m.by_name}: {m.comment}{' '}
                              <button className="link" disabled={busy !== ''} onClick={() => moveBack({ ...m, employee: g.employee })}>Move back</button>
                            </div>
                          ))}
                        </th>
                        <td className="num strong">{moneyIn(g.amount, g.currency)}</td>
                        <td>
                          <textarea rows={2} value={comments[g.employee_id] ?? ''} placeholder="For example: led the Acme onboarding PoC"
                            aria-label={`Comment for ${g.employee}`} maxLength={2000}
                            onChange={(e) => setComments({ ...comments, [g.employee_id]: e.target.value })}
                            onBlur={() => saveComment(g.employee_id)} />
                        </td>
                        <td className="row-actions small">
                          <button className="link" disabled={busy !== ''} onClick={() => moveDraft(g)}>Move to {quarterLabel(next)}</button>
                        </td>
                      </tr>
                      {open.has(key) && <Breakdown items={g.items} currency={g.currency} colSpan={4} emp={emps.get(g.employee_id)} />}
                    </Fragment>
                  );
                })}
              </tbody>
              <tfoot>
                <tr><th scope="row">Total</th><td className="num">{moneyList(totals(data.draft))}</td><td colSpan={2} /></tr>
              </tfoot>
            </table>
          </div>
          <div className="actions">
            <button className="primary" disabled={busy !== '' || unratedDraft > 0}
              title={unratedDraft > 0 ? 'Rate every employee on the payment pages first' : undefined}
              onClick={() => act('submit', () => api.payouts.submit(quarter, comments), `Submitted ${data.draft.length} for approval.`)}>
              {busy === 'submit' ? 'Submitting…' : `Submit ${data.draft.length} for approval`}
            </button>
          </div>
          {unratedDraft > 0 && (
            <p className="warn-text small">
              {unratedDraft} payment month{unratedDraft === 1 ? ' is' : 's are'} not rated yet. Open an employee above to see which, then add the rating and
              comment on that customer's payment (step 2, Ratings & comments). Submit is available once everyone is rated.
            </p>
          )}
          <p className="muted small">Submitting freezes these amounts, ratings and comments; the pay in them can't be changed on the payment pages unless the submission is undone.</p>
        </>
      )}

      <h2>Submitted</h2>
      {data.lines.length === 0 ? (
        <p className="muted">Nothing submitted yet.</p>
      ) : (
        <>
          <div className="actions payout-bulk">
            {approvable.length > 0 && (
              <button className="secondary" disabled={busy !== ''}
                onClick={() => act('approve-all', () => api.payouts.approveAll(quarter),
                  (r) => [`Approved ${r.approved}.`, r.partly ? `Added your approval to ${r.partly} that need another admin.` : '',
                    r.skipped ? `${r.skipped} you submitted or already approved need other admins.` : ''].filter(Boolean).join(' '))}>
                {busy === 'approve-all' ? 'Approving…' : `Approve all (${approvable.length})`}
              </button>
            )}
            {approved.length > 0 && (
              <>
                <label className="paid-on">
                  <span>Paid on</span>
                  <input type="date" value={paidOn} max={todayIso()} onChange={(e) => setPaidOn(e.target.value)} />
                </label>
                <button className="primary" disabled={busy !== '' || !paidOn}
                  onClick={() => act('paid-all', () => api.payouts.markAllPaid(quarter, paidOn), (r) => `Marked ${r.paid} as paid.`)}>
                  {busy === 'paid-all' ? 'Saving…' : `Mark ${approved.length} approved as paid`}
                </button>
              </>
            )}
            {paidLines.length > 0 && (
              <button className="link danger" disabled={busy !== ''} onClick={undoAllPaid}>
                {busy === 'unpaid-all' ? 'Saving…' : `Undo paid (${paidLines.length})`}
              </button>
            )}
          </div>
          <div className="table-wrap">
            <table className="grid list">
              <thead>
                <tr>
                  <th scope="col">Employee</th><th scope="col" className="num">Amount</th><th scope="col">Comment</th>
                  <th scope="col">Status</th><th><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {data.lines.map((l) => {
                  const key = `l-${l.id}`;
                  return (
                    <Fragment key={key}>
                      <tr>
                        <th scope="row">
                          <button type="button" className="drill" aria-expanded={open.has(key)} onClick={() => toggle(key)}>
                            <span className="drill-caret" aria-hidden="true">▸</span><EmpName emp={emps.get(l.employee_id)} name={l.employee} from={data.from} to={data.to} />
                          </button>
                          {ratingSummary(l.items)}
                        </th>
                        <td className="num strong">{moneyIn(l.amount, l.currency)}</td>
                        <td className="small">{l.comment || <span className="muted">–</span>}</td>
                        <td className="small">
                          <span className={l.status === 'paid' ? 'paid-tag' : l.status === 'approved' ? 'ok-text' : ''}>
                            {l.status === 'paid' ? `✓ Paid ${dayLabel(l.paid_on)}` : payoutStatusLabel[l.status]}
                            {l.status === 'submitted' && needed > 0 && ` (${l.approvals.length} of ${needed})`}
                          </span>
                          <div className="muted">Submitted by {l.submitted_by} · {l.submitted_at.slice(0, 16)} UTC</div>
                          {l.approvals.map((a) => (
                            <div key={a.admin_id} className="muted">Approved by {a.by_name} · {a.at.slice(0, 16)} UTC{a.comment ? ` · “${a.comment}”` : ''}</div>
                          ))}
                          {l.approvals.length === 0 && l.approved_by && <div className="muted">Approved by {l.approved_by} · {l.approved_at.slice(0, 16)} UTC</div>}
                          {l.status === 'submitted' && l.approvers.length > 0 && <div className="muted">Can approve: {l.approvers.join(', ')}</div>}
                          {l.approvals.length === 0 && l.approver_comment && <div className="muted">Note: {l.approver_comment}</div>}
                        </td>
                        <td className="row-actions small">
                          {l.status === 'submitted' && (l.can_approve
                            ? <button className="link" disabled={busy !== ''} onClick={() => approve(l)}>Approve</button>
                            : <span className="muted" title={l.submitted_by_id === user.id ? 'You submitted it' : undefined}>
                              {l.submitted_by_id === user.id ? 'Other admins approve' : l.approvals.some((a) => a.admin_id === user.id) ? 'You approved' : 'Waiting'}
                            </span>)}
                          {l.status === 'approved' && (
                            <button className="link" disabled={busy !== '' || !paidOn}
                              onClick={() => act(`line-${l.id}`, () => api.payouts.markPaid(l.id, paidOn), `Marked ${l.employee} as paid.`)}>
                              Mark paid
                            </button>
                          )}
                          {l.status === 'submitted' && <button className="link danger" disabled={busy !== ''} onClick={() => undoSubmit(l)}>Undo submit</button>}
                          {l.status !== 'paid' && <button className="link" disabled={busy !== ''} onClick={() => moveLine(l)}>Move to {quarterLabel(next)}</button>}
                          {l.status === 'paid' && <button className="link danger" disabled={busy !== ''} onClick={() => undoPaid(l)}>Undo paid</button>}
                          {(l.status === 'approved' || (l.status === 'submitted' && l.approvals.length > 0)) && (
                            <button className="link danger" disabled={busy !== ''} onClick={() => undoApprove(l)}>Undo approve</button>
                          )}
                        </td>
                      </tr>
                      {open.has(key) && <Breakdown items={l.items} currency={l.currency} colSpan={5} emp={emps.get(l.employee_id)} />}
                      {open.has(key) && <LineHistory employeeId={l.employee_id} colSpan={5} />}
                    </Fragment>
                  );
                })}
              </tbody>
              <tfoot>
                <tr><th scope="row">Total</th><td className="num">{moneyList(totals(data.lines))}</td><td colSpan={3} /></tr>
              </tfoot>
            </table>
          </div>
          {approved.length === 0 && <p className="muted small">"Mark paid" appears once lines are approved; it uses the Paid on date.</p>}
        </>
      )}

      {data.moved_out.length > 0 && (
        <>
          <h2>Moved to a later quarter</h2>
          <div className="table-wrap">
            <table className="grid list">
              <thead>
                <tr>
                  <th scope="col">Employee</th><th scope="col" className="num">Amount</th><th scope="col">To</th>
                  <th scope="col">Why</th><th scope="col">By</th><th><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {data.moved_out.map((m) => (
                  <tr key={m.id}>
                    <th scope="row">{m.employee}</th>
                    <td className="num">{moneyIn(m.amount, m.currency)}</td>
                    <td><a href={`#/payouts/${m.to_quarter}`}>{quarterLabel(m.to_quarter)}</a></td>
                    <td className="small">{m.comment}</td>
                    <td className="small">{m.by_name} · {m.at.slice(0, 16)} UTC</td>
                    <td className="row-actions small">
                      {m.can_move_back
                        ? <button className="link" disabled={busy !== ''} onClick={() => moveBack(m)}>Move back</button>
                        : <span className="muted" title="Its pay is already submitted there, or moved on again">Can't move back here</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <h2>History</h2>
      {data.history.length === 0 ? (
        <p className="muted">Nothing has happened in this quarter yet.</p>
      ) : (
        <div className="table-wrap">
          <table className="grid list">
            <thead>
              <tr>
                <th scope="col">When (UTC)</th><th scope="col">Employee</th><th scope="col" className="num">Amount</th>
                <th scope="col">What</th><th scope="col">By</th><th scope="col">Comment</th>
              </tr>
            </thead>
            <tbody>
              {data.history.map((h) => (
                <tr key={h.id}>
                  <td className="small">{h.at.slice(0, 16)}</td>
                  <td>{h.employee}</td>
                  <td className="num">{moneyIn(h.amount, h.currency)}</td>
                  <td className={h.action.startsWith('undo') ? 'warn-text' : ''}>{historyLabel[h.action] || h.action}</td>
                  <td className="small">{h.by_name}</td>
                  <td className="small">{h.comment || <span className="muted">–</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
