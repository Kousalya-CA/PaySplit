import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Loading, ErrorNote } from '../components/common.jsx';
import { dayLabel } from '../format.js';

// Timesheet: the hours logged with "Log time" on the Sprint Tracker, by the day they were worked.
// One person (an employee sees only their own): summary tiles, a card per day with its status, and
// what was logged, newest day first. Everyone (admins): one row per person with their totals.
// Each day is compared with the hours expected: hours per day on working days, none at weekends and
// holidays, less leave. "Expected so far" counts the days before today (today is still in progress).
const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const iso = (d) => d.toISOString().slice(0, 10);
const utc = (day) => new Date(`${day}T00:00:00Z`);
const addDays = (day, n) => iso(new Date(utc(day).getTime() + n * 86400000));
const today = () => new Date().toLocaleDateString('en-CA');
const mondayOf = (day) => addDays(day, -((utc(day).getUTCDay() + 6) % 7));
const h = (n) => `${+(n || 0).toFixed(2)} h`;
const shortDay = (day) => `${+day.slice(8)} ${MONTHS[+day.slice(5, 7) - 1]}`;
const EPS = 0.01;

// The From and To dates for a week (Mon to Sun) or a calendar month containing the day.
function rangeFor(view, day) {
  if (view === 'week') { const from = mondayOf(day); return [from, addDays(from, 6)]; }
  const from = `${day.slice(0, 7)}-01`;
  const next = new Date(Date.UTC(+day.slice(0, 4), +day.slice(5, 7), 1));
  return [from, iso(new Date(next.getTime() - 86400000))];
}

