import { Fragment, useEffect, useState } from 'react';
import { api } from '../api.js';
import { moneyIn, currencySymbol, monthLabel, quarterLabel, payoutStatusLabel, dayLabel } from '../format.js';
import { Loading, ErrorNote, Money as MoneyIn } from '../components/common.jsx';

// Same as the "Monthly Summary" sheet: pay per employee per month, then yearly totals.
// Allocated is the pay worked out from the splits; Paid is what's been marked as paid; Pending is the rest.
// An Employee login gets only their own row (the server filters it) and no company-wide figures.
// Pay in different currencies is never added together: the page shows one currency at a time.
export default function SummaryPage({ isAdmin }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [view, setView] = useState('allocated');
  const [currency, setCurrency] = useState('');

  useEffect(() => { api.summary(currency).then(setData).catch((e) => setError(e.message)); }, [currency]);
  // An employee's own quarterly statements.
  const [statements, setStatements] = useState([]);
  useEffect(() => { if (!isAdmin) api.payouts.mine().then(setStatements).catch(() => {}); }, [isAdmin]);

  if (error) return <ErrorNote>{error}</ErrorNote>;
  if (!data) return <Loading />;

  const { months, years, employees, monthTotals, yearTotals, paidMonthTotals, paidYearTotals, totals } = data;
  const cur = data.currency;
  const Money = ({ value }) => <MoneyIn value={value} currency={cur} />;
  const money = (n) => moneyIn(n, cur);
  const unallocated = data.self ? 0 : totals.revenue - totals.allocated;
  const pending = totals.allocated - totals.paid;

  // The figure shown in the tables for the chosen view.
  const pick = {
    allocated: (all) => all,
    paid: (all, paid) => paid,
    pending: (all, paid) => (all || 0) - (paid || 0),
  }[view];
  const cell = (obj, by, col) => pick(obj[by][col], obj[`paid${by[0].toUpperCase()}${by.slice(1)}`][col]);
  const rowTotal = (obj) => pick(obj.total, obj.paidTotal);
  const VIEW_LABEL = { allocated: 'Allocated', paid: 'Paid', pending: 'Pending' };

  if (data.message || !months.length) {
    return (
      <section>
        <h1>Summary</h1>
        <div className="empty">
          {data.message ? <p>{data.message}</p> : data.self ? (
            <p>No pay has been recorded for you yet.</p>
          ) : (
            <>
              <p>No customers yet. Add a customer and assign contributors, and each employee's pay will appear here month by month.</p>
              {isAdmin && <a className="primary" href="#/customers">Add a customer</a>}
            </>
          )}
        </div>
      </section>
    );
  }

  return (
    <section>
      <div className="page-head">
        <h1>{data.self ? 'My pay' : 'Summary'}</h1>
        {data.currencies.length > 1 && (
          <div className="seg seg-top" role="radiogroup" aria-label="Currency">
            {data.currencies.map((c) => (
              <button key={c} role="radio" aria-checked={c === cur} className={c === cur ? 'on' : ''} onClick={() => setCurrency(c)}>
                {currencySymbol(c) === c ? c : `${currencySymbol(c)} ${c}`}
              </button>
            ))}
          </div>
        )}
      </div>
      {data.currencies.length > 1 && (
        <p className="muted small">Showing pay in {cur}. Pay in other currencies isn't added in; switch currency above to see it.</p>
      )}

      <dl className="figures">
        {!data.self && <div><dt>Pool for employees</dt><dd>{money(totals.revenue)}</dd></div>}
        <div><dt>{data.self ? 'My allocated pay' : 'Allocated to employees'}</dt><dd>{money(totals.allocated)}</dd></div>
        <div><dt>Paid</dt><dd className="ok-text">{money(totals.paid)}</dd></div>
        <div><dt>Pending</dt><dd className={pending > 0.005 ? 'warn-text' : ''}>{money(pending)}</dd></div>
        {totals.approved > 0.005 && <div><dt>Approved, not paid</dt><dd>{money(totals.approved)}</dd></div>}
        {!data.self && (
          <div>
            <dt>Not assigned to anyone</dt>
            <dd className={unallocated > 0.005 ? 'warn-text' : ''}>{money(unallocated)}</dd>
          </div>
        )}
      </dl>
      {unallocated > 0.005 && (
        <p className="muted small">
          Some revenue isn't paid out because a category's weightages add up to less than 100%.
          Open the customer to see which period.
        </p>
      )}

      {data.self && statements.length > 0 && <Statements statements={statements} />}

      <div className="seg" role="radiogroup" aria-label="Show">
        {Object.entries(VIEW_LABEL).map(([key, label]) => (
          <button key={key} role="radio" aria-checked={view === key} className={view === key ? 'on' : ''} onClick={() => setView(key)}>
            {label}
          </button>
        ))}
      </div>

      <h2>{VIEW_LABEL[view]} pay by month</h2>
      <div className="table-wrap">
        <table className="grid">
          <thead>
            <tr>
              <th scope="col">Employee</th>
              {months.map((m) => <th scope="col" key={m} className="num">{monthLabel(m)}</th>)}
              <th scope="col" className="num">Total</th>
            </tr>
          </thead>
          <EmployeeRows currency={cur} employees={employees} columns={months} by="byMonth" linkCustomers={isAdmin} cell={cell} rowTotal={rowTotal} />
          <tfoot>
            <tr>
              <th scope="row">Total</th>
              {months.map((m) => <td key={m}><Money value={pick(monthTotals[m], paidMonthTotals[m])} /></td>)}
              <td><Money value={pick(totals.allocated, totals.paid)} /></td>
            </tr>
          </tfoot>
        </table>
      </div>

      <h2>{VIEW_LABEL[view]} pay by year</h2>
      <div className="table-wrap">
        <table className="grid">
          <thead>
            <tr>
              <th scope="col">Employee</th>
              {years.map((y) => <th scope="col" key={y} className="num">{y}</th>)}
              <th scope="col" className="num">Total</th>
            </tr>
          </thead>
          <EmployeeRows currency={cur} employees={employees} columns={years} by="byYear" linkCustomers={isAdmin} cell={cell} rowTotal={rowTotal} />
          <tfoot>
            <tr>
              <th scope="row">Total</th>
              {years.map((y) => <td key={y}><Money value={pick(yearTotals[y], paidYearTotals[y])} /></td>)}
              <td><Money value={pick(totals.allocated, totals.paid)} /></td>
            </tr>
          </tfoot>
        </table>
      </div>
      <p className="muted small">
        Pay is counted in its payment date's month, or in each month when a payment is split over months (Custom).
        Paid and Pending are counted in the month the pay is for, not the date it was paid.
      </p>
    </section>
  );
}

