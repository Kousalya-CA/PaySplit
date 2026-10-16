import { Fragment, useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { money, moneyIn, currencySymbol, periodLabel, paidIn, pct, toPctInput, parseNum, monthLabel, dayLabel, addMonths } from '../format.js';
import { ErrorNote } from '../components/common.jsx';

const CATEGORIES = ['Direct', 'Support', 'Others'];
let nextKey = 1;

// Contributors are kept per month: key 0 is the whole payment (one time, and every Monthly payment);
// for a custom payment over several months, key 1 is the first payout month, 2 the next, and so on.
const emptyRows = () => Object.fromEntries(CATEGORIES.map((cat) => [cat, []]));
const rowsFrom = (allocations) => {
  const out = {};
  for (const a of allocations) {
    const k = a.part ?? 0;
    out[k] ||= emptyRows();
    out[k][a.category].push({
      key: nextKey++, id: a.id, employee_id: String(a.employee_id), weightage: toPctInput(a.weightage), exact: a.weightage,
      paid_on: a.paid_on, paid_amount: a.paid_amount, locked: a.locked,
    });
  }
  return out;
};
// A fresh copy of one month's contributors (new rows, nothing paid).
const copyRows = (set) => Object.fromEntries(CATEGORIES.map((cat) => [cat, (set?.[cat] || [])
  .map((r) => ({ key: nextKey++, employee_id: r.employee_id, weightage: r.weightage, exact: r.exact }))]));
// Make the months match the payment: n months for a custom payment (a new month starts as a copy of
// the month before, or of the whole payment), or just the whole payment.
const fitRows = (rows, n) => {
  if (n <= 1) return { 0: rows[0] || (rows[1] ? copyRows(rows[1]) : emptyRows()) };
  const out = {};
  for (let k = 1; k <= n; k++) out[k] = rows[k] || copyRows(out[k - 1] || rows[0]);
  return out;
};

// Today as YYYY-MM-DD in local time, the default paid date.
const todayIso = () => new Date().toLocaleDateString('en-CA');

// The payment: its payment date (month it's paid), one time or custom, and for custom the months the
// employees' share is split over (From = the payment date and 12 months by default).
const payoutFrom = (p) => {
  const payMonth = p.pay_month || p.start_month;
  const from = p.pay_from || payMonth;
  return { pay_month: payMonth, type: p.payout_type === 'custom' ? 'custom' : 'once', from, to: p.pay_to || addMonths(from, 11) };
};
const monthsBetween = (a, b) => {
  const [y1, m1] = a.split('-').map(Number);
  const [y2, m2] = b.split('-').map(Number);
  return (y2 - y1) * 12 + (m2 - m1) + 1;
};

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
// One month's part of the pool: an equal part (to the paisa/cent), the last month taking the
// rounding; the whole pool for the whole payment (same as the server).
const monthPool = (pool, n, k) => {
  if (!k || n <= 1) return pool;
  const each = round2(pool / n);
  return k >= n ? round2(pool - each * (n - 1)) : each;
};

// Today's rate from a currency to INR, fetched once per page load and shared by every period.
const ratePromises = new Map();
const todaysRate = (currency) => {
  if (!ratePromises.has(currency)) {
    ratePromises.set(currency, api.exchangeRate(currency).catch((err) => { ratePromises.delete(currency); throw err; }));
  }
  return ratePromises.get(currency);
};

// Edits one period: the employees' share plus the contributors in Direct, Support and Others.
// Pay = Employees' share (or the month's part of it) x Category % x Weightage %, recalculated as you type.
export default function PeriodEditor({ customer, period, prev, employees, onSaved, onDirtyChange }) {
  const label = periodLabel(period);
  const cur = customer.currency;
  const canConvert = cur !== 'INR';
  const monthlyCustomer = customer.frequency === 'Monthly';
  const [rev, setRev] = useState(() => revenueFrom(period));
  const [convert, setConvert] = useState(() => canConvert && period.fx_rate != null);
  const [payout, setPayout] = useState(() => payoutFrom(period));
  const [today, setToday] = useState(null); // { rate, date } or { error }
  const [rowsByPart, setRowsByPart] = useState(() => fitRows(rowsFrom(period.allocations), period.parts || 1));
  const [activePart, setActivePart] = useState(1);
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
    setPayout(payoutFrom(period));
    setRowsByPart(fitRows(rowsFrom(period.allocations), period.parts || 1));
  }, [period]);

  // Once anyone in this payment is paid, the employees' share and the payment details are locked
  // (until every paid mark is undone).
  const anyPaid = period.allocations.some((a) => a.locked);
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
  // Mark everyone in one month as paid (one request per contributor; the last result is shown).
  const markMonth = (k, paidOn, list) => paidAction(`month-${k}`, async () => {
    let updated = null;
    for (const a of list) updated = await api.allocations.markPaid(a.id, paidOn);
    return updated;
  }, `Marked ${list.length} as paid.`);
  // What "Mark all as paid" would mark: unpaid contributors whose month has arrived.
  const nowMonth = todayIso().slice(0, 7);
  const unpaidSaved = period.allocations.filter((a) => !a.paid_on && (!a.month || a.month <= nowMonth));
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

  // Custom payment (Yearly and Three Years): the pool is split equally over the payout months, and
  // each month has its own contributors. Changing the payment date (or switching to custom) starts
  // the months there and runs 12 months.
  const custom = !monthlyCustomer && payout.type === 'custom';
  const rangeOk = custom && payout.from && payout.to && payout.to >= payout.from;
  const partCount = rangeOk ? monthsBetween(payout.from, payout.to) : 1;
  const multi = partCount > 1;
  const months = multi ? Array.from({ length: partCount }, (_, i) => addMonths(payout.from, i)) : [];
  const activeKey = multi ? Math.min(Math.max(activePart, 1), partCount) : 0;
  const setPayoutAndMonths = (next) => change(() => {
    setPayout(next);
    const ok = next.type === 'custom' && !monthlyCustomer && next.from && next.to && next.to >= next.from;
    setRowsByPart((r) => fitRows(r, ok ? monthsBetween(next.from, next.to) : 1));
  });
  const setPayDate = (m) => setPayoutAndMonths({ ...payout, pay_month: m, ...(m ? { from: m, to: addMonths(m, 11) } : {}) });
  const setType = (t) => setPayoutAndMonths({ ...payout, type: t, from: payout.pay_month, to: addMonths(payout.pay_month, 11) });

  // The revenue share covering this period. With none, every category gets 0%.
  const share = period.share;
  const categoryPct = share
    ? { Direct: share.direct_pct, Support: share.support_pct, Others: share.others_pct }
    : { Direct: 0, Support: 0, Others: 0 };

  const rows = rowsByPart[activeKey] || emptyRows();
  const statsFor = (set, poolHere) => Object.fromEntries(CATEGORIES.map((cat) => {
    const catPool = poolHere * categoryPct[cat];
    const sum = (set?.[cat] || []).reduce((s, r) => s + (Number.isFinite(fractionOf(r)) ? fractionOf(r) * 100 : 0), 0);
    return [cat, { pool: catPool, sum, paid: catPool * sum / 100 }];
  }));
  const activePool = monthPool(revValue, partCount, activeKey);
  const stats = useMemo(() => statsFor(rows, activePool), [rows, activePool, customer]);
  // Allocated across every month.
  const keys = multi ? months.map((_, i) => i + 1) : [0];
  const allocatedFor = (k) => {
    const st = statsFor(rowsByPart[k], monthPool(revValue, partCount, k));
    return CATEGORIES.reduce((s, c) => s + st[c].paid, 0);
  };
  const totalPaid = keys.reduce((s, k) => s + allocatedFor(k), 0);

  const setActiveRows = (fn) => change(() => setRowsByPart((all) => ({ ...all, [activeKey]: fn(all[activeKey] || emptyRows()) })));
  const updateRow = (cat, key, field, value) => setActiveRows((r) => ({
    ...r, [cat]: r[cat].map((row) => (row.key !== key ? row
      : field === 'weightage' ? { ...row, weightage: value, exact: null } : { ...row, [field]: value })),
  }));
  const addRow = (cat) => setActiveRows((r) => ({ ...r, [cat]: [...r[cat], { key: nextKey++, employee_id: '', weightage: '', exact: null }] }));
  const removeRow = (cat, key) => setActiveRows((r) => ({ ...r, [cat]: r[cat].filter((row) => row.key !== key) }));
  const splitEqually = (cat) => setActiveRows((r) => {
    const n = r[cat].length;
    return { ...r, [cat]: r[cat].map((row) => ({ ...row, weightage: toPctInput(1 / n), exact: 1 / n })) };
  });
  // Copy this month's contributors to every month that has nobody paid yet.
  const monthLocked = (k) => CATEGORIES.some((c) => (rowsByPart[k]?.[c] || []).some((r) => r.locked));
  const copyToAll = () => change(() => setRowsByPart((all) => {
    const out = { ...all };
    for (const k of keys) if (k !== activeKey && !monthLocked(k)) out[k] = copyRows(all[activeKey]);
    return out;
  }));

  const copyPrevious = () => change(() => {
    const prevRows = rowsFrom(prev.allocations);
    const source = prevRows[0] || prevRows[1] || emptyRows();
    setRowsByPart(multi ? Object.fromEntries(keys.map((k) => [k, copyRows(source)])) : { 0: copyRows(source) });
  });
  const discard = () => {
    setRev(revenueFrom(period));
    setConvert(canConvert && period.fx_rate != null);
    setPayout(payoutFrom(period));
    setRowsByPart(fitRows(rowsFrom(period.allocations), period.parts || 1));
    setDirty(false);
    setError('');
  };

  const save = async () => {
    setError('');
    if (!blank) {
      if (!Number.isFinite(amountNum) || amountNum < 0) return setError(`Enter the employees' share in ${cur} as a number, for example 1200.`);
      if (converting && (!Number.isFinite(rateNum) || rateNum <= 0)) return setError(`Enter the ${cur} to INR rate, for example 83.5, or remove the conversion.`);
    }
    if (!payout.pay_month) return setError('Choose the payment date.');
    if (custom && !rangeOk) return setError('Choose the From and To months for the custom payment (To on or after From).');
    const allocations = [];
    for (const k of keys) {
      const where = k ? `${monthLabel(months[k - 1])}: ` : '';
      const set = rowsByPart[k] || emptyRows();
      const st = statsFor(set, 0);
      for (const cat of CATEGORIES) {
        for (const r of set[cat]) {
          if (!r.employee_id) return setError(`${where}${cat}: choose an employee for every row, or remove the empty row.`);
          const f = fractionOf(r);
          if (!Number.isFinite(f) || f < 0 || f > 1) return setError(`${where}${cat}: every weightage must be a number between 0 and 100.`);
          allocations.push({ part: k || null, category: cat, employee_id: Number(r.employee_id), weightage: f });
        }
        if (st[cat].sum > 100.01) return setError(`${where}${cat} weightages add up to ${+st[cat].sum.toFixed(2)}%. Reduce them to 100% or less.`);
      }
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
        pay_month: payout.pay_month,
        payout_type: custom ? 'custom' : 'once',
        pay_from: custom ? payout.from : null,
        pay_to: custom ? payout.to : null,
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

  const wording = monthlyCustomer
    ? { note: 'This month\'s split. It can be different every month.', revenue: `Employees' share for ${monthLabel(period.start_month)}` }
    : {
      note: `One payment for ${label}. ${paidIn(period) || `Paid in ${monthLabel(period.start_month)}`}.`,
      revenue: 'Employees\' share for this payment',
    };
  // The saved contributors of one month (for paid marks).
  const savedIn = (k) => period.allocations.filter((a) => (a.part ?? 0) === k);
  const activeMonth = multi ? months[activeKey - 1] : null;

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
          🔒 The employees' share and payment details are locked because someone in this payment is marked as paid. Undo every paid mark to change them.
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

      <fieldset className="usd-calc payout" disabled={anyPaid}>
        <legend>Payment</legend>
        <div className="row">
          <label className="month-field">
            <span>Payment date</span>
            <input type="month" value={payout.pay_month} required onChange={(e) => setPayDate(e.target.value)} />
          </label>
          {!monthlyCustomer && (
            <label>
              <span>Payment type</span>
              <select value={payout.type} onChange={(e) => setType(e.target.value)}>
                <option value="once">One time</option>
                <option value="custom">Custom (split over months)</option>
              </select>
            </label>
          )}
          {custom && (
            <>
              <label className="month-field">
                <span>From</span>
                <input type="month" value={payout.from} required onChange={(e) => setPayoutAndMonths({ ...payout, from: e.target.value })} />
              </label>
              <label className="month-field">
                <span>To</span>
                <input type="month" value={payout.to} min={payout.from} required onChange={(e) => setPayoutAndMonths({ ...payout, to: e.target.value })} />
              </label>
            </>
          )}
        </div>
        <p className="muted small">
          {!custom
            ? `Paid once, in ${payout.pay_month ? monthLabel(payout.pay_month) : 'the payment month'}, with one set of weightages.`
            : rangeOk
              ? <>Split equally into <strong>{partCount} month{partCount === 1 ? '' : 's'}</strong>, {monthLabel(payout.from)} to {monthLabel(payout.to)}{revValue > 0 && <>: about {fmt(revValue / partCount)} a month</>}. Each month has its own weightages; choose the month below.</>
              : 'Choose From and To (To on or after From).'}
        </p>
      </fieldset>

      {multi && (
        <div className="month-pick">
          <h3 id={`months-${period.id}`}>Weightages for each month</h3>
          <div className="period-tabs" role="tablist" aria-labelledby={`months-${period.id}`}>
            {months.map((m, i) => {
              const k = i + 1;
              const set = rowsByPart[k] || emptyRows();
              const count = CATEGORIES.reduce((s, c) => s + set[c].length, 0);
              const saved = savedIn(k);
              const allPaid = saved.length > 0 && saved.every((a) => a.paid_on);
              return (
                <button key={m} type="button" role="tab" aria-selected={k === activeKey}
                  className={`period-tab ${count > 0 ? 'has-revenue' : ''}`} onClick={() => setActivePart(k)}>
                  <span>{monthLabel(m)}</span>
                  <small>{fmt(monthPool(revValue, partCount, k))}</small>
                  <small className={allPaid ? 'ok-text' : count ? '' : 'warn-text'}>{allPaid ? '✓ Paid' : count ? `${count} contributor${count === 1 ? '' : 's'}` : 'No contributors'}</small>
                </button>
              );
            })}
          </div>
          <p className="muted small">
            Showing <strong>{monthLabel(activeMonth)}</strong>: {fmt(activePool)} for employees this month.{' '}
            {keys.length > 1 && <button type="button" className="link" onClick={copyToAll}>Copy {monthLabel(activeMonth)}'s contributors to every other month</button>}
          </p>
        </div>
      )}

      <div className="categories">
        {CATEGORIES.map((cat) => (
          <CategoryTable
            key={`${activeKey}-${cat}`}
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
            dueMonth={activeMonth && activeMonth > nowMonth ? activeMonth : null}
            fmt={fmt}
          />
        ))}
      </div>

      {multi && (
        <MonthOverview months={months} pools={keys.map((k) => monthPool(revValue, partCount, k))} allocated={keys.map(allocatedFor)}
          savedIn={savedIn} fmt={fmt} dirty={dirty} busy={busyPaid} nowMonth={nowMonth}
          onSelect={(k) => setActivePart(k)} onMarkMonth={markMonth} />
      )}

      <div className="period-foot">
        <p>
          Allocating <strong>{fmt(totalPaid)}</strong> of {fmt(revValue)}{multi ? ` across ${partCount} months` : ''}
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
              {multi ? 'Mark all due months paid' : 'Mark all as paid'}
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

function CategoryTable({ category, share, stats, rows, employees, onChange, onAdd, onRemove, onEqual, dirty, busyPaid, onMarkPaid, onUndoPaid, dueMonth, fmt }) {
  const [dateFor, setDateFor] = useState({}); // row key -> paid date while "Mark paid" is open
  const anyPaidHere = rows.some((r) => r.locked);
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
              const locked = Boolean(r.locked);
              const busy = busyPaid === `row-${r.id}`;
              return (
                <Fragment key={r.key}>
                <tr className={locked ? 'alloc-paid' : undefined}>
                  <td>
                    <select aria-label={`${category} employee`} value={r.employee_id} disabled={locked} onChange={(e) => onChange(r.key, 'employee_id', e.target.value)}>
                      <option value="">Choose…</option>
                      {employees
                        .filter((e) => (e.active || String(e.id) === r.employee_id))
                        .filter((e) => String(e.id) === r.employee_id || !chosen.includes(String(e.id)))
                        .map((e) => <option key={e.id} value={e.id}>{e.name}{e.active ? '' : ' (inactive)'}</option>)}
                    </select>
                  </td>
                  <td>
                    <span className="suffix-input small-input">
                      <input inputMode="decimal" aria-label={`${category} weightage`} value={r.weightage} readOnly={locked}
                        title={paid ? 'Paid: undo the paid mark to change it' : undefined}
                        onChange={(e) => onChange(r.key, 'weightage', e.target.value)} />
                      <span aria-hidden="true">%</span>
                    </span>
                  </td>
                  <td className="num">{fmt(paid ? r.paid_amount : pay)}</td>
                  <td>{!locked && <button className="remove" onClick={() => onRemove(r.key)} aria-label="Remove contributor">×</button>}</td>
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
                    ) : dueMonth ? (
                      <span className="muted small">Unpaid · due {monthLabel(dueMonth)}</span>
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

// A custom payment's months at a glance: each month's part of the employees' share, how much is
// assigned, how many are paid, and Mark paid for everyone in that month (on the date chosen above
// the table, once the month has arrived). Clicking a month opens its weightages.
function MonthOverview({ months, pools, allocated, savedIn, fmt, dirty, busy, nowMonth, onSelect, onMarkMonth }) {
  const [paidOn, setPaidOn] = useState(todayIso());
  return (
    <section className="monthly-split">
      <div className="monthly-split-head">
        <h3>All months</h3>
        <p className="muted small">Each month gets an equal part of the employees' share and its own weightages.</p>
        <label className="paid-on">
          <span>Paid on</span>
          <input type="date" value={paidOn} max={todayIso()} onChange={(e) => setPaidOn(e.target.value)} />
        </label>
      </div>
      <div className="table-wrap">
        <table className="grid list">
          <thead>
            <tr>
              <th scope="col">Month</th>
              <th scope="col" className="num">Employees' share</th>
              <th scope="col" className="num">Assigned</th>
              <th scope="col">Paid</th>
              <th><span className="sr-only">Mark paid</span></th>
            </tr>
          </thead>
          <tbody>
            {months.map((m, i) => {
              const k = i + 1;
              const saved = savedIn(k);
              const unpaid = saved.filter((a) => !a.paid_on);
              const paidCount = saved.length - unpaid.length;
              return (
                <tr key={m}>
                  <th scope="row"><button type="button" className="link" onClick={() => onSelect(k)}>{monthLabel(m)}</button></th>
                  <td className="num">{fmt(pools[i])}</td>
                  <td className={`num ${Math.abs(pools[i] - allocated[i]) > 0.005 ? 'warn-text' : ''}`}>{fmt(allocated[i])}</td>
                  <td>{saved.length === 0 ? <span className="muted small">No contributors saved</span>
                    : paidCount === saved.length ? <span className="paid-tag">✓ All {saved.length} paid</span>
                      : <span className="muted small">{paidCount} of {saved.length} paid</span>}</td>
                  <td>
                    {unpaid.length > 0 && (m > nowMonth
                      ? <span className="muted small">Due {monthLabel(m)}</span>
                      : (
                        <button type="button" className="link" disabled={dirty || !paidOn || busy !== ''}
                          title={dirty ? 'Save or discard your changes first' : undefined}
                          onClick={() => onMarkMonth(k, paidOn, unpaid)}>
                          {busy === `month-${k}` ? 'Saving…' : `Mark ${unpaid.length} paid`}
                        </button>
                      ))}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
