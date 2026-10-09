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

const CHILD_TYPES = ['Task', 'Bug'];
const NO_CLIENT = '__none__';

// Keep only the rows for one client. A Task or Bug with no client of its own counts as its parent's
// client, and a parent stays when it or any of its listed children matches.
function filterByClient(rows, client) {
  if (!client) return rows;
  const matches = (value) => (client === NO_CLIENT ? !value : value === client);
  const parentClient = new Map(rows.filter((r) => !r.level).map((r) => [r.id, r.client]));
  const childOk = (r) => matches(r.client || parentClient.get(r.parentId));
  const keepParent = new Set(rows.filter((r) => r.level && childOk(r)).map((r) => r.parentId));
  return rows.filter((r) => (r.level ? childOk(r) : matches(r.client) || keepParent.has(r.id)));
}

const isClosed = (r) => r.stateCategory === 'Completed' || r.stateCategory === 'Resolved';

// Counts and hours for the rows shown (so the Client filter applies). Removed items aren't counted.
// Parents include ones assigned to others; tasks, bugs and hours are the employee's own only.
function MonthSummary({ rows }) {
  const live = rows.filter((r) => r.stateCategory !== 'Removed');
  const group = (list) => ({ total: list.length, closed: list.filter(isClosed).length });
  const theirs = live.filter((r) => r.mine && CHILD_TYPES.includes(r.type));
  const cards = [
    ['User Stories / Issues', group(live.filter((r) => !CHILD_TYPES.includes(r.type)))],
    ['Tasks', group(theirs.filter((r) => r.type === 'Task'))],
    ['Bugs', group(theirs.filter((r) => r.type === 'Bug'))],
  ];
  const sum = (k) => theirs.reduce((n, r) => n + (r[k] || 0), 0);
  const done = sum('completed');
  const left = sum('remaining');
  const pct = done + left ? Math.round((done / (done + left)) * 100) : null;

  return (
    <div className="wi-summary">
      {cards.map(([label, g]) => {
        const p = g.total ? Math.round((g.closed / g.total) * 100) : 0;
        return (
          <div key={label} className="wi-card">
            <span className="muted small">{label}</span>
            <strong className="wi-big">{g.total}</strong>
            <span className="small">{g.closed} closed · {g.total - g.closed} open</span>
            <div className="wi-bar" role="img" aria-label={`${p}% closed`}><span style={{ width: `${p}%` }} /></div>
            <span className="muted small">{g.total ? `${p}% closed` : 'None'}</span>
          </div>
        );
      })}
      <div className="wi-card">
        <span className="muted small">Effort (their tasks and bugs)</span>
        <dl className="wi-hours">
          <dt>Estimated</dt><dd>{hours(sum('original'))} h</dd>
          <dt>Completed</dt><dd>{hours(done)} h</dd>
          <dt>Remaining</dt><dd>{hours(left)} h</dd>
        </dl>
        <div className="wi-bar" role="img" aria-label={`${pct ?? 0}% complete`}><span style={{ width: `${pct ?? 0}%` }} /></div>
        <span className="muted small">{pct === null ? 'No hours logged' : `${pct}% complete`}</span>
      </div>
    </div>
  );
}

function MonthTable({ data }) {
  const { sprints, clientField } = data;
  const [client, setClient] = useState('');
  const clients = [...new Set(data.rows.map((r) => r.client).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const hasBlank = data.rows.some((r) => !r.client);
  const rows = filterByClient(data.rows, clients.includes(client) || client === NO_CLIENT ? client : '');

  // The employee's own hours over the rows shown: their tasks and bugs, not the parents.
  const theirs = rows.filter((r) => r.mine && CHILD_TYPES.includes(r.type));
  const total = (k) => theirs.reduce((n, r) => n + (r[k] || 0), 0);

  const sprintNote = sprints.map((sp) => `${sp.area}: ${sp.name}${sp.start_date ? ` (${dayLabel(sp.start_date)} to ${dayLabel(sp.finish_date)})` : ''}`);
  return (
    <div className="wi-month">
      <p className="muted small">{sprintNote.join(' · ')}</p>
      {clientField && clients.length > 0 && (
        <label className="wi-filter">
          <span>Client</span>
          <select value={client} onChange={(e) => setClient(e.target.value)}>
            <option value="">All clients</option>
            {clients.map((c) => <option key={c} value={c}>{c}</option>)}
            {hasBlank && <option value={NO_CLIENT}>No client</option>}
          </select>
        </label>
      )}
      {rows.length > 0 && <MonthSummary rows={rows} />}
      {data.rows.length === 0 ? (
        <div className="empty"><p>No work items assigned in these sprints.</p></div>
      ) : rows.length === 0 ? (
        <div className="empty"><p>No work items for this client.</p></div>
      ) : (
        <div className="table-wrap">
          <table className="grid list wi-table">
            <thead>
              <tr>
                <th scope="col">Area path</th>
                {clientField && <th scope="col">Client</th>}
                <th scope="col">Type</th>
                <th scope="col" className="wi-title">Title</th>
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
                  <th scope="row" className="wi-title" title={`${r.id} ${r.title}`}>
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
                  Their {theirs.length} task{theirs.length === 1 ? '' : 's'} and bugs (hours)
                </th>
                <td className="num">{hours(total('original'))}</td>
                <td className="num">{hours(total('completed'))}</td>
                <td className="num">{hours(total('remaining'))}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
      <p className="muted small">
        User Stories and Issues are listed with this employee's own Tasks and Bugs below them. A greyed User Story or Issue is assigned to someone else.
        Hover over a title to see all of it.
        {!clientField && ' No field called "Client" was found in Azure DevOps, so the Client column is hidden.'}
      </p>
    </div>
  );
}