export default function Timesheet({ isAdmin, user }) {
  const [view, setView] = useState('week');
  const [anchor, setAnchor] = useState(today());
  const [email, setEmail] = useState('');
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(false);
  const [reload, setReload] = useState(0);
  const [from, to] = rangeFor(view, anchor);

  useEffect(() => {
    setLoading(true);
    setError('');
    api.timesheet(from, to, email).then(setData).catch((e) => setError(e.message)).finally(() => setLoading(false));
  }, [from, to, email, reload]);

  if (!data) return error ? <ErrorNote>{error}</ErrorNote> : <Loading />;

  const now = today();
  const days = [];
  for (let d = from; d <= to; d = addDays(d, 1)) days.push(d);
  const hpd = data.hours_per_day || 8;
  const holiday = new Map(data.holidays.map((x) => [x.day, x.name]));
  const leaveOf = (who, day) => data.leaves
    .filter((l) => l.email === who && l.from_day <= day && l.to_day >= day)
    .reduce((n, l) => Math.max(n, l.half ? 0.5 : 1), 0);
  const isWeekend = (day) => [0, 6].includes(utc(day).getUTCDay());
  const expected = (who, day) => (isWeekend(day) || holiday.has(day) ? 0 : hpd * (1 - leaveOf(who, day)));
  const sum = (list) => list.reduce((n, l) => n + l.hours, 0);

  // A day's status for one person, in words, with its colour.
  const dayStatus = (who, day, logged) => {
    const exp = expected(who, day);
    const leave = leaveOf(who, day);
    if (logged > exp + EPS) return exp ? ['over', `Over by ${h(logged - exp)}`] : ['over', 'Logged on a day off'];
    if (isWeekend(day)) return ['off', 'Weekend'];
    if (holiday.has(day)) return ['holiday', `Holiday · ${holiday.get(day)}`];
    if (leave >= 1) return ['leave', 'On leave'];
    if (day > now) return ['todo', leave ? 'Half day leave' : 'Not yet'];
    if (logged >= exp - EPS) return ['ok', leave ? 'Complete · half day leave' : 'Complete'];
    if (day === now) return ['todo', `In progress · ${h(exp - logged)} to go`];
    return ['short', logged ? `Short by ${h(exp - logged)}` : 'Nothing logged'];
  };
  // Totals for one person over the shown days; "so far" stops before today.
  const totalsFor = (who, logs) => {
    const upTo = days.filter((d) => d < now);
    const logged = sum(logs);
    const exp = upTo.reduce((n, d) => n + expected(who, d), 0);
    const loggedSoFar = sum(logs.filter((l) => l.day < now));
    const workDays = upTo.filter((d) => expected(who, d) > 0);
    const complete = workDays.filter((d) => sum(logs.filter((l) => l.day === d)) >= expected(who, d) - EPS).length;
    const over = days.filter((d) => sum(logs.filter((l) => l.day === d)) > expected(who, d) + EPS).length;
    const short = workDays.filter((d) => sum(logs.filter((l) => l.day === d)) < expected(who, d) - EPS).length;
    return { logged, exp, diff: loggedSoFar - exp, workDays: workDays.length, complete, over, short, tasks: new Set(logs.map((l) => l.task_id)).size };
  };

  const person = isAdmin ? email : data.email;
  const name = (e) => data.people.find((p) => p.email === e)?.name || data.logs.find((l) => l.email === e)?.assignee || e;
  const move = (n) => setAnchor(view === 'week' ? addDays(anchor, 7 * n) : iso(new Date(Date.UTC(+anchor.slice(0, 4), +anchor.slice(5, 7) - 1 + n, 1))));
  const title = view === 'week' ? `Week of ${dayLabel(from)} to ${dayLabel(to)}` : `${MONTHS[+from.slice(5, 7) - 1]} ${from.slice(0, 4)}`;

  const undo = async (l) => {
    if (!window.confirm(`Undo ${l.hours} h logged on ${l.task_id} for ${dayLabel(l.day)}? Azure DevOps is updated back.`)) return;
    setError('');
    setNotice('');
    try {
      const r = await api.timeLog.undo(l.id);
      setNotice(`Undone: ${l.task_id} is back to completed ${h(r.completed)}, remaining ${h(r.remaining)}.`);
      setReload((n) => n + 1);
    } catch (err) { setError(err.message); }
  };

  const exportCsv = () => {
    const header = ['Date', 'Employee', 'Task', 'Title', 'Hours', 'Note', 'Logged by'];
    const lines = data.logs.map((l) => [l.day, l.assignee || name(l.email), l.task_id, l.task_title, l.hours, l.note || '', l.logged_by]);
    const csv = [header, ...lines].map((l) => l.map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: `timesheet-${person ? name(person).replace(/\s+/g, '-') + '-' : ''}${from}-to-${to}.csv` });
    a.click();
    URL.revokeObjectURL(url);
  };

  const controls = (
    <div className="row tp-tools ts-controls">
      {isAdmin && (
        <label className="wi-filter">
          <span>Person</span>
          <select value={email} onChange={(e) => setEmail(e.target.value)}>
            <option value="">Everyone</option>
            {data.people.map((p) => <option key={p.email} value={p.email}>{p.name}{p.active ? '' : ' (inactive)'}</option>)}
          </select>
        </label>
      )}
      <div className="ts-nav">
        <button className="secondary" onClick={() => move(-1)} aria-label={view === 'week' ? 'Previous week' : 'Previous month'}>‹</button>
        <strong>{title}</strong>
        <button className="secondary" onClick={() => move(1)} aria-label={view === 'week' ? 'Next week' : 'Next month'}>›</button>
        <button className="link" onClick={() => setAnchor(today())}>Today</button>
      </div>
      <span className="ts-spacer" />
      <div className="seg ts-seg" role="radiogroup" aria-label="Period">
        {[['week', 'Week'], ['month', 'Month']].map(([k, label]) => (
          <button key={k} role="radio" aria-checked={view === k} className={view === k ? 'on' : ''} onClick={() => setView(k)}>{label}</button>
        ))}
      </div>
      {data.logs.length > 0 && <button className="secondary" onClick={exportCsv}>Download CSV</button>}
    </div>
  );

  // ---------- Everyone (admins) ----------
  if (!person) {
    const emails = [...new Set([...data.people.filter((p) => p.active).map((p) => p.email), ...data.logs.map((l) => l.email)])];
    const rows = emails.map((e) => ({ email: e, logs: data.logs.filter((l) => l.email === e) }))
      .map((r) => ({ ...r, t: totalsFor(r.email, r.logs) }))
      .sort((a, b) => name(a.email).localeCompare(name(b.email)));
    const team = rows.reduce((n, r) => ({ logged: n.logged + r.t.logged, exp: n.exp + r.t.exp }), { logged: 0, exp: 0 });
    const behind = rows.filter((r) => r.t.diff < -EPS).length;
    const upToDate = rows.filter((r) => r.t.diff >= -EPS && r.t.exp > 0).length;
    const overPeople = rows.filter((r) => r.t.over > 0).length;
    return (
      <section>
        <div className="page-head"><div>
          <h1>Timesheet</h1>
          <p className="muted">Hours logged on Sprint Tracker tasks, day by day, compared with the hours expected. Click a name to see their days.</p>
        </div></div>
        {controls}
        <ErrorNote>{error}</ErrorNote>
        {loading && <Loading />}
        <div className="ts-tiles">
          <div className="ts-tile"><small>Logged by the team</small><strong>{h(team.logged)}</strong><span>{rows.length} people</span></div>
          <div className="ts-tile"><small>Expected so far</small><strong>{h(team.exp)}</strong><span>{hpd} h a working day, less holidays and leave</span></div>
          <div className={`ts-tile${behind ? ' short' : ''}`}><small>Behind</small><strong>{behind} {behind === 1 ? 'person' : 'people'}</strong><span>logged less than expected</span></div>
          <div className={`ts-tile${overPeople ? ' over' : ' ok'}`}><small>{overPeople ? 'Over a day\'s hours' : 'Up to date'}</small>
            <strong>{overPeople ? `${overPeople} ${overPeople === 1 ? 'person' : 'people'}` : `${upToDate} ${upToDate === 1 ? 'person' : 'people'}`}</strong>
            <span>{overPeople ? `logged more than ${hpd} h on a day` : 'logged all expected hours'}</span></div>
        </div>
        <div className="table-wrap">
          <table className="grid list ts-team">
            <thead>
              <tr>
                <th scope="col">Employee</th><th scope="col">{view === 'week' ? 'Mon to Sun' : 'Each day'}</th>
                <th scope="col" className="num">Logged</th><th scope="col" className="num">Expected so far</th>
                <th scope="col" className="num">Difference</th><th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ email: e, logs, t }) => (
                <tr key={e}>
                  <th scope="row"><button className="link ts-name" onClick={() => setEmail(e)}>{name(e)}</button></th>
                  <td>
                    <div className="ts-mini" aria-hidden="true">
                      {days.map((d) => {
                        const logged = sum(logs.filter((l) => l.day === d));
                        const exp = expected(e, d);
                        const [kind] = dayStatus(e, d, logged);
                        const cls = logged ? (kind === 'over' ? 'over' : logged < exp - EPS ? 'short' : 'ok') : exp ? (d < now ? 'none' : 'todo') : 'off';
                        return <span key={d} className={cls} title={`${WEEKDAY[utc(d).getUTCDay()]} ${shortDay(d)}: ${h(logged)} of ${h(exp)}`}
                          style={logged ? { height: `${Math.min(100, (logged / (hpd * 1.5)) * 100)}%` } : undefined} />;
                      })}
                    </div>
                  </td>
                  <td className="num strong">{h(t.logged)}</td>
                  <td className="num">{h(t.exp)}</td>
                  <td className={`num strong ${t.diff < -EPS ? 'ts-neg' : t.diff > EPS ? 'ts-pos' : ''}`}>{t.diff > EPS ? '+' : ''}{h(t.diff)}</td>
                  <td><div className="ts-status">
                    {t.exp === 0 && t.logged === 0 ? <span className="ts-chip off">No working days yet</span>
                      : t.logged === 0 ? <span className="ts-chip short">Nothing logged</span>
                        : t.diff < -EPS ? <span className="ts-chip short">Short by {h(-t.diff)}</span>
                          : <span className="ts-chip ok">Up to date</span>}
                    {t.over > 0 && <span className="ts-chip over">{t.over} {t.over === 1 ? 'day' : 'days'} over</span>}
                  </div></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    );
  }

  // ---------- One person ----------
  const logs = isAdmin ? data.logs.filter((l) => l.email === person) : data.logs;
  const t = totalsFor(person, logs);
  const byDay = days.slice().reverse().filter((d) => d <= now || logs.some((l) => l.day === d));
  const lead = view === 'month' ? (utc(from).getUTCDay() + 6) % 7 : 0; // blank cells before the 1st (weeks start Monday)
  return (
    <section>
      <div className="page-head"><div>
        <h1>Timesheet</h1>
        <p className="muted">{isAdmin ? <><strong>{name(person)}</strong> · </> : null}Hours logged on Sprint Tracker tasks, day by day, compared with the hours expected.</p>
      </div></div>
      {controls}
      <ErrorNote>{error}</ErrorNote>
      {notice && <p className="ok-text small" role="status">{notice}</p>}
      {loading && <Loading />}
      {!isAdmin && data.people.length === 0 ? (
        <div className="empty"><p>Your login isn't linked to an employee with this email, so there's no timesheet. Ask an admin.</p></div>
      ) : (
        <>
          <div className="ts-tiles">
            <div className="ts-tile"><small>Logged {view === 'week' ? 'this week' : 'this month'}</small><strong>{h(t.logged)}</strong><span>across {t.tasks} {t.tasks === 1 ? 'task' : 'tasks'}</span></div>
            <div className="ts-tile"><small>Expected so far</small><strong>{h(t.exp)}</strong><span>{t.workDays} working {t.workDays === 1 ? 'day' : 'days'} before today × {hpd} h, less leave</span></div>
            <div className={`ts-tile${t.diff < -EPS ? ' short' : t.diff > EPS ? ' over' : ' ok'}`}><small>Difference</small>
              <strong>{t.diff > EPS ? '+' : ''}{h(t.diff)}</strong>
              <span>{t.diff < -EPS ? `short on ${t.short} ${t.short === 1 ? 'day' : 'days'}` : t.diff > EPS ? 'more than expected' : 'all expected hours logged'}</span></div>
            <div className={`ts-tile${t.over ? ' over' : t.complete === t.workDays ? ' ok' : ''}`}>
              <small>{t.over ? 'Days over' : 'Days complete'}</small>
              <strong>{t.over ? t.over : `${t.complete} of ${t.workDays}`}</strong>
              <span>{t.over ? `more than ${hpd} h, or logged on a day off` : 'working days before today'}</span></div>
          </div>

          <h2>Each day</h2>
          <div className={`ts-days${view === 'month' ? ' month' : ''}`}>
            {view === 'month' && ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => <span key={d} className="ts-dow">{d}</span>)}
            {Array.from({ length: lead }, (_, i) => <span key={`b${i}`} />)}
            {days.map((d) => {
              const logged = sum(logs.filter((l) => l.day === d));
              const exp = expected(person, d);
              const [kind, text] = dayStatus(person, d, logged);
              return (
                <div key={d} className={`ts-daycard ${kind}${d === now ? ' today' : ''}${exp === 0 && !logged ? ' dayoff' : ''}`}>
                  <div className="ts-dayname">{WEEKDAY[utc(d).getUTCDay()]}<small>{shortDay(d)}{d === now ? ' · today' : ''}</small></div>
                  <div className="ts-dayhours">{logged ? +logged.toFixed(2) : '–'}<small>{exp ? ` / ${+exp.toFixed(2)} h` : ' h'}</small></div>
                  <div className="ts-meter"><span className={kind} style={{ width: `${exp ? Math.min(100, (logged / exp) * 100) : logged ? 100 : 0}%` }} /></div>
                  <span className={`ts-chip ${kind}`}>{text}</span>
                </div>
              );
            })}
          </div>

          <div className="ts-entries">
            <h2>What was logged <small>newest day first · click a task to open it in Azure DevOps</small></h2>
            {byDay.length === 0 ? <p className="muted ts-empty">Nothing yet {view === 'week' ? 'this week' : 'this month'}.</p> : byDay.map((d) => {
              const dayLogs = logs.filter((l) => l.day === d);
              const logged = sum(dayLogs);
              const exp = expected(person, d);
              const [kind, text] = dayStatus(person, d, logged);
              if (!dayLogs.length && exp === 0) return null; // weekends and holidays with nothing logged
              return (
                <div key={d} className="ts-group">
                  <div className="ts-grouphead">
                    <span>{WEEKDAY[utc(d).getUTCDay()]} {dayLabel(d)}</span>
                    <span className="muted">{h(logged)}{exp ? ` of ${h(exp)}` : ''} <span className={`ts-chip ${kind}`}>{text}</span></span>
                  </div>
                  {dayLogs.length === 0 ? <p className="muted ts-empty">Nothing logged.</p> : dayLogs.map((l) => (
                    <div key={l.id} className="ts-entry">
                      <div className="ts-entry-h">{h(l.hours)}</div>
                      <div className="ts-entry-task">
                        {l.url ? <a href={l.url} target="_blank" rel="noreferrer">{l.task_id} {l.task_title}</a> : <strong>{l.task_id} {l.task_title}</strong>}
                        {l.note && <div className="muted">“{l.note}”</div>}
                      </div>
                      <div className="ts-entry-by">
                        by {l.logged_by_id === user?.id ? 'you' : l.logged_by}
                        {(isAdmin || l.logged_by_id === user?.id) && <button className="link danger" onClick={() => undo(l)}>Undo</button>}
                      </div>
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        </>
      )}
    </section>
  );
}
