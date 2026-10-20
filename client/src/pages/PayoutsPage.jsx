import { Fragment, useEffect, useState } from 'react';
import { api } from '../api.js';
import { moneyIn, monthLabel, dayLabel, quarterLabel, payoutStatusLabel } from '../format.js';
import { Loading, ErrorNote } from '../components/common.jsx';

// Quarterly payouts (admins). Pay for a month belongs to its calendar quarter and is paid in the pay
// month (N months after the quarter ends). For a quarter: write a comment for each employee and
// submit (amounts are frozen); a different admin approves each employee's line (or all at once); then
// approved lines are marked paid with the payroll date. Until paid, an approval or a submission can be
// undone with a comment. The History list shows every step with its comment.
export default function PayoutsPage({ quarter, user }) {
  return quarter ? <QuarterPayout quarter={quarter} user={user} /> : <PayoutList />;
}

const historyLabel = { submitted: 'Submitted', approved: 'Approved', undo_approve: 'Approval undone', undo_submit: 'Submission undone', paid: 'Paid' };
const todayIso = () =>new Date().toLocaleDateString('en-CA');
const moneyList = (list) => (list.length ? list.map((x) => moneyIn(x.amount, x.currency)).join(' · ') : '–');

function PayoutList() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [lag, setLag] = useState('1');
  const [notice, setNotice] = useState('');
  const load = () => api.payouts.list().then((d) => { setData(d); setLag(String(d.settings.pay_lag)); }).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  if (error && !data) return <ErrorNote>{error}</ErrorNote>;
  if (!data) return <Loading />;

  const saveLag = async (e) => {
    e.preventDefault();
    setError('');
    setNotice('');
    try {
      await api.payouts.saveSettings(Number(lag));
      setNotice('Saved.');
      load();
    } catch (err) { setError(err.message); }
  };

  return (
    <section>
      <h1>Payouts</h1>
      <p className="muted">
        Pay is paid every quarter: Oct to Dec in January, Jan to Mar in April, and so on. Open a quarter to write a comment for
        each employee and submit it; another admin approves; then mark it paid. Quarterly payouts start with {quarterLabel(data.settings.first_quarter)}.
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
    act(`line-${line.id}`, () => api.payouts.approve(line.id, comment), `Approved ${line.employee}.`);
  };
  // Undo needs a comment saying why.
  const undo = (line, what, fn, done) => {
    const comment = window.prompt(`Undo the ${what} of ${line.employee}'s ${moneyIn(line.amount, line.currency)}? Add a comment saying why:`, '');
    if (comment === null) return;
    if (!comment.trim()) { setError(`Add a comment saying why the ${what} is undone.`); return; }
    act(`line-${line.id}`, () => fn(line.id, comment), done);
  };
  const undoApprove = (line) => undo(line, 'approval', api.payouts.undoApprove, `${line.employee}'s approval was undone; it's waiting for approval again.`);
  const undoSubmit = (line) => undo(line, 'submission', api.payouts.undoSubmit, `${line.employee}'s submission was undone; it's back in To submit.`);

  const submitted = data.lines.filter((l) => l.status === 'submitted');
  const approvable = submitted.filter((l) => l.can_approve);
  const approved = data.lines.filter((l) => l.status === 'approved');
  const totals = (rows) => {
    const by = new Map();
    for (const r of rows) by.set(r.currency, (by.get(r.currency) || 0) + r.amount);
    return [...by].map(([currency, amount]) => ({ currency, amount }));
  };

  const Breakdown = ({ items, currency, colSpan }) => (
    <tr className="drill-row">
      <td colSpan={colSpan}>
        <table className="alloc payout-items">
          <tbody>
            {items.map((it) => (
              <tr key={`${it.allocation_id}-${it.part}`}>
                <td>{monthLabel(it.part_month)}</td>
                <td><a href={`#/customers/${it.customer_id}`}>{it.customer}</a></td>
                <td>{it.category}</td>
                <td className="num">{moneyIn(it.amount, currency)}</td>
                <td>{it.carried && <span className="tag">Carried over</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </td>
    </tr>
  );

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
      {data.admin_count < 2 && <p className="warn-text small">Approving needs a second admin (the admin who submits can't approve). Add another admin on the Users page.</p>}
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
                <tr><th scope="col">Employee</th><th scope="col" className="num">Amount</th><th scope="col">Comment for this employee</th></tr>
              </thead>
              <tbody>
                {data.draft.map((g) => {
                  const key = `d-${g.employee_id}-${g.currency}`;
                  return (
                    <Fragment key={key}>
                      <tr>
                        <th scope="row">
                          <button type="button" className="drill" aria-expanded={open.has(key)} onClick={() => toggle(key)}>
                            <span className="drill-caret" aria-hidden="true">▸</span>{g.employee}
                          </button>
                          {g.sent_back_reason && <div className="warn-text small">Submission undone by {g.sent_back_by}: {g.sent_back_reason}</div>}
                        </th>
                        <td className="num strong">{moneyIn(g.amount, g.currency)}</td>
                        <td>
                          <textarea rows={2} value={comments[g.employee_id] ?? ''} placeholder="For example: led the Acme onboarding PoC"
                            aria-label={`Comment for ${g.employee}`} maxLength={2000}
                            onChange={(e) => setComments({ ...comments, [g.employee_id]: e.target.value })}
                            onBlur={() => saveComment(g.employee_id)} />
                        </td>
                      </tr>
                      {open.has(key) && <Breakdown items={g.items} currency={g.currency} colSpan={3} />}
                    </Fragment>
                  );
                })}
              </tbody>
              <tfoot>
                <tr><th scope="row">Total</th><td className="num">{moneyList(totals(data.draft))}</td><td /></tr>
              </tfoot>
            </table>
          </div>
          <div className="actions">
            <button className="primary" disabled={busy !== ''}
              onClick={() => act('submit', () => api.payouts.submit(quarter, comments), `Submitted ${data.draft.length} for approval.`)}>
              {busy === 'submit' ? 'Submitting…' : `Submit ${data.draft.length} for approval`}
            </button>
          </div>
          <p className="muted small">Submitting freezes these amounts; the pay in them can't be changed on the payment pages unless the submission is undone.</p>
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
                  (r) => `Approved ${r.approved}.${r.skipped ? ` ${r.skipped} you submitted need another admin.` : ''}`)}>
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
                            <span className="drill-caret" aria-hidden="true">▸</span>{l.employee}
                          </button>
                        </th>
                        <td className="num strong">{moneyIn(l.amount, l.currency)}</td>
                        <td className="small">{l.comment || <span className="muted">–</span>}</td>
                        <td className="small">
                          <span className={l.status === 'paid' ? 'paid-tag' : l.status === 'approved' ? 'ok-text' : ''}>
                            {l.status === 'paid' ? `✓ Paid ${dayLabel(l.paid_on)}` : payoutStatusLabel[l.status]}
                          </span>
                          <div className="muted">Submitted by {l.submitted_by}{l.approved_by ? `, approved by ${l.approved_by}` : ''}</div>
                          {l.approver_comment && <div className="muted">Note: {l.approver_comment}</div>}
                        </td>
                        <td className="row-actions small">
                          {l.status === 'submitted' && (l.can_approve
                            ? <button className="link" disabled={busy !== ''} onClick={() => approve(l)}>Approve</button>
                            : <span className="muted" title={l.submitted_by_id === user.id ? 'You submitted it' : undefined}>
                              {l.submitted_by_id === user.id ? 'Another admin approves' : 'Waiting'}
                            </span>)}
                          {l.status === 'approved' && (
                            <button className="link" disabled={busy !== '' || !paidOn}
                              onClick={() => act(`line-${l.id}`, () => api.payouts.markPaid(l.id, paidOn), `Marked ${l.employee} as paid.`)}>
                              Mark paid
                            </button>
                          )}
                          {l.status === 'submitted' && <button className="link danger" disabled={busy !== ''} onClick={() => undoSubmit(l)}>Undo submit</button>}
                          {l.status === 'approved' && <button className="link danger" disabled={busy !== ''} onClick={() => undoApprove(l)}>Undo approve</button>}
                        </td>
                      </tr>
                      {open.has(key) && <Breakdown items={l.items} currency={l.currency} colSpan={5} />}
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