// One row per employee; clicking the name drills down into their pay by customer.
function EmployeeRows({ employees, columns, by, linkCustomers, cell, rowTotal, currency }) {
  const Money = ({ value }) => <MoneyIn value={value} currency={currency} />;
  const [open, setOpen] = useState(() => new Set());
  const toggle = (id) => setOpen((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  return (
    <tbody>
      {employees.map((e) => {
        const expanded = open.has(e.id);
        const canExpand = e.customers.length > 0;
        return (
          <Fragment key={e.id}>
            <tr className={expanded ? 'drill-open' : undefined}>
              <th scope="row">
                {canExpand ? (
                  <button
                    type="button"
                    className="drill"
                    aria-expanded={expanded}
                    onClick={() => toggle(e.id)}
                    title={expanded ? 'Hide customer split' : 'Show customer split'}
                  >
                    <span className="drill-caret" aria-hidden="true">▸</span>{e.name}
                  </button>
                ) : e.name}
                {!e.active && <span className="tag">Inactive</span>}
              </th>
              {columns.map((c) => <td key={c}><Money value={cell(e, by, c)} /></td>)}
              <td className="strong"><Money value={rowTotal(e)} /></td>
            </tr>
            {expanded && e.customers.map((c) => (
              <tr key={`${e.id}-${c.id}`} className="drill-row">
                <th scope="row">{linkCustomers ? <a href={`#/customers/${c.id}`}>{c.name}</a> : c.name}</th>
                {columns.map((col) => <td key={col}><Money value={cell(c, by, col)} /></td>)}
                <td><Money value={rowTotal(c)} /></td>
              </tr>
            ))}
          </Fragment>
        );
      })}
    </tbody>
  );
}

// An employee's quarterly payout statements: amount, status, the comment written for them, and where
// the pay came from.
function Statements({ statements }) {
  const [open, setOpen] = useState(null);
  return (
    <section className="statements">
      <h2>Quarterly statements</h2>
      <div className="table-wrap">
        <table className="grid list">
          <thead>
            <tr>
              <th scope="col">Quarter</th><th scope="col">Pay month</th><th scope="col" className="num">Amount</th>
              <th scope="col">Status</th><th scope="col">Comment</th>
            </tr>
          </thead>
          <tbody>
            {statements.map((s) => (
              <Fragment key={s.id}>
                <tr>
                  <th scope="row">
                    <button type="button" className="drill" aria-expanded={open === s.id} onClick={() => setOpen(open === s.id ? null : s.id)}>
                      <span className="drill-caret" aria-hidden="true">▸</span>{quarterLabel(s.quarter)} ({monthLabel(s.from)} to {monthLabel(s.to)})
                    </button>
                  </th>
                  <td>{monthLabel(s.pay_month)}</td>
                  <td className="num strong">{moneyIn(s.amount, s.currency)}</td>
                  <td>{s.status === 'paid' ? <span className="paid-tag">✓ Paid {dayLabel(s.paid_on)}</span> : payoutStatusLabel[s.status]}</td>
                  <td className="small">{s.comment || <span className="muted">–</span>}</td>
                </tr>
                {open === s.id && s.items.map((it) => (
                  <tr key={`${s.id}-${it.allocation_id}-${it.part}`} className="drill-row">
                    <td colSpan={2}>{monthLabel(it.part_month)} · {it.customer} · {it.category}</td>
                    <td className="num">{moneyIn(it.amount, s.currency)}</td>
                    <td colSpan={2} />
                  </tr>
                ))}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
