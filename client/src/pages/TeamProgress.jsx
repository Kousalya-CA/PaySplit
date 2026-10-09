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
// for all months, one year, or a From–To range of months.
export default function TeamProgress({ customer }) {
  const [year, setYear] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [sort, setSort] = useState('closed');
  const [open, setOpen] = useState(() => new Set()); // employee ids (or 'others') whose items are shown
  const toggle = (key) => setOpen((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });
  const itemsFor = (key) => (data?.items || []).filter((w) => (key === 'others' ? w.employeeId === null : w.employeeId === key));

  const load = (refresh = false) => {
    setLoading(true);
    setError('');
    api.customers.work(customer.id, { from, to }, refresh)
      .then(setData)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  };
  // Reload when the month changes or the customer's Azure DevOps client name is edited.
  useEffect(() => { load(); }, [customer.id, customer.azdo_client, customer.name, from, to]);

  // Months with sprints, oldest first; the year limits the From and To lists to that year.
  const allMonths = (data?.months || []).map((m) => m.month).sort();
  const years = [...new Set(allMonths.map((m) => m.slice(0, 4)))].reverse();
  const choices = allMonths.filter((m) => !year || m.startsWith(year));
  const chooseYear = (y) => {
    setYear(y);
    const inYear = allMonths.filter((m) => m.startsWith(y));
    setFrom(y ? inYear[0] || '' : '');
    setTo(y ? inYear[inYear.length - 1] || '' : '');
  };
  const range = from || to
    ? from === to ? monthLabel(from) : `${from ? monthLabel(from) : 'the start'} to ${to ? monthLabel(to) : 'now'}`
    : 'all months';

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
              <span>Year</span>
              <select value={year} onChange={(e) => chooseYear(e.target.value)}>
                <option value="">All years</option>
                {years.map((y) => <option key={y} value={y}>{y}</option>)}
              </select>
            </label>
            <label className="wi-filter">
              <span>From</span>
              <select value={from} onChange={(e) => { setFrom(e.target.value); if (to && e.target.value > to) setTo(e.target.value); }}>
                <option value="">First month</option>
                {choices.map((m) => <option key={m} value={m}>{monthLabel(m)}</option>)}
              </select>
            </label>
            <label className="wi-filter">
              <span>To</span>
              <select value={to} onChange={(e) => { setTo(e.target.value); if (from && e.target.value && e.target.value < from) setFrom(e.target.value); }}>
                <option value="">Last month</option>
                {choices.map((m) => <option key={m} value={m}>{monthLabel(m)}</option>)}
              </select>
            </label>
            {(year || from || to) && <button className="link" onClick={() => chooseYear('')}>Clear</button>}
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
            <div className="empty"><p>No Tasks or Bugs for this customer in {range}.</p></div>
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
                    <Row key={r.id} rank={i + 1} row={r} open={open.has(r.id)} onToggle={() => toggle(r.id)} items={itemsFor(r.id)}
                      name={<a href={`#/employees/${r.id}`}>{r.name}</a>}
                      split={r.inSplit ? 'Yes' : <span className="warn-text" title="Works on this customer but isn't in any of its splits">No ⚠</span>} />
                  ))}
                  {data.others && (
                    <Row row={data.others} className="wi-other" open={open.has('others')} onToggle={() => toggle('others')} items={itemsFor('others')}
                      name={<span title={data.others.names.join(', ')}>Not in PaySplit <small className="muted">({data.others.names.join(', ')})</small></span>}
                      split="–" />
                  )}
                </tbody>
              </table>
            </div>
          )}
          <p className="muted small">
            Showing {range}. Click ▸ next to a name to see the work items behind the numbers and each one's Client.
            Counts and hours are each person's own Tasks and Bugs. Tasks and Bugs with no Client of their own count for
            the customer when their User Story or Issue does. Removed items aren't counted.
            {data.fetchedAt && ` Read from Azure DevOps at ${new Date(data.fetchedAt).toLocaleTimeString()}.`}
          </p>
        </>
      )}
    </section>
  );
}

function Row({ rank, row, name, split, className = '', open, onToggle, items }) {
  const done = percent(row.completed, row.completed + row.remaining);
  return (
    <>
    <tr className={className}>
      <td className="num">{rank ?? ''}</td>
      <th scope="row">
        <button className="link tp-toggle" aria-expanded={open} onClick={onToggle} title={open ? 'Hide work items' : 'Show work items'}>
          {open ? '▾' : '▸'}<span className="sr-only">{open ? 'Hide' : 'Show'} work items</span>
        </button>{' '}
        {name}
      </th>
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
    {open && (
      <tr className="tp-items">
        <td />
        <td colSpan={10}>
          <table className="grid list wi-table">
            <thead>
              <tr>
                <th scope="col">Month</th>
                <th scope="col">Type</th>
                <th scope="col" className="wi-title">Title</th>
                <th scope="col">Client</th>
                <th scope="col">Status</th>
                <th scope="col">Assigned to</th>
                <th scope="col" className="num">Estimated</th>
                <th scope="col" className="num">Completed</th>
                <th scope="col" className="num">Remaining</th>
              </tr>
            </thead>
            <tbody>
              {items.map((w) => (
                <tr key={w.id}>
                  <td className="small">{monthLabel(w.month)}</td>
                  <td>{w.type}</td>
                  <th scope="row" className="wi-title" title={`${w.id} ${w.title}`}>
                    <a href={w.url} target="_blank" rel="noreferrer">{w.id}</a> {w.title}
                  </th>
                  <td>
                    {w.client || (w.via
                      ? <span className="muted" title={`${w.via.id} ${w.via.title}`}>{w.via.client} <small>(from #{w.via.id})</small></span>
                      : <span className="muted">–</span>)}
                  </td>
                  <td>{w.state}</td>
                  <td>{w.assignedTo || <span className="muted">Unassigned</span>}</td>
                  <td className="num">{hours(w.original)}</td>
                  <td className="num">{hours(w.completed)}</td>
                  <td className="num">{hours(w.remaining)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </td>
      </tr>
    )}
    </>
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
