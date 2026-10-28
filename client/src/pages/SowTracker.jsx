import { Fragment, useEffect, useState } from 'react';
import { api } from '../api.js';
import { Loading, ErrorNote } from '../components/common.jsx';
import { monthLabel } from '../format.js';

const hours = (n) => (n ? `${+n.toFixed(2)}` : '–');
const percent = (part, whole) => (whole ? Math.round((part / whole) * 100) : 0);

// SOW Tracker (everyone): pick a sprint, then see its User Stories and Issues grouped by their Bucket
// (in the picklist's order), each with its Tasks and Bugs. Read from Azure DevOps; nothing is changed.
export default function SowTracker() {
  const [month, setMonth] = useState('');
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [team, setTeam] = useState('');
  const [client, setClient] = useState('');
  const [search, setSearch] = useState('');
  const [openBuckets, setOpenBuckets] = useState(() => new Set());
  const [openItems, setOpenItems] = useState(() => new Set());

  const load = (m, refresh = false) => {
    setLoading(true);
    setError('');
    api.sow(m, refresh)
      .then((d) => {
        setData(d);
        setMonth(d.month || '');
        setOpenBuckets(new Set());
        setOpenItems(new Set());
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  };
  useEffect(() => { load(''); }, []);

  if (!data) return error ? <ErrorNote>{error}</ErrorNote> : <Loading />;

  const toggle = (setter) => (key) => setter((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });
  const toggleBucket = toggle(setOpenBuckets);
  const toggleItem = toggle(setOpenItems);

  // Filters: team (area), client, and words in the ID, title, assignee or a task's title.
  const all = (data.buckets || []).flatMap((b) => b.items);
  const teams = [...new Set(all.map((i) => i.area))].sort();
  const clients = [...new Set(all.map((i) => i.client).filter(Boolean))].sort();
  const words = search.toLowerCase().split(/\s+/).filter(Boolean);
  const matches = (i) => (!team || i.area === team) && (!client || i.client === client)
    && words.every((w) => [i.id, i.title, i.assignedTo, ...i.children.map((c) => `${c.id} ${c.title} ${c.assignedTo}`)].join(' ').toLowerCase().includes(w));
  const buckets = (data.buckets || []).map((b) => ({ ...b, items: b.items.filter(matches) })).filter((b) => b.items.length);

  const stats = (items) => {
    const kids = items.flatMap((i) => i.children);
    const sum = (k) => items.reduce((n, i) => n + i.hours[k], 0);
    return {
      items: items.length,
      closed: items.filter((i) => i.closed).length,
      tasks: kids.length,
      tasksClosed: kids.filter((c) => c.closed).length,
      original: sum('original'),
      completed: sum('completed'),
      remaining: sum('remaining'),
    };
  };
  const total = stats(buckets.flatMap((b) => b.items));
  const years = [...new Set(data.months.map((m) => (m.month === 'undated' ? 'undated' : m.month.slice(0, 4))))];
  const year = month === 'undated' ? 'undated' : month.slice(0, 4);

  const exportCsv = () => {
    const header = ['Bucket', 'Level', 'ID', 'Type', 'Title', 'State', 'Team', 'Client', 'Assigned to', 'Original', 'Completed', 'Remaining', 'Link'];
    const lines = [];
    for (const b of buckets) {
      for (const i of b.items) {
        lines.push([b.name || 'No bucket', 'Item', i.id, i.type, i.title, i.state, i.area, i.client, i.assignedTo, i.hours.original, i.hours.completed, i.hours.remaining, i.url]);
        for (const c of i.children) lines.push([b.name || 'No bucket', 'Task/Bug', c.id, c.type, c.title, c.state, c.area, c.client, c.assignedTo, c.original, c.completed, c.remaining, c.url]);
      }
    }
    const csv = [header, ...lines].map((l) => l.map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: `sow-${month}.csv` });
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <section>
      <div className="page-head">
        <div>
          <h1>SOW Tracker</h1>
          <p className="muted">Pick a sprint to see its User Stories and Issues grouped by Bucket, with their Tasks and Bugs. Read from Azure DevOps.</p>
        </div>
        {data.fetchedAt && (
          <div className="row">
            <button className="secondary" disabled={loading} onClick={() => load(month, true)}>{loading ? 'Loading…' : 'Reload'}</button>
            {buckets.length > 0 && <button className="secondary" onClick={exportCsv}>Download CSV</button>}
          </div>
        )}
      </div>

      {data.months.length > 0 && (
        <>
          <div className="period-tabs" role="tablist" aria-label="Year">
            {years.map((y) => (
              <button key={y} role="tab" aria-selected={y === year} className="period-tab" disabled={loading}
                onClick={() => load(data.months.find((m) => (m.month === 'undated' ? 'undated' : m.month.slice(0, 4)) === y).month)}>
                <span>{y === 'undated' ? 'No dates' : y}</span>
              </button>
            ))}
          </div>
          <div className="period-tabs" role="tablist" aria-label="Sprint">
            {data.months.filter((m) => (m.month === 'undated' ? 'undated' : m.month.slice(0, 4)) === year).map((m) => (
              <button key={m.month} role="tab" aria-selected={m.month === month} className="period-tab" disabled={loading} onClick={() => load(m.month)}>
                <span>{m.month === 'undated' ? 'Sprints without dates' : monthLabel(m.month)}</span>
                <small>{[...new Set(m.sprints.map((sp) => sp.name))].join(', ')}</small>
              </button>
            ))}
          </div>
        </>
      )}

      <ErrorNote>{error}</ErrorNote>
      {loading && <Loading />}
      {data.message ? <div className="empty"><p>{data.message}</p></div> : (
        <>
          <div className="row tp-tools">
            <label className="wi-filter">
              <span>Team</span>
              <select value={team} onChange={(e) => setTeam(e.target.value)}>
                <option value="">All teams</option>
                {teams.map((t) => <option key={t}>{t}</option>)}
              </select>
            </label>
            {clients.length > 0 && (
              <label className="wi-filter">
                <span>Client</span>
                <select value={client} onChange={(e) => setClient(e.target.value)}>
                  <option value="">All clients</option>
                  {clients.map((c) => <option key={c}>{c}</option>)}
                </select>
              </label>
            )}
            <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search ID, title or person" aria-label="Search" />
            {buckets.length > 0 && (
              <button className="link" onClick={() => setOpenBuckets(openBuckets.size ? new Set() : new Set(buckets.map((b) => b.name)))}>
                {openBuckets.size ? 'Collapse all' : 'Expand all'}
              </button>
            )}
          </div>

          <p className="small sow-total">
            <strong>{buckets.length}</strong> bucket{buckets.length === 1 ? '' : 's'} · <strong>{total.items}</strong> User Stories and Issues,
            {' '}{total.closed} closed ({percent(total.closed, total.items)}%) · {total.tasks} tasks and bugs, {total.tasksClosed} closed ·
            {' '}Estimated {hours(total.original)} h · Completed {hours(total.completed)} h · Remaining {hours(total.remaining)} h
            {data.fetchedAt && <span className="muted"> · Read {new Date(data.fetchedAt).toLocaleTimeString()}</span>}
          </p>

          {buckets.length === 0 ? (
            <div className="empty"><p>{all.length ? 'Nothing matches these filters.' : 'No User Stories or Issues in this sprint.'}</p></div>
          ) : buckets.map((b) => {
            const st = stats(b.items);
            const open = openBuckets.has(b.name);
            return (
              <section key={b.name || '(none)'} className="sow-bucket">
                <button type="button" className="drill sow-bucket-head" aria-expanded={open} onClick={() => toggleBucket(b.name)}>
                  <span className="drill-caret" aria-hidden="true">▸</span>
                  <span className="sow-bucket-name">{b.name || 'No bucket'}</span>
                  <span className="small sow-bucket-stats">
                    {st.items} item{st.items === 1 ? '' : 's'} · {st.closed} closed
                    <span className="wi-bar sow-bar" role="img" aria-label={`${percent(st.closed, st.items)}% closed`}><span style={{ width: `${percent(st.closed, st.items)}%` }} /></span>
                    {percent(st.closed, st.items)}% · {st.tasks} tasks/bugs · Est {hours(st.original)} h · Done {hours(st.completed)} h · Left {hours(st.remaining)} h
                  </span>
                </button>
                {open && (
                  <div className="table-wrap">
                    <table className="grid list wi-table">
                      <thead>
                        <tr>
                          <th scope="col" className="wi-title">Title</th><th scope="col">Type</th><th scope="col">State</th>
                          <th scope="col">Team</th>{clients.length > 0 && <th scope="col">Client</th>}<th scope="col">Assigned to</th>
                          <th scope="col" className="num">Original</th><th scope="col" className="num">Completed</th><th scope="col" className="num">Remaining</th>
                        </tr>
                      </thead>
                      <tbody>
                        {b.items.map((i) => {
                          const shown = openItems.has(i.id);
                          return (
                            <Fragment key={i.id}>
                              <tr className="wi-parent">
                                <th scope="row" className="wi-title" title={`${i.id} ${i.title}`}>
                                  {i.children.length > 0 ? (
                                    <button type="button" className="drill" aria-expanded={shown} onClick={() => toggleItem(i.id)}
                                      title={shown ? 'Hide tasks and bugs' : 'Show tasks and bugs'}>
                                      <span className="drill-caret" aria-hidden="true">▸</span>
                                    </button>
                                  ) : <span className="sow-nokids" aria-hidden="true" />}
                                  {' '}<a href={i.url} target="_blank" rel="noreferrer">{i.id}</a> {i.title}
                                  {i.children.length > 0 && <small className="muted"> ({i.children.length})</small>}
                                </th>
                                <td>{i.type}</td>
                                <td className={i.closed ? 'ok-text' : ''}>{i.state}</td>
                                <td className="small" title={i.areaPath}>{i.area}</td>
                                {clients.length > 0 && <td>{i.client}</td>}
                                <td>{i.assignedTo || <span className="muted">Unassigned</span>}</td>
                                <td className="num">{hours(i.hours.original)}</td>
                                <td className="num">{hours(i.hours.completed)}</td>
                                <td className="num">{hours(i.hours.remaining)}</td>
                              </tr>
                              {shown && i.children.map((c) => (
                                <tr key={c.id} className="wi-child">
                                  <th scope="row" className="wi-title" title={`${c.id} ${c.title}`}>
                                    <a href={c.url} target="_blank" rel="noreferrer">{c.id}</a> {c.title}
                                  </th>
                                  <td>{c.type}</td>
                                  <td className={c.closed ? 'ok-text' : ''}>{c.state}</td>
                                  <td className="small" title={c.areaPath}>{c.area}</td>
                                  {clients.length > 0 && <td>{c.client}</td>}
                                  <td>{c.assignedTo || <span className="muted">Unassigned</span>}</td>
                                  <td className="num">{hours(c.original)}</td>
                                  <td className="num">{hours(c.completed)}</td>
                                  <td className="num">{hours(c.remaining)}</td>
                                </tr>
                              ))}
                            </Fragment>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            );
          })}
        </>
      )}
    </section>
  );
}
