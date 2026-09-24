import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { money, monthLabel } from '../format.js';
import { Loading, ErrorNote, Money } from '../components/common.jsx';

// Same as the "Monthly Summary" sheet: pay per employee per month, then yearly totals.
export default function SummaryPage() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => { api.summary().then(setData).catch((e) => setError(e.message)); }, []);

  if (error) return <ErrorNote>{error}</ErrorNote>;
  if (!data) return <Loading />;

  const { months, years, employees, monthTotals, yearTotals, totals } = data;
  const unallocated = totals.revenue - totals.paid;

  if (!months.length) {
    return (
      <section>
        <h1>Summary</h1>
        <div className="empty">
          <p>No customers yet. Add a customer and assign contributors, and each employee's pay will appear here month by month.</p>
          <a className="primary" href="#/customers">Add a customer</a>
        </div>
      </section>
    );
  }

  return (
    <section>
      <div className="page-head">
        <h1>Summary</h1>
      </div>

      <dl className="figures">
        <div><dt>Revenue entered</dt><dd>{money(totals.revenue)}</dd></div>
        <div><dt>Paid to employees</dt><dd>{money(totals.paid)}</dd></div>
        <div>
          <dt>Not assigned to anyone</dt>
          <dd className={unallocated > 0.005 ? 'warn-text' : ''}>{money(unallocated)}</dd>
        </div>
      </dl>
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
          <tbody>
            {employees.map((e) => (
              <tr key={e.id}>
                <th scope="row">{e.name}{!e.active && <span className="tag">Inactive</span>}</th>
                {months.map((m) => <td key={m}><Money value={e.byMonth[m]} /></td>)}
                <td className="strong"><Money value={e.total} /></td>
              </tr>
            ))}
          </tbody>
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
          <tbody>
            {employees.map((e) => (
              <tr key={e.id}>
                <th scope="row">{e.name}</th>
                {years.map((y) => <td key={y}><Money value={e.byYear[y]} /></td>)}
                <td className="strong"><Money value={e.total} /></td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row">Total</th>
              {years.map((y) => <td key={y}><Money value={yearTotals[y]} /></td>)}
              <td><Money value={totals.paid} /></td>
            </tr>
          </tfoot>
        </table>
      </div>
      <p className="muted small">A yearly customer's pay is counted in the month the year starts, the same as the Excel workbook.</p>
    </section>
  );
}
