import { Fragment, useEffect, useState } from 'react';
import { api } from '../api.js';
import { Loading, ErrorNote } from '../components/common.jsx';
import { dayLabel } from '../format.js';

// Timesheet: the hours logged with "Log time" on the SOW Tracker, by day. An employee sees their own;
// admins see everyone (one row per person) or pick a person (one row per task). Each day is compared
// with the hours expected: hours per day on working days, none at weekends and holidays, less leave.
const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const iso = (d) => d.toISOString().slice(0, 10);
const utc = (day) => new Date(`${day}T00:00:00Z`);
const addDays = (day, n) => iso(new Date(utc(day).getTime() + n * 86400000));
const today = () => new Date().toLocaleDateString('en-CA');
const mondayOf = (day) => addDays(day, -((utc(day).getUTCDay() + 6) % 7));
const hours = (n) => (n ? `${+n.toFixed(2)}` : '');
const shortDay = (day) => `${+day.slice(8)} ${MONTHS[+day.slice(5, 7) - 1]}`;

// The From and To dates for a week (Mon to Sun) or a calendar month containing the day.
function rangeFor(view, day) {
  if (view === 'week') { const from = mondayOf(day); return [from, addDays(from, 6)]; }
  const from = `${day.slice(0, 7)}-01`;
  const next = new Date(Date.UTC(+day.slice(0, 4), +day.slice(5, 7), 1));
  return [from, iso(new Date(next.getTime() - 86400000))];
}

