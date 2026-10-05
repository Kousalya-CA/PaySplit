import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { money, periodLabel, pct, toPctInput, parseNum, monthLabel } from '../format.js';
import { ErrorNote } from '../components/common.jsx';

const CATEGORIES = ['Direct', 'Support', 'Others'];
let nextKey = 1;

const rowsFrom = (allocations) => Object.fromEntries(CATEGORIES.map((cat) => [
  cat,
  allocations.filter((a) => a.category === cat)
    .map((a) => ({ key: nextKey++, employee_id: String(a.employee_id), weightage: toPctInput(a.weightage), exact: a.weightage })),
]));

// Weightage as a fraction: the exact stored value if the row wasn't retyped, otherwise what was typed.
const fractionOf = (row) => (row.exact != null ? row.exact : parseNum(row.weightage) / 100);

// Edits one period: revenue plus the contributors in Direct, Support and Others.
// Pay = Revenue x Category % x Weightage %, recalculated as you type.
export default function PeriodEditor({ customer, period, prev, employees, onSaved, onDirtyChange }) {
  const label = periodLabel(period.start_month, customer.frequency);
  const [revenue, setRevenue] = useState(String(period.revenue));
  const [rows, setRows] = useState(() => rowsFrom(period.allocations));
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => { onDirtyChange(dirty); }, [dirty, onDirtyChange]);

  const change = (fn) => { fn(); setDirty(true); setNotice(''); };

  const rev = parseNum(revenue);
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
  const discard = () => { setRevenue(String(period.revenue)); setRows(rowsFrom(period.allocations)); setDirty(false); setError(''); };

  const save = async () => {
    setError('');
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
      const updated = await api.periods.save(period.id, { revenue: rev, allocations });
      setDirty(false);
      setNotice(`Saved ${label}.`);
      onSaved(updated);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const removePeriod = async () => {
    if (!window.confirm(`Delete the ${label} period and its split?`)) return;
    try {
      const updated = await api.periods.remove(period.id);
      setDirty(false);
      onSaved(updated);
    } catch (err) { setError(err.message); }
  };

  const totalPaid = CATEGORIES.reduce((s, c) => s + stats[c].paid, 0);
  const wording = {
    'Three Years': { note: 'One split for the whole 36 months.', revenue: 'Revenue for the 3 years' },
    Yearly: { note: 'One split for the whole year.', revenue: 'Annual revenue' },
  }[customer.frequency] || {
    note: 'This month\'s split. It can be different every month.',
    revenue: `Revenue for ${monthLabel(period.start_month)}`,
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
              No revenue share covers {label}, so pay is ₹0. Add a share type for it in Edit customer.
            </p>
          )}
        </div>
        <label className="revenue">
          <span>{wording.revenue}</span>
          <span className="prefix-input">
            <span aria-hidden="true">₹</span>
            <input inputMode="decimal" value={revenue} onChange={(e) => change(() => setRevenue(e.target.value))} />
          </span>
        </label>
      </div>

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
          />
        ))}
      </div>

      <div className="period-foot">
        <p>
          Paying out <strong>{money(totalPaid)}</strong> of {money(revValue)}
          {revValue - totalPaid > 0.005 && <span className="warn-text"> ({money(revValue - totalPaid)} not assigned)</span>}
        </p>
        <ErrorNote>{error}</ErrorNote>
        {notice && <p className="ok-text" role="status">{notice}</p>}
        <div className="actions">
          <button className="primary" onClick={save} disabled={saving || !dirty}>{saving ? 'Saving…' : 'Save period'}</button>
          {dirty && <button className="secondary" onClick={discard}>Discard changes</button>}
          {prev && prev.allocations.length > 0 && (
            <button className="secondary" onClick={copyPrevious}>Copy contributors from {monthLabel(prev.start_month)}</button>
          )}
          <button className="danger-link" onClick={removePeriod}>Delete period</button>
        </div>
      </div>
    </div>
  );
}

function CategoryTable({ category, share, stats, rows, employees, onChange, onAdd, onRemove, onEqual }) {
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
              return (
                <tr key={r.key}>
                  <td>
                    <select aria-label={`${category} employee`} value={r.employee_id} onChange={(e) => onChange(r.key, 'employee_id', e.target.value)}>
                      <option value="">Choose…</option>
                      {employees
                        .filter((e) => (e.active || String(e.id) === r.employee_id))
                        .filter((e) => String(e.id) === r.employee_id || !chosen.includes(String(e.id)))
                        .map((e) => <option key={e.id} value={e.id}>{e.name}{e.active ? '' : ' (inactive)'}</option>)}
                    </select>
                  </td>
                  <td>
                    <span className="suffix-input small-input">
                      <input inputMode="decimal" aria-label={`${category} weightage`} value={r.weightage}
                        onChange={(e) => onChange(r.key, 'weightage', e.target.value)} />
                      <span aria-hidden="true">%</span>
                    </span>
                  </td>
                  <td className="num">{money(pay)}</td>
                  <td><button className="remove" onClick={() => onRemove(r.key)} aria-label="Remove contributor">×</button></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <div className="category-tools">
        <button className="link" onClick={onAdd}>Add contributor</button>
        {rows.length > 1 && <button className="link" onClick={onEqual}>Split equally</button>}
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
