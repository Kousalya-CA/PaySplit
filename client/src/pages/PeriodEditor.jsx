import { Fragment, useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { money, periodLabel, paidIn, pct, toPctInput, parseNum, monthLabel, dayLabel } from '../format.js';
import { ErrorNote } from '../components/common.jsx';

const CATEGORIES = ['Direct', 'Support', 'Others'];
let nextKey = 1;

const rowsFrom = (allocations) => Object.fromEntries(CATEGORIES.map((cat) => [
  cat,
  allocations.filter((a) => a.category === cat)
    .map((a) => ({
      key: nextKey++, id: a.id, employee_id: String(a.employee_id), weightage: toPctInput(a.weightage), exact: a.weightage,
      paid_on: a.paid_on, paid_amount: a.paid_amount,
    })),
]));

// Today as YYYY-MM-DD in local time, the default paid date.
const todayIso = () => new Date().toLocaleDateString('en-CA');

// Weightage as a fraction: the exact stored value if the row wasn't retyped, otherwise what was typed.
const fractionOf = (row) => (row.exact != null ? row.exact : parseNum(row.weightage) / 100);

// Revenue from a US dollar total: Total revenue ($) x % x USD to INR rate. 10% by default.
const usdFrom = (p) => ({
  total: p.total_usd != null ? String(p.total_usd) : '',
  pct: p.usd_pct != null ? toPctInput(p.usd_pct) : '10',
  rate: p.usd_inr_rate != null ? String(p.usd_inr_rate) : '',
});
const round2 = (n) => Math.round(n * 100) / 100;

// Today's USD to INR rate, fetched once per page load and shared by every period.
let ratePromise = null;
const todaysRate = () => (ratePromise ||= api.exchangeRate().catch((err) => { ratePromise = null; throw err; }));

// Edits one period: revenue plus the contributors in Direct, Support and Others.
// Pay = Revenue x Category % x Weightage %, recalculated as you type.
export default function PeriodEditor({ customer, period, prev, employees, onSaved, onDirtyChange }) {
  const label = periodLabel(period);
  const [revenue, setRevenue] = useState(String(period.revenue));
  const [usd, setUsd] = useState(() => usdFrom(period));
  const [today, setToday] = useState(null); // { rate, date } or { error }
  const [rows, setRows] = useState(() => rowsFrom(period.allocations));
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => { onDirtyChange(dirty); }, [dirty, onDirtyChange]);

  // A new copy of the period from the server (after saving or marking paid): show it unless
  // there are unsaved changes.
  useEffect(() => {
    if (dirty) return;
    setRevenue(String(period.revenue));
    setRows(rowsFrom(period.allocations));
  }, [period]);

  // Once anyone in this payment is paid, the revenue is locked (until every paid mark is undone).
  const anyPaid = period.allocations.some((a) => a.paid_on);
  const [busyPaid, setBusyPaid] = useState('');
  const [allDate, setAllDate] = useState(null); // paid date while "Mark all as paid" is open
  const paidAction = async (key, fn, message) => {
    setBusyPaid(key);
    setError('');
    setNotice('');
    try {
      const updated = await fn();
      onSaved(updated);
      setNotice(message);
      return true;
    } catch (err) {
      setError(err.message);
      return false;
    } finally {
      setBusyPaid('');
    }
  };
  const markPaid = (row, paidOn) => paidAction(`row-${row.id}`, () => api.allocations.markPaid(row.id, paidOn), 'Marked as paid.');
  const undoPaid = (row, name) => {
    if (!window.confirm(`Undo the paid mark for ${name}? Their weightage can then be changed again.`)) return;
    paidAction(`row-${row.id}`, () => api.allocations.undoPaid(row.id), 'Paid mark removed.');
  };
  const unpaidSaved = period.allocations.filter((a) => !a.paid_on);
  const markAll = async () => {
    if (await paidAction('all', () => api.periods.markAllPaid(period.id, allDate), `Marked ${unpaidSaved.length} as paid.`)) setAllDate(null);
  };

  // Fill in today's rate unless this payment was already saved with one.
  useEffect(() => {
    let live = true;
    todaysRate()
      .then((info) => { if (!live) return; setToday(info); setUsd((u) => (u.rate ? u : { ...u, rate: String(info.rate) })); })
      .catch((err) => { if (live) setToday({ error: err.message }); });
    return () => { live = false; };
  }, []);

  const change = (fn) => { fn(); setDirty(true); setNotice(''); };

  // With a dollar total, the ₹ revenue is worked out from it; otherwise it's typed in.
  const usdOn = usd.total.trim() !== '';
  const usdRevenue = round2(parseNum(usd.total) * (parseNum(usd.pct) / 100) * parseNum(usd.rate));
  const rev = usdOn ? usdRevenue : parseNum(revenue);
  const revValue = Number.isFinite(rev) ? rev : 0;
  // The revenue share covering this period. With none, every category gets 0%.
  const share = period.share;
  const categoryPct = share
    ? { Direct: share.direct_pct, Support: share.support_pct, Others: share.others_pct }
    : { Direct: 0, Support: 0, Others: 0 };

  const stats = useMemo(() => Object.fromEntries(CATEGORIES.map((cat) => {
    const pool = revValue * categoryPct[cat];
    const sum = rows[cat].reduce((s, r) => s + (Number.isFinite(fractionOf(r)) ? fractionOf(r) * 100 : 0), 0);
    return [cat, { pool, sum, paid: pool * sum / 100 }];
  })), [rows, revValue, customer]);

  const updateRow = (cat, key, field, value) => change(() => setRows((r) => ({
    ...r, [cat]: r[cat].map((row) => (row.key !== key ? row
      : field === 'weightage' ? { ...row, weightage: value, exact: null } : { ...row, [field]: value })),
  })));
  const addRow = (cat) => change(() => setRows((r) => ({ ...r, [cat]: [...r[cat], { key: nextKey++, employee_id: '', weightage: '', exact: null }] })));
  const removeRow = (cat, key) => change(() => setRows((r) => ({ ...r, [cat]: r[cat].filter((row) => row.key !== key) })));
  const splitEqually = (cat) => change(() => setRows((r) => {
    const n = r[cat].length;
    return { ...r, [cat]: r[cat].map((row) => ({ ...row, weightage: toPctInput(1 / n), exact: 1 / n })) };
  }));

  const copyPrevious = () => change(() => setRows(rowsFrom(prev.allocations)));
  const discard = () => {
    setRevenue(String(period.revenue));
    const saved = usdFrom(period);
    setUsd(saved.rate || !today?.rate ? saved : { ...saved, rate: String(today.rate) });
    setRows(rowsFrom(period.allocations));
    setDirty(false);
    setError('');
  };

  const save = async () => {
    setError('');
    if (usdOn) {
      const [t, p, r] = [parseNum(usd.total), parseNum(usd.pct), parseNum(usd.rate)];
      if (!Number.isFinite(t) || t < 0) return setError('Enter the total revenue in dollars as a number, for example 12000.');
      if (!Number.isFinite(p) || p < 0 || p > 100) return setError('The percentage of total revenue must be between 0 and 100.');
      if (!Number.isFinite(r) || r <= 0) return setError('Enter the USD to INR rate, for example 83.5.');
    }
    if (!Number.isFinite(rev) || rev < 0) return setError('Enter the revenue as a number, for example 10000.');
    const allocations = [];
    for (const cat of CATEGORIES) {
      for (const r of rows[cat]) {
        if (!r.employee_id) return setError(`${cat}: choose an employee for every row, or remove the empty row.`);
        const f = fractionOf(r);
        if (!Number.isFinite(f) || f < 0 || f > 1) return setError(`${cat}: every weightage must be a number between 0 and 100.`);
        allocations.push({ category: cat, employee_id: Number(r.employee_id), weightage: f });
      }
      if (stats[cat].sum > 100.01) return setError(`${cat} weightages add up to ${+stats[cat].sum.toFixed(2)}%. Reduce them to 100% or less.`);
    }
    setSaving(true);
    try {
      const updated = await api.periods.save(period.id, {
        revenue: rev,
        total_usd: usdOn ? parseNum(usd.total) : null,
        usd_pct: usdOn ? parseNum(usd.pct) / 100 : null,
        usd_inr_rate: usdOn ? parseNum(usd.rate) : null,
        allocations,
      });
      setDirty(false);
      setNotice(`Saved ${label}.`);
      onSaved(updated);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };


  const totalPaid = CATEGORIES.reduce((s, c) => s + stats[c].paid, 0);
  const wording = customer.frequency === 'Monthly'
    ? { note: 'This month\'s split. It can be different every month.', revenue: `Revenue for ${monthLabel(period.start_month)}` }
    : {
      note: `One payment and one split for ${label}. ${paidIn(period) || `Paid in ${monthLabel(period.start_month)}`}.`,
      revenue: 'Revenue for this payment',
    };

  return (
    <div className="period">
      <div className="period-head">
        <div>
          <h2>{label}</h2>
          <p className="muted small">{wording.note}</p>
          {share ? (
            <p className="muted small">Uses the <strong>{share.name}</strong> revenue share.</p>
          ) : (
            <p className="warn-text small">
              No revenue share covers {label}, so pay is ₹0. Add a share type for it in Edit customer,
              or clear its revenue and split so it's removed the next time the shares are saved.
            </p>
          )}
        </div>
        <label className="revenue">
          <span>{wording.revenue}{anyPaid && ' 🔒'}</span>
          <span className="prefix-input">
            <span aria-hidden="true">₹</span>
            <input inputMode="decimal" readOnly={usdOn || anyPaid}
              value={usdOn ? (Number.isFinite(usdRevenue) ? usdRevenue.toFixed(2) : '') : revenue}
              onChange={(e) => change(() => setRevenue(e.target.value))} />
          </span>
        </label>
      </div>

      {anyPaid && (
        <p className="muted small">
          🔒 Revenue is locked because someone in this payment is marked as paid. Undo every paid mark to change it.
        </p>
      )}
      <fieldset className="usd-calc" disabled={anyPaid}>
        <legend>Revenue from a total in US dollars</legend>
        <div className="row">
          <label>
            <span>Total revenue</span>
            <span className="prefix-input">
              <span aria-hidden="true">$</span>
              <input inputMode="decimal" value={usd.total} placeholder="Leave empty to type ₹ revenue"
                onChange={(e) => change(() => setUsd({ ...usd, total: e.target.value }))} />
            </span>
          </label>
          <label>
            <span>Percentage of total</span>
            <span className="suffix-input">
              <input inputMode="decimal" value={usd.pct} onChange={(e) => change(() => setUsd({ ...usd, pct: e.target.value }))} />
              <span aria-hidden="true">%</span>
            </span>
          </label>
          <label>
            <span>USD to INR rate</span>
            <span className="prefix-input">
              <span aria-hidden="true">₹</span>
              <input inputMode="decimal" value={usd.rate} onChange={(e) => change(() => setUsd({ ...usd, rate: e.target.value }))} />
            </span>
          </label>
        </div>
        <p className="muted small">
          {usdOn && Number.isFinite(usdRevenue)
            ? <>${usd.total} × {usd.pct}% × ₹{usd.rate} = <strong>{money(usdRevenue)}</strong>, filled in as {wording.revenue.toLowerCase()}. </>
            : 'Enter the total revenue in dollars to work out the ₹ revenue, or leave it empty and type the ₹ revenue above. '}
          {today?.rate && (
            <>
              Today's rate: ₹{today.rate} per $1 ({dayLabel(today.date)}, European Central Bank).
              {usd.rate !== String(today.rate) && (
                <> <button type="button" className="link" onClick={() => change(() => setUsd({ ...usd, rate: String(today.rate) }))}>Use today's rate</button></>
              )}
            </>
          )}
          {today?.error && <span className="warn-text">{today.error}</span>}
        </p>
      </fieldset>

      <div className="categories">
        {CATEGORIES.map((cat) => (
          <CategoryTable
            key={cat}
            category={cat}
            share={categoryPct[cat]}
            stats={stats[cat]}
            rows={rows[cat]}
            employees={employees}
            onChange={(key, field, value) => updateRow(cat, key, field, value)}
            onAdd={() => addRow(cat)}
            onRemove={(key) => removeRow(cat, key)}
            onEqual={() => splitEqually(cat)}
            dirty={dirty}
            busyPaid={busyPaid}
            onMarkPaid={markPaid}
            onUndoPaid={undoPaid}
          />
        ))}
      </div>

      <div className="period-foot">
        <p>
          Allocating <strong>{money(totalPaid)}</strong> of {money(revValue)}
          {revValue - totalPaid > 0.005 && <span className="warn-text"> ({money(revValue - totalPaid)} not assigned)</span>}
          {period.allocations.length > 0 && (
            <> · Paid <strong>{money(paidSum(period))}</strong>, pending <strong>{money(Math.max(0, period.paid - paidSum(period)))}</strong></>
          )}
        </p>
        <ErrorNote>{error}</ErrorNote>
        {notice && <p className="ok-text" role="status">{notice}</p>}
        <div className="actions">
          <button className="primary" onClick={save} disabled={saving || !dirty}>{saving ? 'Saving…' : 'Save period'}</button>
          {dirty && <button className="secondary" onClick={discard}>Discard changes</button>}
          {prev && prev.allocations.length > 0 && !anyPaid && (
            <button className="secondary" onClick={copyPrevious}>Copy contributors from {monthLabel(prev.start_month)}</button>
          )}
          {unpaidSaved.length > 0 && allDate === null && (
            <button className="secondary" disabled={dirty} title={dirty ? 'Save or discard your changes first' : undefined}
              onClick={() => setAllDate(todayIso())}>
              Mark all as paid
            </button>
          )}
        </div>
        {allDate !== null && (
          <div className="paid-all">
            <label>
              <span>Paid on</span>
              <input type="date" value={allDate} max={todayIso()} onChange={(e) => setAllDate(e.target.value)} />
            </label>
            <button className="primary" disabled={!allDate || busyPaid === 'all'} onClick={markAll}>
              {busyPaid === 'all' ? 'Saving…' : `Mark ${unpaidSaved.length} as paid`}
            </button>
            <button className="secondary" onClick={() => setAllDate(null)}>Cancel</button>
          </div>
        )}
      </div>
    </div>
  );
}

const paidSum = (period) => period.allocations.reduce((s, a) => s + (a.paid_on ? a.paid_amount : 0), 0);

function CategoryTable({ category, share, stats, rows, employees, onChange, onAdd, onRemove, onEqual, dirty, busyPaid, onMarkPaid, onUndoPaid }) {
  const [dateFor, setDateFor] = useState({}); // row key -> paid date while "Mark paid" is open
  const anyPaidHere = rows.some((r) => r.paid_on);
  const { pool, sum } = stats;
  const over = sum > 100.01;
  const full = Math.abs(sum - 100) < 0.01;
  const chosen = rows.map((r) => r.employee_id);

  return (
    <div className={`category cat-${category.toLowerCase()}`}>
      <div className="category-head">
        <h3>{category}</h3>
        <p className="muted small">{pct(share)} of revenue: {money(pool)}</p>
      </div>

      {rows.length === 0 ? (
        <p className="muted small">No contributors yet.</p>
      ) : (
        <table className="alloc">
          <thead>
            <tr><th scope="col">Employee</th><th scope="col">Weightage</th><th scope="col" className="num">Pay</th><th><span className="sr-only">Remove</span></th></tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const f = fractionOf(r);
              const pay = pool * (Number.isFinite(f) ? f : 0);
              const name = employees.find((e) => String(e.id) === r.employee_id)?.name || 'this contributor';
              const paid = Boolean(r.paid_on);
              const busy = busyPaid === `row-${r.id}`;
              return (
                <Fragment key={r.key}>
                <tr className={paid ? 'alloc-paid' : undefined}>
                  <td>
                    <select aria-label={`${category} employee`} value={r.employee_id} disabled={paid} onChange={(e) => onChange(r.key, 'employee_id', e.target.value)}>
                      <option value="">Choose…</option>
                      {employees
                        .filter((e) => (e.active || String(e.id) === r.employee_id))
                        .filter((e) => String(e.id) === r.employee_id || !chosen.includes(String(e.id)))
                        .map((e) => <option key={e.id} value={e.id}>{e.name}{e.active ? '' : ' (inactive)'}</option>)}
                    </select>
                  </td>
                  <td>
                    <span className="suffix-input small-input">
                      <input inputMode="decimal" aria-label={`${category} weightage`} value={r.weightage} readOnly={paid}
                        title={paid ? 'Paid: undo the paid mark to change it' : undefined}
                        onChange={(e) => onChange(r.key, 'weightage', e.target.value)} />
                      <span aria-hidden="true">%</span>
                    </span>
                  </td>
                  <td className="num">{money(paid ? r.paid_amount : pay)}</td>
                  <td>{!paid && <button className="remove" onClick={() => onRemove(r.key)} aria-label="Remove contributor">×</button>}</td>
                </tr>
                {/* Paid status sits on its own line under the contributor so the three category columns keep their width. */}
                <tr className={`alloc-status${paid ? ' alloc-paid' : ''}`}>
                  <td colSpan={4} className="paid-cell">
                    {paid ? (
                      <>
                        <span className="paid-tag">✓ Paid {dayLabel(r.paid_on)}</span>{' '}
                        <button className="link" disabled={busy} onClick={() => onUndoPaid(r, name)}>{busy ? '…' : 'Undo'}</button>
                      </>
                    ) : !r.id ? (
                      <span className="muted small">Save first</span>
                    ) : dateFor[r.key] !== undefined ? (
                      <span className="paid-pick">
                        <input type="date" aria-label={`Date ${name} was paid`} value={dateFor[r.key]} max={new Date().toLocaleDateString('en-CA')}
                          onChange={(e) => setDateFor({ ...dateFor, [r.key]: e.target.value })} />
                        <button className="link" disabled={!dateFor[r.key] || busy}
                          onClick={async () => { if (await onMarkPaid(r, dateFor[r.key])) setDateFor({ ...dateFor, [r.key]: undefined }); }}>
                          {busy ? 'Saving…' : 'Save'}
                        </button>
                        <button className="link" onClick={() => setDateFor({ ...dateFor, [r.key]: undefined })}>Cancel</button>
                      </span>
                    ) : (
                      <>
                        <span className="muted small">Unpaid</span>{' '}
                        <button className="link" disabled={dirty} title={dirty ? 'Save or discard your changes first' : undefined}
                          onClick={() => setDateFor({ ...dateFor, [r.key]: new Date().toLocaleDateString('en-CA') })}>
                          Mark paid
                        </button>
                      </>
                    )}
                  </td>
                </tr>
                </Fragment>
              );
            })}
          </tbody>
        </table>
      )}

      <div className="category-tools">
        <button className="link" onClick={onAdd}>Add contributor</button>
        {rows.length > 1 && !anyPaidHere && <button className="link" onClick={onEqual}>Split equally</button>}
      </div>

      <div className={`meter ${over ? 'over' : full ? 'full' : ''}`} aria-hidden="true">
        <span style={{ width: `${Math.min(sum, 100)}%` }} />
      </div>
      <p className={`small ${over ? 'error-text' : full || rows.length === 0 ? 'muted' : 'warn-text'}`}>
        {over ? `${+sum.toFixed(2)}% assigned. Reduce to 100% or less.`
          : full ? `100% assigned, ${money(stats.paid)}.`
          : rows.length === 0 ? `${money(pool)} not assigned.`
          : `${+sum.toFixed(2)}% assigned. ${money(pool - stats.paid)} not assigned.`}
      </p>
    </div>
  );
}
