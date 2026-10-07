import { Fragment, useEffect, useState } from 'react';
import { api } from '../api.js';
import { money, monthLabel } from '../format.js';
import { Loading, ErrorNote, Money } from '../components/common.jsx';

// Same as the "Monthly Summary" sheet: pay per employee per month, then yearly totals.
// An Employee login gets only their own row (the server filters it) and no company-wide figures.
export default function SummaryPage({ isAdmin }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => { api.summary().then(setData).catch((e) => setError(e.message)); }, []);

  if (error) return <ErrorNote>{error}</ErrorNote>;
  if (!data) return <Loading />;

  const { months, years, employees, monthTotals, yearTotals, totals } = data;
  const unallocated = data.self ? 0 : totals.revenue - totals.paid;

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
      </div>

      {data.self ? (
        <dl className="figures">
          <div><dt>Total pay</dt><dd>{money(totals.paid)}</dd></div>
        </dl>
      ) : (
        <dl className="figures">
          <div><dt>Revenue entered</dt><dd>{money(totals.revenue)}</dd></div>
          <div><dt>Paid to employees</dt><dd>{money(totals.paid)}</dd></div>
          <div>
            <dt>Not assigned to anyone</dt>
            <dd className={unallocated > 0.005 ? 'warn-text' : ''}>{money(unallocated)}</dd>
          </div>
        </dl>
      )}
      {unallocated > 0.005 && (
        <p className="muted small">
          Some revenue isn't paid out because a category's weightages add up to less than 100%.
          Open the customer to see which period.
        </p>
      )}

      <h2>Pay by month</h2>
      <div className="table-wrap">
        <table className="grid">
          <thead>
            <tr>
              <th scope="col">Employee</th>
              {months.map((m) => <th scope="col" key={m} className="num">{monthLabel(m)}</th>)}
              <th scope="col" className="num">Total</th>
            </tr>
          </thead>
          <EmployeeRows employees={employees} columns={months} by="byMonth" linkCustomers={isAdmin} />
          <tfoot>
            <tr>
              <th scope="row">Total</th>
              {months.map((m) => <td key={m}><Money value={monthTotals[m]} /></td>)}
              <td><Money value={totals.paid} /></td>
            </tr>
          </tfoot>
        </table>
      </div>

      <h2>Pay by year</h2>
      <div className="table-wrap">
        <table className="grid">
          <thead>
            <tr>
              <th scope="col">Employee</th>
              {years.map((y) => <th scope="col" key={y} className="num">{y}</th>)}
              <th scope="col" className="num">Total</th>
            </tr>
          </thead>
          <EmployeeRows employees={employees} columns={years} by="byYear" linkCustomers={isAdmin} />
          <tfoot>
            <tr>
              <th scope="row">Total</th>
              {years.map((y) => <td key={y}><Money value={yearTotals[y]} /></td>)}
              <td><Money value={totals.paid} /></td>
            </tr>
          </tfoot>
        </table>
      </div>
      <p className="muted small">A Yearly or Three Years customer's pay is counted in the month it's paid, the same as the Excel workbook.</p>
    </section>
  );
}

// One row per employee; clicking the name drills down into their pay by customer.
function EmployeeRows({ employees, columns, by, linkCustomers }) {
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
              {columns.map((c) => <td key={c}><Money value={e[by][c]} /></td>)}
              <td className="strong"><Money value={e.total} /></td>
            </tr>
            {expanded && e.customers.map((c) => (
              <tr key={`${e.id}-${c.id}`} className="drill-row">
                <th scope="row">{linkCustomers ? <a href={`#/customers/${c.id}`}>{c.name}</a> : c.name}</th>
                {columns.map((col) => <td key={col}><Money value={c[by][col]} /></td>)}
                <td><Money value={c.total} /></td>
              </tr>
            ))}
          </Fragment>
        );
      })}
    </tbody>
  );
}
