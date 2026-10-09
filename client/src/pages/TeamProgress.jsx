import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Loading, ErrorNote } from '../components/common.jsx';
import { monthLabel } from '../format.js';

const hours = (n) => (n ? `${+n.toFixed(2)} h` : '–');
const percent = (part, whole) => (whole ? Math.round((part / whole) * 100) : null);
const closedOf = (r) => r.tasks.closed + r.bugs.closed;

// Columns the table can be sorted by: label, value to sort on (highest first).
const SORTS = {
  closed: ['Closed', closedOf],
  tasks: ['Tasks', (r) => r.tasks.closed],
  bugs: ['Bugs', (r) => r.bugs.closed],
  original: ['Estimated', (r) => r.original],
  completed: ['Completed', (r) => r.completed],
  remaining: ['Remaining', (r) => r.remaining],
  done: ['% done', (r) => percent(r.completed, r.completed + r.remaining) ?? -1],
};

const monthRange = (months) => {
  if (!months.length) return '–';
  const first = monthLabel(months[0]);
  return months.length === 1 ? first : `${first} – ${monthLabel(months[months.length - 1])} (${months.length})`;
};

// How each employee is doing on a customer's work in Azure DevOps (matched by the Client field),
// for all months or one month's sprints.
export default function TeamProgress({ customer }) {
  const [month, setMonth] = useState('');
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [sort, setSort] = useState('closed');

  const load = (refresh = false) => {
    setLoading(true);
    setError('');
    api.customers.work(customer.id, month, refresh)
      .then(setData)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  };
  // Reload when the month changes or the customer's Azure DevOps client name is edited.
  useEffect(() => { load(); }, [customer.id, customer.azdo_client, customer.name, month]);

  const people = data?.people ? [...data.people].sort((a, b) => {
    const by = SORTS[sort][1];
    return by(b) - by(a) || closedOf(b) - closedOf(a) || a.name.localeCompare(b.name);
  }) : [];

  return (
    <section className="team-progress" aria-labelledby="team-progress-label">
      <div className="page-head">
        <div>
          <h2 id="team-progress-label">Team progress</h2>
          {data?.clientNames && (
            <p className="muted small">
              Azure DevOps work where Client is {data.clientNames.map((n, i) => <span key={n}>{i ? ' or ' : ''}<strong>{n}</strong></span>)}.
              {' '}Change this under Edit customer.
            </p>
          )}
        </div>
        {data?.months?.length > 0 && (
          <div className="row tp-tools">
            <label className="wi-filter">
              <span>Month</span>
              <select value={month} onChange={(e) => setMonth(e.target.value)}>
                <option value="">All months</option>
                {data.months.map((m) => <option key={m.month} value={m.month}>{monthLabel(m.month)}</option>)}
              </select>
            </label>
            <button className="secondary" disabled={loading} onClick={() => load(true)}>{loading ? 'Loading…' : 'Reload'}</button>
          </div>
        )}
      </div>

      <ErrorNote>{error}</ErrorNote>
      {!data ? (loading && <Loading />) : data.message ? (
        <div className="empty"><p>{data.message}</p></div>
      ) : (
        <>
          <Summary summary={data.summary} />
          {people.length === 0 && !data.others ? (
            <div className="empty"><p>No Tasks or Bugs for this customer {month ? `in ${monthLabel(month)}` : 'in the configured sprints'}.</p></div>
          ) : (
            <div className="table-wrap">
              <table className="grid list tp-table">
                <thead>
                  <tr>
                    <th scope="col" className="num">#</th>
                    <th scope="col">Employee</th>
                    {Object.entries(SORTS).map(([key, [label]]) => (
                      <th key={key} scope="col" className="num" aria-sort={sort === key ? 'descending' : 'none'}>
                        <button className={`sort ${sort === key ? 'on' : ''}`} onClick={() => setSort(key)}>
                          {key === 'tasks' || key === 'bugs' ? `${label} closed / total` : label}{sort === key ? ' ▼' : ''}
                        </button>
                      </th>
                    ))}
                    <th scope="col">Months</th>
                    <th scope="col">In pay split</th>
                  </tr>
                </thead>
                <tbody>
                  {people.map((r, i) => (
                    <Row key={r.id} rank={i + 1} row={r}
                      name={<a href={`#/employees/${r.id}`}>{r.name}</a>}
                      split={r.inSplit ? 'Yes' : <span className="warn-text" title="Works on this customer but isn't in any of its splits">No ⚠</span>} />
                  ))}
                  {data.others && (
                    <Row row={data.others} className="wi-other"
                      name={<span title={data.others.names.join(', ')}>Not in PaySplit <small className="muted">({data.others.names.join(', ')})</small></span>}
                      split="–" />
                  )}
                </tbody>
              </table>
            </div>
          )}
          <p className="muted small">
            Counts and hours are each person's own Tasks and Bugs. Tasks and Bugs with no Client of their own count for
            the customer when their User Story or Issue does. Removed items aren't counted.
            {data.fetchedAt && ` Read from Azure DevOps at ${new Date(data.fetchedAt).toLocaleTimeString()}.`}
          </p>
        </>
      )}
    </section>
  );
}

function Row({ rank, row, name, split, className = '' }) {
  const done = percent(row.completed, row.completed + row.remaining);
  return (
    <tr className={className}>
      <td className="num">{rank ?? ''}</td>
      <th scope="row">{name}</th>
      <td className="num"><strong>{closedOf(row)}</strong></td>
      <td className="num">{row.tasks.closed} / {row.tasks.total}</td>
      <td className="num">{row.bugs.closed} / {row.bugs.total}</td>
      <td className="num">{hours(row.original)}</td>
      <td className="num">{hours(row.completed)}</td>
      <td className="num">{hours(row.remaining)}</td>
      <td className="num">{done === null ? '–' : `${done}%`}</td>
      <td className="small">{monthRange(row.months)}</td>
      <td>{split}</td>
    </tr>
  );
}

function Summary({ summary }) {
  const cards = [
    ['User Stories / Issues', summary.parents],
    ['Tasks', summary.tasks],
    ['Bugs', summary.bugs],
  ];
  const done = percent(summary.completed, summary.completed + summary.remaining);
  return (
    <div className="wi-summary">
      {cards.map(([label, g]) => {
        const p = percent(g.closed, g.total) ?? 0;
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
        <span className="muted small">Effort (Tasks and Bugs)</span>
        <dl className="wi-hours">
          <dt>Estimated</dt><dd>{hours(summary.original)}</dd>
          <dt>Completed</dt><dd>{hours(summary.completed)}</dd>
          <dt>Remaining</dt><dd>{hours(summary.remaining)}</dd>
        </dl>
        <div className="wi-bar" role="img" aria-label={`${done ?? 0}% complete`}><span style={{ width: `${done ?? 0}%` }} /></div>
        <span className="muted small">{done === null ? 'No hours logged' : `${done}% complete`}</span>
      </div>
    </div>
  );
}
