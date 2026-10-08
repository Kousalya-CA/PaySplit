import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Loading, ErrorNote } from '../components/common.jsx';
import { dayLabel, monthLabel } from '../format.js';

const hours = (n) => (n ? `${+n.toFixed(2)}` : '–');
const thisMonth = () => new Date().toISOString().slice(0, 7);

// One employee's Azure DevOps work: pick a year, then a month (a monthly sprint), then one table for
// every area path in that month: User Stories and Issues with their child Tasks and Bugs below them.
export default function EmployeeDetail({ id }) {
  const [overview, setOverview] = useState(null);
  const [year, setYear] = useState(null);
  const [month, setMonth] = useState(null);
  const [table, setTable] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  // The list of months with sprints; open the current month if it has one, otherwise the newest.
  useEffect(() => {
    api.employees.tasks(id)
      .then((data) => {
        setOverview(data);
        const months = data.months || [];
        const start = months.find((m) => m.month === thisMonth()) || months[0];
        if (start) { setYear(yearOf(start.month)); setMonth(start.month); }
      })
      .catch((e) => setError(e.message));
  }, [id]);

  const loadMonth = (m) => {
    setLoading(true);
    setError('');
    setTable(null);
    api.employees.tasks(id, m)
      .then(setTable)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  };
  useEffect(() => { if (month) loadMonth(month); }, [month]);

  if (!overview) return error ? <ErrorNote>{error}</ErrorNote> : <Loading />;
  const emp = overview.employee;
  const months = overview.months || [];
  const years = [...new Set(months.map((m) => yearOf(m.month)))];
  const inYear = months.filter((m) => yearOf(m.month) === year);

  const chooseYear = (y) => {
    setYear(y);
    const first = months.find((m) => yearOf(m.month) === y);
    if (first) setMonth(first.month);
  };

  return (
    <section>
      <a className="back" href="#/employees">Employees</a>
      <div className="page-head">
        <div>
          <h1>{emp.name}</h1>
          <p className="muted">{emp.employee_code ? `${emp.employee_code} · ` : ''}{emp.email || 'No email yet'} · {emp.type}{emp.active ? '' : ' · Inactive'}</p>
        </div>
        {month && !loading && <button className="secondary" onClick={() => loadMonth(month)}>Reload</button>}
      </div>

      <h2>Azure DevOps work</h2>
      {overview.message ? <div className="empty"><p>{overview.message}</p></div> : (
        <>
          <div className="period-tabs" role="tablist" aria-label="Year">
            {years.map((y) => (
              <button key={y} role="tab" aria-selected={y === year} className="period-tab" onClick={() => chooseYear(y)}>
                <span>{y === 'undated' ? 'No dates' : y}</span>
              </button>
            ))}
          </div>
          <div className="period-tabs" role="tablist" aria-label="Month">
            {inYear.map((m) => (
              <button key={m.month} role="tab" aria-selected={m.month === month} className="period-tab" onClick={() => setMonth(m.month)}>
                <span>{m.month === 'undated' ? 'Sprints without dates' : monthLabel(m.month)}</span>
                <small>{[...new Set(m.sprints.map((sp) => sp.name))].join(', ')}</small>
              </button>
            ))}
          </div>

          <ErrorNote>{error}</ErrorNote>
          {loading && <Loading />}
          {table && <MonthTable data={table} />}
        </>
      )}
    </section>
  );
}

const yearOf = (month) => (month === 'undated' ? 'undated' : month.slice(0, 4));

function MonthTable({ data }) {
  const { rows, sprints, clientField } = data;
  const sprintNote = sprints.map((sp) => `${sp.area}: ${sp.name}${sp.start_date ? ` (${dayLabel(sp.start_date)} to ${dayLabel(sp.finish_date)})` : ''}`);
  return (
    <div className="wi-month">
      <p className="muted small">{sprintNote.join(' · ')}</p>
      {rows.length === 0 ? (
        <div className="empty"><p>No work items assigned in these sprints.</p></div>
      ) : (
        <div className="table-wrap">
          <table className="grid list wi-table">
            <thead>
              <tr>
                <th scope="col">Area path</th>
                {clientField && <th scope="col">Client</th>}
                <th scope="col">Type</th>
                <th scope="col">Title</th>
                <th scope="col">Status</th>
                <th scope="col">Assigned to</th>
                <th scope="col" className="num">Original</th>
                <th scope="col" className="num">Completed</th>
                <th scope="col" className="num">Remaining</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={`${r.parentId ?? 'top'}-${r.id}`} className={`${r.level ? 'wi-child' : 'wi-parent'}${r.mine ? '' : ' wi-other'}`}>
                  <td className="small" title={r.areaPath}>{r.area}</td>
                  {clientField && <td>{r.client}</td>}
                  <td>{r.type}</td>
                  <th scope="row">
                    <a href={r.url} target="_blank" rel="noreferrer">{r.id}</a> {r.title}
                  </th>
                  <td>{r.state}</td>
                  <td>{r.assignedTo || <span className="muted">Unassigned</span>}</td>
                  <td className="num">{hours(r.original)}</td>
                  <td className="num">{hours(r.completed)}</td>
                  <td className="num">{hours(r.remaining)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row" colSpan={clientField ? 6 : 5}>
                  Their {data.counts.mine} task{data.counts.mine === 1 ? '' : 's'} and bugs (hours)
                </th>
                <td className="num">{hours(data.hours.original)}</td>
                <td className="num">{hours(data.hours.completed)}</td>
                <td className="num">{hours(data.hours.remaining)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
      <p className="muted small">
        User Stories and Issues are listed with this employee's own Tasks and Bugs below them. A greyed User Story or Issue is assigned to someone else.
        {!clientField && ' No field called "Client" was found in Azure DevOps, so the Client column is hidden.'}
      </p>
    </div>
  );
}