export default function Timesheet({ isAdmin }) {
  const [view, setView] = useState('week');
  const [anchor, setAnchor] = useState(today());
  const [email, setEmail] = useState('');
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(() => new Set()); // task ids with their notes shown
  const [from, to] = rangeFor(view, anchor);

  useEffect(() => {
    setLoading(true);
    setError('');
    api.timesheet(from, to, email).then(setData).catch((e) => setError(e.message)).finally(() => setLoading(false));
  }, [from, to, email]);

  if (!data) return error ? <ErrorNote>{error}</ErrorNote> : <Loading />;

  const days = [];
  for (let d = from; d <= to; d = addDays(d, 1)) days.push(d);
  const hpd = data.hours_per_day || 8;
  const holiday = new Map(data.holidays.map((h) => [h.day, h.name]));
  const leaveOf = (who, day) => data.leaves
    .filter((l) => l.email === who && l.from_day <= day && l.to_day >= day)
    .reduce((n, l) => Math.max(n, l.half ? 0.5 : 1), 0);
  const kind = (day) => {
    const dow = utc(day).getUTCDay();
    return dow === 0 || dow === 6 ? 'weekend' : holiday.has(day) ? 'holiday' : 'work';
  };
  // Hours expected of one person on a day.
  const expected = (who, day) => (kind(day) === 'work' ? hpd * (1 - leaveOf(who, day)) : 0);
  const sum = (list) => list.reduce((n, l) => n + l.hours, 0);
  const now = today();
  const dayClass = (who, day, logged) => {
    const exp = expected(who, day);
    const k = kind(day);
    const leave = who && leaveOf(who, day);
    let c = `ts-day ${k}${leave ? ' leave' : ''}${day === now ? ' today' : ''}`;
    if (day < now && exp > 0 && logged < exp - 0.01) c += ' under';
    if (logged > (exp || 0) + 0.01 && logged > 0) c += ' over';
    return c;
  };
  const dayTitle = (who, day, logged) => {
    const k = kind(day);
    const leave = who && leaveOf(who, day);
    const exp = expected(who, day);
    return `${WEEKDAY[utc(day).getUTCDay()]} ${dayLabel(day)}${k === 'weekend' ? ' · Weekend' : k === 'holiday' ? ` · ${holiday.get(day)}` : ''}${leave ? (leave < 1 ? ' · Half day leave' : ' · Leave') : ''} · logged ${+logged.toFixed(2)} h of ${+exp.toFixed(2)} h expected`;
  };

  const person = isAdmin ? email : data.email;
  const name = (e) => data.people.find((p) => p.email === e)?.name || data.logs.find((l) => l.email === e)?.assignee || e;
  const move = (n) => setAnchor(view === 'week' ? addDays(anchor, 7 * n) : iso(new Date(Date.UTC(+anchor.slice(0, 4), +anchor.slice(5, 7) - 1 + n, 1))));
  const title = view === 'week' ? `${dayLabel(from)} to ${dayLabel(to)}` : `${MONTHS[+from.slice(5, 7) - 1]} ${from.slice(0, 4)}`;

  // One person: rows are tasks. Everyone: rows are people.
  const rows = person
    ? [...new Map(data.logs.map((l) => [l.task_id, { key: l.task_id, task: l }])).values()]
      .map((r) => ({ ...r, logs: data.logs.filter((l) => l.task_id === r.key) }))
    : [...new Set([...data.logs.map((l) => l.email), ...(isAdmin ? data.people.filter((p) => p.active).map((p) => p.email) : [])])]
      .map((e) => ({ key: e, email: e, logs: data.logs.filter((l) => l.email === e) }))
      .sort((a, b) => name(a.key).localeCompare(name(b.key)));
  const totalLogged = sum(data.logs);
  const expectedTotal = person ? days.reduce((n, d) => n + expected(person, d), 0) : 0;

  const exportCsv = () => {
    const header = ['Date', 'Employee', 'Task', 'Title', 'Hours', 'Note', 'Logged by'];
    const lines = data.logs.map((l) => [l.day, l.assignee || name(l.email), l.task_id, l.task_title, l.hours, l.note || '', l.logged_by]);
    const csv = [header, ...lines].map((l) => l.map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: `timesheet-${person ? name(person).replace(/\s+/g, '-') + '-' : ''}${from}-to-${to}.csv` });
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <section>
      <div className="page-head">
        <div>
          <h1>Timesheet</h1>
          <p className="muted">Hours logged with <strong>Log time</strong> on the SOW Tracker, by the day they were worked.{isAdmin ? '' : ' Only your own.'}</p>
        </div>
        {data.logs.length > 0 && <button className="secondary" onClick={exportCsv}>Download CSV</button>}
      </div>

      <div className="row tp-tools">
        <div className="seg" role="radiogroup" aria-label="View">
          {[['week', 'Week'], ['month', 'Month']].map(([k, label]) => (
            <button key={k} role="radio" aria-checked={view === k} className={view === k ? 'on' : ''} onClick={() => setView(k)}>{label}</button>
          ))}
        </div>
        <button className="secondary" onClick={() => move(-1)} aria-label="Previous">‹</button>
        <strong>{title}</strong>
        <button className="secondary" onClick={() => move(1)} aria-label="Next">›</button>
        <button className="link" onClick={() => setAnchor(today())}>Today</button>
        {isAdmin && (
          <label className="wi-filter">
            <span>Person</span>
            <select value={email} onChange={(e) => setEmail(e.target.value)}>
              <option value="">Everyone</option>
              {data.people.map((p) => <option key={p.email} value={p.email}>{p.name}{p.active ? '' : ' (inactive)'}</option>)}
            </select>
          </label>
        )}
      </div>

      <ErrorNote>{error}</ErrorNote>
      {loading && <Loading />}
      <p className="small">
        {person ? <><strong>{name(person)}</strong>: </> : null}
        Logged <strong>{hours(totalLogged) || 0} h</strong>
        {person ? <> of <strong>{hours(expectedTotal) || 0} h</strong> expected ({hpd} h a working day, less holidays and leave)</> : <> by {new Set(data.logs.map((l) => l.email)).size} people</>}
      </p>

      {!person && !isAdmin && data.people.length === 0 ? (
        <div className="empty"><p>Your login isn't linked to an employee with this email, so there's no timesheet. Ask an admin.</p></div>
      ) : rows.length === 0 ? (
        <div className="empty"><p>No time logged {view === 'week' ? 'this week' : 'this month'}. Log time on a task on the SOW Tracker.</p></div>
      ) : (
        <div className="table-wrap">
          <table className="grid ts-table">
            <thead>
              <tr>
                <th scope="col">{person ? 'Task' : 'Employee'}</th>
                {days.map((d) => (
                  <th key={d} scope="col" className={`num ts-head ${kind(d)}${d === now ? ' today' : ''}`} title={holiday.get(d) || undefined}>
                    <small>{WEEKDAY[utc(d).getUTCDay()]}</small><br />{view === 'week' ? shortDay(d) : +d.slice(8)}
                  </th>
                ))}
                <th scope="col" className="num">Total</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const total = sum(r.logs);
                return (
                  <Fragment key={r.key}>
                    <tr>
                      <th scope="row" className="ts-name">
                        {person ? (
                          <>
                            {r.task.url ? <a href={r.task.url} target="_blank" rel="noreferrer">{r.task.task_id}</a> : r.task.task_id} {r.task.task_title}
                            {r.logs.some((l) => l.note) && (
                              <button className="link small" onClick={() => setOpen((p) => { const n = new Set(p); if (n.has(r.key)) n.delete(r.key); else n.add(r.key); return n; })}>
                                {open.has(r.key) ? ' hide notes' : ' notes'}
                              </button>
                            )}
                          </>
                        ) : (
                          <button className="link" onClick={() => setEmail(r.email)} disabled={!isAdmin}>{name(r.email)}</button>
                        )}
                      </th>
                      {days.map((d) => {
                        const logged = sum(r.logs.filter((l) => l.day === d));
                        return (
                          <td key={d} className={person ? `num ts-cell ${kind(d)}` : `num ${dayClass(r.email, d, logged)}`}
                            title={person ? r.logs.filter((l) => l.day === d).map((l) => `${l.hours} h${l.note ? `: ${l.note}` : ''} (by ${l.logged_by})`).join('\n') || undefined : dayTitle(r.email, d, logged)}>
                            {hours(logged)}
                          </td>
                        );
                      })}
                      <td className="num strong">{hours(total) || 0}</td>
                    </tr>
                    {person && open.has(r.key) && (
                      <tr className="drill-row">
                        <td colSpan={days.length + 2} className="small">
                          {r.logs.filter((l) => l.note).map((l) => <div key={l.id}>{dayLabel(l.day)} · {l.hours} h · {l.note} <span className="muted">({l.logged_by})</span></div>)}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
            {person && (
              <tfoot>
                <tr>
                  <th scope="row">Logged</th>
                  {days.map((d) => {
                    const logged = sum(data.logs.filter((l) => l.day === d));
                    return <td key={d} className={`num ${dayClass(person, d, logged)}`} title={dayTitle(person, d, logged)}>{hours(logged)}</td>;
                  })}
                  <td className="num strong">{hours(totalLogged) || 0}</td>
                </tr>
                <tr className="muted">
                  <th scope="row">Expected</th>
                  {days.map((d) => <td key={d} className="num">{hours(expected(person, d))}</td>)}
                  <td className="num">{hours(expectedTotal) || 0}</td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      )}
      <p className="muted small ts-legend">
        <span className="ts-key under" /> under the expected hours (past days) · <span className="ts-key over" /> over · <span className="ts-key weekend" /> weekend ·
        {' '}<span className="ts-key holiday" /> holiday · <span className="ts-key leave" /> leave
      </p>
    </section>
  );
}
