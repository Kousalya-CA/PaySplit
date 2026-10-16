import { Fragment, useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { money, moneyIn, currencySymbol, periodLabel, paidIn, pct, toPctInput, parseNum, monthLabel, dayLabel } from '../format.js';
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

// Only the employees' share is entered (in the customer's currency), not the total revenue. For a
// customer not in INR it can be converted to INR with a rate. Payments saved earlier as revenue x
// share % show that share (amount x share_pct).
const round2 = (n) => Math.round(n * 100) / 100;
const savedShare = (p) => (p.amount != null ? round2(p.amount * (p.share_pct ?? 1)) : null);
const revenueFrom = (p) => ({
  amount: savedShare(p) != null ? String(savedShare(p)) : '',
  rate: p.fx_rate != null ? String(p.fx_rate) : '',
});

// Today's rate from a currency to INR, fetched once per page load and shared by every period.
const ratePromises = new Map();
const todaysRate = (currency) => {
  if (!ratePromises.has(currency)) {
    ratePromises.set(currency, api.exchangeRate(currency).catch((err) => { ratePromises.delete(currency); throw err; }));
  }
  return ratePromises.get(currency);
};

// Edits one period: the employees' share plus the contributors in Direct, Support and Others.
// Pay = Employees' share x Category % x Weightage %, recalculated as you type.
export default function PeriodEditor({ customer, period, prev, employees, onSaved, onDirtyChange }) {
  const label = periodLabel(period);
  const cur = customer.currency;
  const canConvert = cur !== 'INR';
  const [rev, setRev] = useState(() => revenueFrom(period));
  const [convert, setConvert] = useState(() => canConvert && period.fx_rate != null);
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
    setRev(revenueFrom(period));
    setConvert(canConvert && period.fx_rate != null);
    setRows(rowsFrom(period.allocations));
  }, [period]);

  // Once anyone in this payment is paid, the employees' share is locked (until every paid mark is undone).
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

  const change = (fn) => { fn(); setDirty(true); setNotice(''); };

  // While converting, offer today's rate, and fill it in if no rate is typed yet.
  useEffect(() => {
    if (!convert || !canConvert) return undefined;
    let live = true;
    todaysRate(cur)
      .then((info) => { if (!live) return; setToday(info); setRev((r) => (r.rate ? r : { ...r, rate: String(info.rate) })); })
      .catch((err) => { if (live) setToday({ error: err.message }); });
    return () => { live = false; };
  }, [convert, cur]);
  const startConvert = () => change(() => setConvert(true));
  const stopConvert = () => change(() => { setConvert(false); setRev((r) => ({ ...r, rate: '' })); });

  // The employees' pool: the share entered (x rate when converting), in the pay currency.
  const converting = canConvert && convert;
  const payCur = converting ? 'INR' : cur;
  const fmt = (n) => money(n, payCur);
  const blank = rev.amount.trim() === '';
  const [amountNum, rateNum] = [parseNum(rev.amount), parseNum(rev.rate)];
  const pool = blank ? 0 : round2(amountNum * (converting ? rateNum : 1));
  const revValue = Number.isFinite(pool) ? pool : 0;
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
    setRev(revenueFrom(period));
    setConvert(canConvert && period.fx_rate != null);
    setRows(rowsFrom(period.allocations));
    setDirty(false);
    setError('');
  };

  const save = async () => {
    setError('');
    if (!blank) {
      if (!Number.isFinite(amountNum) || amountNum < 0) return setError(`Enter the employees' share in ${cur} as a number, for example 1200.`);
      if (converting && (!Number.isFinite(rateNum) || rateNum <= 0)) return setError(`Enter the ${cur} to INR rate, for example 83.5, or remove the conversion.`);
    }
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
        // An unchanged share keeps how it was saved (older payments: revenue x share %), so the
        // paid lock sees no change; a new or changed share is saved as the share itself.
        ...(blank ? { amount: null, share_pct: null }
          : savedShare(period) != null && Math.abs(savedShare(period) - amountNum) < 0.005
            ? { amount: period.amount, share_pct: period.share_pct }
            : { amount: amountNum, share_pct: 1 }),
        fx_rate: converting ? rateNum : null,
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
    ? { note: 'This month\'s split. It can be different every month.', revenue: `Employees' share for ${monthLabel(period.start_month)}` }
    : {
      note: `One payment and one split for ${label}. ${paidIn(period) || `Paid in ${monthLabel(period.start_month)}`}.`,
      revenue: 'Employees\' share for this payment',
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
              No revenue share covers {label}, so pay is 0. Add a share type for it in Edit customer,
              or clear its amount and split so it's removed the next time the shares are saved.
            </p>
          )}
        </div>
        <label className="revenue">
          <span>{wording.revenue} ({cur}){anyPaid && ' 🔒'}</span>
          <span className={`prefix-input${currencySymbol(cur).length > 1 ? ' wide' : ''}`}>
            <span aria-hidden="true">{currencySymbol(cur)}</span>
            <input inputMode="decimal" readOnly={anyPaid} value={rev.amount} placeholder="0"
              onChange={(e) => change(() => setRev({ ...rev, amount: e.target.value }))} />
          </span>
        </label>
      </div>

      {anyPaid && (
        <p className="muted small">
          🔒 The employees' share is locked because someone in this payment is marked as paid. Undo every paid mark to change it.
        </p>
      )}
      <fieldset className="usd-calc" disabled={anyPaid}>
        <legend className="sr-only">Employees' share</legend>
        <div className="row">
          {converting && (
            <label>
              <span>1 {cur} in INR</span>
              <span className="prefix-input">
                <span aria-hidden="true">₹</span>
                <input inputMode="decimal" value={rev.rate} placeholder="Rate" onChange={(e) => change(() => setRev({ ...rev, rate: e.target.value }))} />
              </span>
            </label>
          )}
        </div>
        <p className="muted small">
          {blank ? `Enter the amount to share between the employees below, in ${cur}. `
            : Number.isFinite(pool)
              ? converting
                ? <>{moneyIn(amountNum, cur)} × ₹{rev.rate} = <strong>{fmt(pool)}</strong> for employees, paid in INR. </>
                : <><strong>{fmt(pool)}</strong> for employees, paid in {cur}. </>
              : 'Check the number above. '}
          {canConvert && !converting && <button type="button" className="link" onClick={startConvert}>Convert to INR</button>}
          {converting && (
            <>
              {today?.rate && (
                <>
                  Today's rate: ₹{today.rate} per 1 {cur} ({dayLabel(today.date)}, European Central Bank).
                  {rev.rate !== String(today.rate) && (
                    <> <button type="button" className="link" onClick={() => change(() => setRev({ ...rev, rate: String(today.rate) }))}>Use today's rate</button></>
                  )}{' '}
                </>
              )}
              {today?.error && <span className="warn-text">{today.error} </span>}
              <button type="button" className="link" onClick={stopConvert}>Remove conversion</button>
            </>
          )}
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
            fmt={fmt}
          />
        ))}
      </div>

      <div className="period-foot">
        <p>
          Allocating <strong>{fmt(totalPaid)}</strong> of {fmt(revValue)}
          {revValue - totalPaid > 0.005 && <span className="warn-text"> ({fmt(revValue - totalPaid)} not assigned)</span>}
          {period.allocations.length > 0 && (
            <> · Paid <strong>{money(paidSum(period), period.currency)}</strong>, pending <strong>{money(Math.max(0, period.paid - paidSum(period)), period.currency)}</strong></>
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

function CategoryTable({ category, share, stats, rows, employees, onChange, onAdd, onRemove, onEqual, dirty, busyPaid, onMarkPaid, onUndoPaid, fmt }) {
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
        <p className="muted small">{pct(share)} of the employees' share: {fmt(pool)}</p>
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
                  <td className="num">{fmt(paid ? r.paid_amount : pay)}</td>
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
          : full ? `100% assigned, ${fmt(stats.paid)}.`
          : rows.length === 0 ? `${fmt(pool)} not assigned.`
          : `${+sum.toFixed(2)}% assigned. ${fmt(pool - stats.paid)} not assigned.`}
      </p>
    </div>
  );
}
