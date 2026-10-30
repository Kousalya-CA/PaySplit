import { Fragment, useEffect, useState } from 'react';
import { api } from '../api.js';
import { Loading, ErrorNote } from '../components/common.jsx';
import { dayLabel, monthLabel } from '../format.js';
import Avatar, { WithAvatar } from '../components/Avatar.jsx';

const hours = (n) => (n ? `${+n.toFixed(2)}` : '–');
const percent = (part, whole) => (whole ? Math.round((part / whole) * 100) : 0);
const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const isoDay = (d) => d.toISOString().slice(0, 10);
const addDays = (iso, n) => isoDay(new Date(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10) + n)));
const lastOfMonth = (m) => isoDay(new Date(Date.UTC(+m.slice(0, 4), +m.slice(5, 7), 0)));
const today = () => new Date().toLocaleDateString('en-CA');

// Leave on a day for one person (by email): 1, 0.5 for a half day, or 0.
const leaveOn = (leaves, email, day) => leaves
  .filter((l) => l.email === email && l.from_day <= day && l.to_day >= day)
  .reduce((n, l) => Math.max(n, l.half ? 0.5 : 1), 0);
// A person's leave on the sprint's working days: in total, on days done (up to today) and days left.
function leaveIn(cal, leaves, email) {
  const now = today();
  const out = { used: 0, done: 0, left: 0 };
  for (const x of cal.days) {
    if (!x.working) continue;
    const v = leaveOn(leaves, email, x.day);
    out.used += v;
    if (x.day <= now) out.done += v; else out.left += v;
  }
  return out;
}
// Log hours worked on a Task or Bug: Completed goes up by the hours and Remaining down (never below 0),
// unless a new Remaining is typed. A task with no estimate needs one first. Earlier logs can be undone.
function LogTime({ task, logs, allLogs, holidays, leaves, hpd, isAdmin, userId, onDone, onError }) {
  const [day, setDay] = useState(today());
  const [worked, setWorked] = useState('');
  const [remaining, setRemaining] = useState('');
  const [original, setOriginal] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const h = Number(worked) || 0;
  const startRemaining = task.remaining || Math.max(0, (task.original || Number(original) || 0) - task.completed);
  const autoRemaining = Math.max(0, startRemaining - h);
  // Warnings: not a working day, on leave, or more than a day's hours logged for this person.
  const dow = new Date(`${day}T00:00:00Z`).getUTCDay();
  const holiday = holidays.find((x) => x.day === day);
  const onLeave = leaveOn(leaves, task.assignedEmail, day);
  const dayTotal = allLogs.filter((l) => l.email === task.assignedEmail && l.day === day).reduce((n, l) => n + l.hours, 0) + h;
  const warnings = [
    dow === 0 || dow === 6 ? 'That day is a weekend.' : '',
    holiday ? `That day is a holiday (${holiday.name}).` : '',
    onLeave ? `${task.assignedTo || 'They'} ${onLeave < 1 ? 'had a half day of leave' : 'were on leave'} that day.` : '',
    dayTotal > hpd ? `That makes ${hours(dayTotal)} h logged for ${task.assignedTo || 'them'} on that day (a day is ${hpd} h).` : '',
  ].filter(Boolean);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    onError('');
    try {
      const r = await api.timeLog.log(task.id, { day, hours: h, remaining: remaining === '' ? null : Number(remaining), original: task.noEstimate ? Number(original) : null, note });
      onDone(`Logged ${h} h on ${task.id}: completed ${hours(r.completed)} h, remaining ${hours(r.remaining)} h (updated in Azure DevOps).`);
    } catch (err) { onError(err.message); } finally { setBusy(false); }
  };
  const undo = async (l) => {
    if (!window.confirm(`Undo ${l.hours} h logged by ${l.logged_by} for ${dayLabel(l.day)}? Azure DevOps is updated back.`)) return;
    setBusy(true);
    onError('');
    try {
      const r = await api.timeLog.undo(l.id);
      onDone(`Undone: ${task.id} is back to completed ${hours(r.completed)} h, remaining ${hours(r.remaining)} h.`);
    } catch (err) { onError(err.message); } finally { setBusy(false); }
  };

  return (
    <div className="sow-log">
      <p className="small">
        <strong>Log time · {task.id} {task.title}</strong>
        <span className="muted"> · Est {hours(task.original)} h · Done {hours(task.completed)} h · Left {hours(task.remaining)} h · {task.assignedTo || 'Unassigned'}</span>
      </p>
      <form className="row" onSubmit={submit}>
        {task.noEstimate && (
          <label>
            <span>Original estimate (h)</span>
            <input type="number" min="0.25" step="0.25" value={original} required onChange={(e) => setOriginal(e.target.value)} />
          </label>
        )}
        <label>
          <span>Date</span>
          <input type="date" value={day} max={today()} required onChange={(e) => setDay(e.target.value)} />
        </label>
        <label>
          <span>Hours worked</span>
          <input type="number" min="0.25" max="24" step="0.25" value={worked} required autoFocus onChange={(e) => setWorked(e.target.value)} />
        </label>
        <label>
          <span>Remaining after</span>
          <input type="number" min="0" step="0.25" value={remaining} placeholder={`${hours(autoRemaining)} (auto)`} onChange={(e) => setRemaining(e.target.value)} />
        </label>
        <label className="grow">
          <span>Note (optional)</span>
          <input value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} placeholder="What you worked on" />
        </label>
        <button className="primary" type="submit" disabled={busy || h <= 0}>{busy ? 'Saving…' : `Log ${h ? hours(h) : ''} h`}</button>
      </form>
      {h > 0 && (
        <p className="small muted">
          Completed {hours(task.completed)} → <strong>{hours(task.completed + h)} h</strong> · Remaining {hours(startRemaining)} → <strong>{hours(remaining === '' ? autoRemaining : Number(remaining))} h</strong>
          {remaining === '' && startRemaining - h < 0 && <span className="warn-text"> (worked past the estimate: remaining stays 0 until the task is closed or re-estimated)</span>}
        </p>
      )}
      {warnings.map((w) => <p key={w} className="warn-text small">⚠ {w}</p>)}
      {logs.length > 0 && (
        <table className="grid list sow-log-history">
          <thead><tr><th scope="col">Date</th><th scope="col" className="num">Hours</th><th scope="col">By</th><th scope="col">Note</th><th><span className="sr-only">Actions</span></th></tr></thead>
          <tbody>
            {logs.map((l) => (
              <tr key={l.id}>
                <td>{dayLabel(l.day)}</td>
                <td className="num">{hours(l.hours)}</td>
                <td className="small">{l.logged_by}</td>
                <td className="small">{l.note || <span className="muted">–</span>}</td>
                <td className="row-actions small">{(isAdmin || l.logged_by_id === userId) && <button className="link danger" disabled={busy} onClick={() => undo(l)}>Undo</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// Work item type as a small icon in Azure DevOps' colours (the type name shows on hover).
const TYPE_ICONS = {
  'User Story': { color: '#009CCC', path: 'M5 3.5h4.5a1.5 1.5 0 0 1 1.5 1.5v8a1.5 1.5 0 0 0-1.5-1.5H5zM11 5a1.5 1.5 0 0 1 1.5-1.5H17v8h-4.5A1.5 1.5 0 0 0 11 13z' },
  Issue: { color: '#B4009E', path: 'M10 4v6.5M10 13.4v.1' },
  Task: { color: '#F2CB1D', path: 'M6 10.2l2.6 2.6L14.2 7' },
  Bug: { color: '#CC293D', path: 'M7.5 8.5h5v4a2.5 2.5 0 0 1-5 0zM8.3 8.5a1.7 1.7 0 0 1 3.4 0M5 10h2.5M12.5 10H15M5.5 13.5l2-1M14.5 13.5l-2-1' },
};
function TypeIcon({ type }) {
  const t = TYPE_ICONS[type] || { color: '#7a8a90', path: 'M6 10h8' };
  return (
    <span className="wi-type" title={type} role="img" aria-label={type}>
      <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
        <rect x="1" y="1" width="18" height="18" rx="4" fill={t.color} />
        <path d={t.path} fill="none" stroke={type === 'Task' ? '#3d3000' : '#fff'} strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  );
}

const days = (n) => `${+n.toFixed(1)} day${n === 1 ? '' : 's'}`;

// A sprint's days: from the earliest start to the latest finish of the sprints shown (the calendar month
// when they have no dates). Saturdays, Sundays and company holidays are off; the rest are working days.
function sprintCalendar(sprints, month, holidays) {
  if (month === 'undated' && !sprints.some((sp) => sp.start_date)) return null;
  const starts = sprints.map((sp) => sp.start_date).filter(Boolean).sort();
  const ends = sprints.map((sp) => sp.finish_date).filter(Boolean).sort();
  const from = starts[0] || `${month}-01`;
  const to = ends[ends.length - 1] || lastOfMonth(month);
  if (to < from) return null;
  const off = new Map(holidays.map((h) => [h.day, h.name]));
  const now = today();
  const days = [];
  for (let d = from; d <= to && days.length < 400; d = addDays(d, 1)) {
    const dow = new Date(`${d}T00:00:00Z`).getUTCDay();
    const weekend = dow === 0 || dow === 6;
    days.push({ day: d, dow, weekend, holiday: off.get(d) || null, working: !weekend && !off.has(d), past: d < now, today: d === now });
  }
  const working = days.filter((x) => x.working);
  return {
    from, to, days,
    working: working.length,
    done: working.filter((x) => x.day <= now).length,
    left: working.filter((x) => x.day > now).length,
    weekends: days.filter((x) => x.weekend).length,
    holidays: days.filter((x) => x.holiday && !x.weekend),
  };
}

// SOW Tracker (everyone): pick a sprint, then see its User Stories and Issues grouped by their Bucket
// (in the picklist's order), each with its Tasks and Bugs. Read from Azure DevOps; nothing is changed.
export default function SowTracker({ isAdmin, user }) {
  const [month, setMonth] = useState('');
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [team, setTeam] = useState('');
  const [client, setClient] = useState('');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState(''); // a state name, '__open' (not closed), or '' for all
  const [openBuckets, setOpenBuckets] = useState(() => new Set());
  const [openItems, setOpenItems] = useState(() => new Set());
  const [showHolidays, setShowHolidays] = useState(false);
  const [newHoliday, setNewHoliday] = useState({ day: '', name: '' });
  const [hoursInput, setHoursInput] = useState('');
  const [notice, setNotice] = useState('');
  const [person, setPerson] = useState(''); // assignee email
  const [personPicked, setPersonPicked] = useState(false); // chosen by hand, so don't change it again
  const [staff, setStaff] = useState(null); // employees, for adding leave (admins)
  const [newLeave, setNewLeave] = useState({ employee_id: '', from_day: '', to_day: '', half: false, note: '' });
  const [logging, setLogging] = useState(null); // task id with the Log time form open
  // The days and hours summary can be collapsed; the choice is remembered in this browser.
  const [showDays, setShowDays] = useState(() => { try { return localStorage.getItem('gf-sprint-days') !== 'hidden'; } catch { return true; } });
  const toggleDays = () => setShowDays((v) => {
    try { localStorage.setItem('gf-sprint-days', v ? 'hidden' : 'shown'); } catch { /* not saved */ }
    return !v;
  });

  const load = (m, refresh = false) => {
    setLoading(true);
    setError('');
    api.sow(m, refresh)
      .then((d) => {
        setData(d);
        setMonth(d.month || '');
        setOpenBuckets(new Set());
        setOpenItems(new Set());
        setHoursInput(String(d.hours_per_day ?? 8));
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  };
  useEffect(() => { load(''); }, []);
  // Until someone picks a person, show the signed-in person's own work when they have any in the sprint.
  useEffect(() => {
    if (personPicked || !data?.buckets) return;
    const me = String(user?.email || '').toLowerCase();
    const mine = me && data.buckets.some((b) => b.items.some((i) => i.assignedEmail === me || i.children.some((c) => c.assignedEmail === me)));
    setPerson(mine ? me : '');
  }, [data, personPicked]);

  if (!data) return error ? <ErrorNote>{error}</ErrorNote> : <Loading />;

  const toggle = (setter) => (key) => setter((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });
  const toggleBucket = toggle(setOpenBuckets);
  const toggleItem = toggle(setOpenItems);

  // Filters: team (area) and client on the User Story / Issue; status and search narrow the Tasks and
  // Bugs too. A search that matches a task shows its story with that task alone; a search that matches
  // the story itself shows the story with all its tasks (still within the status).
  const all = (data.buckets || []).flatMap((b) => b.items);
  const teams = [...new Set(all.map((i) => i.area))].sort();
  const clients = [...new Set(all.map((i) => i.client).filter(Boolean))].sort();
  const states = [...new Set(all.flatMap((i) => [i.state, ...i.children.map((c) => c.state)]).filter(Boolean))].sort();
  const words = search.toLowerCase().split(/\s+/).filter(Boolean);
  const matches = (i) => (!team || i.area === team) && (!client || i.client === client);
  const statusOk = (r) => !status || (status === '__open' ? !r.closed : r.state === status);
  const searchOk = (r) => words.every((w) => [r.id, r.title, r.assignedTo, r.businessImpact, r.effortSize].join(' ').toLowerCase().includes(w));
  const narrowing = Boolean(status || words.length);
  const refine = (i) => {
    if (!narrowing) return i;
    const storyHit = searchOk(i);
    const kids = i.children.filter((c) => statusOk(c) && (storyHit || searchOk(c)));
    if (!kids.length && !(storyHit && statusOk(i))) return null;
    if (kids.length === i.children.length) return i;
    const sum = (k) => kids.reduce((n, c) => n + c[k], 0);
    return { ...i, children: kids, hiddenKids: i.children.length - kids.length, hours: { original: sum('original'), completed: sum('completed'), remaining: sum('remaining') } };
  };
  const peopleNames = new Map();
  for (const i of all) for (const r of [i, ...i.children]) if (r.assignedEmail) peopleNames.set(r.assignedEmail, r.assignedTo || r.assignedEmail);
  const peopleList = [...peopleNames].sort((a, b) => a[1].localeCompare(b[1]));
  const forPerson = (i) => {
    if (!person) return i;
    const kids = i.children.filter((c) => c.assignedEmail === person);
    if (!kids.length && i.assignedEmail !== person) return null;
    const sum = (k) => kids.reduce((n, c) => n + c[k], 0);
    return { ...i, children: kids, hours: { original: sum('original'), completed: sum('completed'), remaining: sum('remaining') } };
  };
  const buckets = (data.buckets || []).map((b) => ({ ...b, items: b.items.map(forPerson).filter(Boolean).map(refine).filter(Boolean).filter(matches) })).filter((b) => b.items.length);
  // While searching or filtering by status, every match is open so it can be seen straight away.
  // (A click still collapses one: the click flips its default.)
  const bucketOpen = (name) => narrowing !== openBuckets.has(name);
  const itemOpen = (i) => (narrowing && i.children.length > 0) !== openItems.has(i.id);

  const stats = (items) => {
    const kids = items.flatMap((i) => i.children);
    const sum = (k) => items.reduce((n, i) => n + i.hours[k], 0);
    return {
      items: items.length,
      closed: items.filter((i) => i.closed).length,
      tasks: kids.length,
      tasksClosed: kids.filter((c) => c.closed).length,
      noEstimate: kids.filter((c) => c.noEstimate && !c.closed).length,
      overrun: kids.filter((c) => c.overrun).length,
      original: sum('original'),
      completed: sum('completed'),
      remaining: sum('remaining'),
    };
  };
  const total = stats(buckets.flatMap((b) => b.items));
  // Time logged (from this app) on the sprint's tasks; who can log on a task.
  const logs = data.logs || [];
  const myEmail = String(user?.email || '').toLowerCase();
  const canLog = (c) => isAdmin || (c.assignedEmail && c.assignedEmail === myEmail);
  const loggedToday = logs.filter((l) => l.day === today() && (!person || l.email === person)).reduce((n, l) => n + l.hours, 0);
  // Business Impact and Effort Size columns (on User Stories and Issues), when Azure DevOps has them.
  const showImpact = Boolean(data.columns?.businessImpact);
  const showEffort = Boolean(data.columns?.effortSize);
  // The sprint's calendar (for the chosen team's sprint when a team is picked) and capacity.
  const holidays = data.holidays || [];
  const hpd = data.hours_per_day || 8;
  const shownSprints = (data.sprints || []).filter((sp) => !team || sp.area === team);
  const cal = sprintCalendar(shownSprints.length ? shownSprints : data.sprints || [], month, holidays);
  const leaves = data.leaves || [];
  // Everyone with work in what's shown (task and bug assignees, else the stories' assignees).
  const emails = person ? [person] : [...new Set(buckets.flatMap((b) => b.items.flatMap((i) => i.children.map((c) => c.assignedEmail).filter(Boolean))))];
  if (!person && !emails.length) emails.push(...new Set(buckets.flatMap((b) => b.items.map((i) => i.assignedEmail).filter(Boolean))));
  const people = emails.length;
  const perPerson = cal ? cal.working * hpd : 0;
  // Each person's working days less their leave, in total and still to come.
  const cap = { leave: 0, available: 0, left: 0 };
  if (cal) {
    for (const e of emails) {
      const lv = leaveIn(cal, leaves, e);
      cap.leave += lv.used;
      cap.available += cal.working - lv.used;
      cap.left += cal.left - lv.left;
    }
  }
  const teamCapacity = cap.available * hpd;
  const leftCapacity = cap.left * hpd;
  const sprintLeaves = cal ? leaves.filter((l) => l.from_day <= cal.to && l.to_day >= cal.from && (!person || l.email === person)) : [];
  // Holidays: add, remove, and hours per day (admins).
  const holidayCall = async (fn, done) => {
    setError('');
    setNotice('');
    try {
      const v = await fn();
      setData((d) => ({ ...d, holidays: v.holidays, hours_per_day: v.hours_per_day, leaves: v.leaves }));
      setHoursInput(String(v.hours_per_day));
      setNotice(done);
      return true;
    } catch (err) { setError(err.message); return false; }
  };
  const addHoliday = async (e) => {
    e.preventDefault();
    if (await holidayCall(() => api.holidays.add(newHoliday.day, newHoliday.name), `Added ${newHoliday.name}.`)) setNewHoliday({ day: '', name: '' });
  };
  const openHolidays = () => {
    setShowHolidays(!showHolidays);
    if (isAdmin && !staff) api.employees.list().then((list) => setStaff(list.filter((e) => e.active))).catch((e) => setError(e.message));
  };
  const addLeave = async (e) => {
    e.preventDefault();
    const body = { ...newLeave, employee_id: Number(newLeave.employee_id), to_day: newLeave.half ? newLeave.from_day : newLeave.to_day || newLeave.from_day };
    const name = staff?.find((x) => x.id === body.employee_id)?.name || 'the employee';
    if (await holidayCall(() => api.holidays.addLeave(body), `Added leave for ${name}.`)) setNewLeave({ employee_id: '', from_day: '', to_day: '', half: false, note: '' });
  };
  const removeLeave = (l) => {
    if (!window.confirm(`Remove ${l.name}'s leave ${leaveLabel(l)}?`)) return;
    holidayCall(() => api.holidays.removeLeave(l.id), `Removed ${l.name}'s leave.`);
  };
  const leaveLabel = (l) => (l.from_day === l.to_day ? `${dayLabel(l.from_day)}${l.half ? ' (half day)' : ''}` : `${dayLabel(l.from_day)} to ${dayLabel(l.to_day)}`);
  const removeHoliday = (h) => {
    if (!window.confirm(`Remove the holiday ${h.name} on ${dayLabel(h.day)}?`)) return;
    holidayCall(() => api.holidays.remove(h.id), `Removed ${h.name}.`);
  };
  const saveHours = (e) => {
    e.preventDefault();
    holidayCall(() => api.holidays.setHours(Number(hoursInput)), 'Hours per day saved.');
  };
  const years = [...new Set(data.months.map((m) => (m.month === 'undated' ? 'undated' : m.month.slice(0, 4))))];
  const year = month === 'undated' ? 'undated' : month.slice(0, 4);

  // The CSV starts with the sprint's summary for what's shown (its dates, the filters, days and hours),
  // then a blank line, then the User Stories / Issues and their Tasks and Bugs.
  const summaryRows = () => {
    const r1 = (n) => +(n || 0).toFixed(2);
    const statusName = status === '__open' ? 'Open (not closed)' : status;
    const filters = [
      team && `Team: ${team}`, client && `Client: ${client}`, person && `Person: ${peopleNames.get(person) || person}`,
      statusName && `Status: ${statusName}`, search.trim() && `Search: ${search.trim()}`,
    ].filter(Boolean).join('; ') || 'None';
    const rows = [
      ['Sprint', shownSprints.length ? [...new Set(shownSprints.map((sp) => sp.name))].join(', ') : month],
      ['From', cal ? cal.from : ''],
      ['To', cal ? cal.to : ''],
      ['Filters', filters],
      ['For', person ? peopleNames.get(person) || person : people ? `Team (${people} ${people === 1 ? 'person' : 'people'})` : 'Everyone'],
    ];
    if (cal) {
      rows.push(
        ['Working days', cal.working],
        ['Weekend days', cal.weekends],
        ['Holidays', cal.holidays.map((h) => `${h.day} ${h.holiday}`).join('; ') || 'None'],
        ['Days done', cal.done],
        ['Days left', cal.left],
      );
      if (people > 0) rows.push(['Leave (days)', r1(cap.leave)], ['Available (days)', r1(cap.available)]);
      rows.push(['Hours per day', hpd]);
      if (people > 0) {
        rows.push(
          ['Capacity (h)', r1(teamCapacity)],
          ['Estimated work (h)', r1(total.original)],
          ['Estimated % of capacity', `${percent(total.original, teamCapacity)}%`],
          ['Remaining capacity (h)', r1(leftCapacity)],
          ['Remaining work (h)', r1(total.remaining)],
          ['Fits?', total.remaining > leftCapacity ? `Over by ${r1(total.remaining - leftCapacity)} h` : `Fits, ${r1(leftCapacity - total.remaining)} h spare`],
        );
      } else rows.push(['Capacity per person (h)', r1(perPerson)]);
    }
    rows.push(
      ['Buckets', buckets.length],
      ['User Stories and Issues', `${total.items} (${total.closed} closed)`],
      ['Tasks and Bugs', `${total.tasks} (${total.tasksClosed} closed)`],
      ['Completed (h)', r1(total.completed)],
      ['Downloaded', new Date().toLocaleString()],
    );
    return rows;
  };

  const exportCsv = () => {
    const header = ['Bucket', 'Level', 'ID', 'Type', 'Title', 'State', 'Business impact', 'Effort size', 'Team', 'Client', 'Assigned to', 'Original', 'Completed', 'Remaining', 'Link'];
    const lines = [];
    for (const b of buckets) {
      for (const i of b.items) {
        lines.push([b.name || 'No bucket', 'Item', i.id, i.type, i.title, i.state, i.businessImpact, i.effortSize, i.area, i.client, i.assignedTo, i.hours.original, i.hours.completed, i.hours.remaining, i.url]);
        for (const c of i.children) lines.push([b.name || 'No bucket', 'Task/Bug', c.id, c.type, c.title, c.state, '', '', c.area, c.client, c.assignedTo, c.original, c.completed, c.remaining, c.url]);
      }
    }
    const csv = [...summaryRows(), [], header, ...lines].map((l) => l.map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
    const url = URL.createObjectURL(new Blob(['\ufeff' + csv], { type: 'text/csv' })); // BOM: Excel reads the dashes and symbols correctly
    const who = person ? `-${(peopleNames.get(person) || 'person').replace(/\s+/g, '-')}` : '';
    const a = Object.assign(document.createElement('a'), { href: url, download: `sprint-${month}${who}.csv` });
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <section>
      <div className="page-head">
        <div>
          <h1>Sprint Tracker</h1>
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
      {notice && <p className="ok-text small" role="status">{notice}</p>}
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
            {peopleList.length > 0 && (
              <label className="wi-filter">
                <span>Person</span>
                <select value={person} onChange={(e) => { setPerson(e.target.value); setPersonPicked(true); }}>
                  <option value="">Everyone</option>
                  {peopleList.map(([email, name]) => <option key={email} value={email}>{name}</option>)}
                </select>
              </label>
            )}
            <label className="wi-filter">
              <span>Status</span>
              <select value={status} onChange={(e) => { setStatus(e.target.value); setOpenBuckets(new Set()); setOpenItems(new Set()); }}>
                <option value="">All statuses</option>
                <option value="__open">Open (not closed)</option>
                {states.map((st) => <option key={st} value={st}>{st}</option>)}
              </select>
            </label>
            <input type="search" value={search} onChange={(e) => { setSearch(e.target.value); setOpenBuckets(new Set()); setOpenItems(new Set()); }} placeholder="Search ID, title or person" aria-label="Search" />
            {narrowing && <button className="link" onClick={() => { setSearch(''); setStatus(''); }}>Clear filters</button>}
            {buckets.length > 0 && !narrowing && (
              <button className="link" onClick={() => setOpenBuckets(openBuckets.size ? new Set() : new Set(buckets.map((b) => b.name)))}>
                {openBuckets.size ? 'Collapse all' : 'Expand all'}
              </button>
            )}
          </div>

          {cal && (
            <div className="sow-calendar">
              <div className="sow-cal-head">
                <button type="button" className="drill" aria-expanded={showDays} onClick={toggleDays}
                  title={showDays ? 'Hide the days and hours' : 'Show the days and hours'}>
                  <span className="drill-caret" aria-hidden="true">▸</span>
                  {shownSprints.length ? [...new Set(shownSprints.map((sp) => sp.name))].join(', ') : 'Sprint'}
                </button>
                <span className="muted"> · {dayLabel(cal.from)} to {dayLabel(cal.to)}</span>
                {/* Collapsed: the key figures on one line. */}
                {!showDays && (
                  <span className="sow-cal-brief">
                    {' '}· {days(cal.left)} left of {cal.working}
                    {people > 0 && <> · capacity {hours(teamCapacity) || 0} h · remaining work {hours(total.remaining) || 0} h of {hours(leftCapacity) || 0} h{' '}
                      {total.remaining > leftCapacity
                        ? <span className="sow-flag overrun">Over by {hours(total.remaining - leftCapacity)} h</span>
                        : <span className="sow-fit">Fits</span>}</>}
                  </span>
                )}
              </div>
              {showDays && (<>
              {/* The sprint's days and hours, one figure per line: days on the left, hours on the right. */}
              <div className="sow-figures">
                <dl className="sow-dl">
                  <dt className="sow-dl-title">{person ? peopleNames.get(person) : people ? `Team · ${people} ${people === 1 ? 'person' : 'people'}` : 'Sprint'}</dt>
                  <dd className="sow-dl-title" />
                  <dt>Working days</dt>
                  <dd><strong>{cal.working}</strong> <small className="muted">({cal.weekends} weekend days{cal.holidays.length ? `, ${cal.holidays.length} holiday${cal.holidays.length === 1 ? '' : 's'}` : ''} off)</small></dd>
                  <dt>Done so far</dt>
                  <dd><strong>{days(cal.done)}</strong></dd>
                  <dt>Left</dt>
                  <dd><strong>{days(cal.left)}</strong></dd>
                  {people > 0 && (
                    <>
                      <dt>Leave</dt>
                      <dd><strong>{days(cap.leave)}</strong></dd>
                      <dt>Available</dt>
                      <dd><strong>{days(cap.available)}</strong> <small className="muted">{person ? '(working days − leave)' : '(everyone\'s working days − leave)'}</small></dd>
                    </>
                  )}
                </dl>
                <dl className="sow-dl">
                  <dt className="sow-dl-title">Hours</dt>
                  <dd className="sow-dl-title" />
                  <dt>Hours per day</dt>
                  <dd><strong>{hpd} h</strong></dd>
                  {people > 0 ? (
                    <>
                      <dt>Capacity</dt>
                      <dd><strong>{hours(teamCapacity) || 0} h</strong> <small className="muted">({days(cap.available)} × {hpd} h)</small></dd>
                      <dt>Estimated work</dt>
                      <dd>
                        <strong>{hours(total.original) || 0} h</strong>{' '}
                        <small className={total.original > teamCapacity ? 'warn-text' : 'muted'}>({percent(total.original, teamCapacity)}% of capacity)</small>
                      </dd>
                      <dt>Remaining capacity</dt>
                      <dd><strong>{hours(leftCapacity) || 0} h</strong> <small className="muted">(days left × {hpd} h)</small></dd>
                      <dt>Remaining work</dt>
                      <dd>
                        <strong>{hours(total.remaining) || 0} h</strong>{' '}
                        {total.remaining > leftCapacity
                          ? <span className="sow-flag overrun">Over by {hours(total.remaining - leftCapacity)} h</span>
                          : <span className="sow-fit">Fits · {hours(leftCapacity - total.remaining) || 0} h spare</span>}
                      </dd>
                    </>
                  ) : (
                    <>
                      <dt>Capacity per person</dt>
                      <dd><strong>{hours(perPerson) || 0} h</strong> <small className="muted">({cal.working} × {hpd} h)</small></dd>
                    </>
                  )}
                </dl>
              </div>
              <div className="sow-cal-days" role="list" aria-label="Sprint days">
                {cal.days.map((x) => (
                  <span key={x.day} role="listitem"
                    className={`sow-day${x.working ? (person && leaveOn(leaves, person, x.day) ? (leaveOn(leaves, person, x.day) < 1 ? ' leave half' : ' leave') : '') : x.holiday && !x.weekend ? ' holiday' : ' weekend'}${x.past ? ' past' : ''}${x.today ? ' today' : ''}`}
                    title={`${WEEKDAY[x.dow]} ${dayLabel(x.day)}${x.holiday ? ` · ${x.holiday}` : x.weekend ? ' · Weekend' : person && leaveOn(leaves, person, x.day) ? (leaveOn(leaves, person, x.day) < 1 ? ' · Half day leave' : ' · Leave') : ' · Working day'}${x.today ? ' · Today' : ''}`}>
                    <small>{WEEKDAY[x.dow].slice(0, 2)}</small>{+x.day.slice(8)}
                  </span>
                ))}
              </div>
              {cal.holidays.length > 0 && (
                <p className="small sow-cal-holidays">Holidays: {cal.holidays.map((h) => `${dayLabel(h.day)} ${h.holiday}`).join(' · ')}</p>
              )}
              {sprintLeaves.length > 0 && (
                <p className="small sow-cal-leaves">Leave: {sprintLeaves.map((l) => `${person ? '' : `${l.name} `}${leaveLabel(l)}`).join(' · ')}</p>
              )}
              </>)}
            </div>
          )}

          <p className="small sow-total">
            <strong>{buckets.length}</strong> bucket{buckets.length === 1 ? '' : 's'} · <strong>{total.items}</strong> User Stories and Issues,
            {' '}{total.closed} closed ({percent(total.closed, total.items)}%) · {total.tasks} tasks and bugs, {total.tasksClosed} closed ·
            {' '}Estimated {hours(total.original)} h · Completed {hours(total.completed)} h · Remaining {hours(total.remaining)} h
            {data.fetchedAt && <span className="muted"> · Read {new Date(data.fetchedAt).toLocaleTimeString()}</span>}
            {total.noEstimate > 0 && <span className="sow-flag no-eta">{total.noEstimate} open task{total.noEstimate === 1 ? '' : 's'} with no estimate</span>}
            {total.overrun > 0 && <span className="sow-flag overrun">{total.overrun} with 0 h left but not closed</span>}
            {loggedToday > 0 && <span> · Logged today {person ? `by ${peopleNames.get(person)}` : ''}: <strong>{hours(loggedToday)} h</strong></span>}
          </p>

          {buckets.length === 0 ? (
            <div className="empty"><p>{all.length ? 'Nothing matches these filters.' : 'No User Stories or Issues in this sprint.'}</p></div>
          ) : buckets.map((b) => {
            const st = stats(b.items);
            const open = bucketOpen(b.name);
            return (
              <section key={b.name || '(none)'} className="sow-bucket">
                <button type="button" className="drill sow-bucket-head" aria-expanded={open} onClick={() => toggleBucket(b.name)}>
                  <span className="drill-caret" aria-hidden="true">▸</span>
                  <span className="sow-bucket-name">{b.name || 'No bucket'}</span>
                  <span className="small sow-bucket-stats">
                    {st.items} item{st.items === 1 ? '' : 's'} · {st.closed} closed
                    <span className="wi-bar sow-bar" role="img" aria-label={`${percent(st.closed, st.items)}% closed`}><span style={{ width: `${percent(st.closed, st.items)}%` }} /></span>
                    {percent(st.closed, st.items)}% · {st.tasks} tasks/bugs · Est {hours(st.original)} h · Done {hours(st.completed)} h · Left {hours(st.remaining)} h
                    {st.noEstimate > 0 && <span className="sow-flag no-eta">{st.noEstimate} no estimate</span>}
                    {st.overrun > 0 && <span className="sow-flag overrun">{st.overrun} 0 h left · not closed</span>}
                  </span>
                </button>
                {open && (
                  <div className="table-wrap">
                    <table className="grid list wi-table">
                      <thead>
                        <tr>
                          <th scope="col" className="wi-title">Title</th><th scope="col">State</th>
                          {showImpact && <th scope="col">Business impact</th>}{showEffort && <th scope="col">Effort size</th>}
                          <th scope="col">Team</th>{clients.length > 0 && <th scope="col">Client</th>}<th scope="col">Assigned to</th>
                          <th scope="col" className="num">Original</th><th scope="col" className="num">Completed</th><th scope="col" className="num">Remaining</th>
                        </tr>
                      </thead>
                      <tbody>
                        {b.items.map((i) => {
                          const shown = itemOpen(i);
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
                                  {' '}<TypeIcon type={i.type} /><a href={i.url} target="_blank" rel="noreferrer">{i.id}</a> {i.title}
                                  {i.children.length > 0 && <small className="muted"> ({i.children.length}{i.hiddenKids ? ` of ${i.children.length + i.hiddenKids}` : ''})</small>}
                                </th>
                                <td className={i.closed ? 'ok-text' : ''}>{i.state}</td>
                                {showImpact && <td>{i.businessImpact || <span className="muted">–</span>}</td>}
                                {showEffort && <td>{i.effortSize || <span className="muted">–</span>}</td>}
                                <td className="small" title={i.areaPath}>{i.area}</td>
                                {clients.length > 0 && <td>{i.client}</td>}
                                <td>{i.assignedTo ? <WithAvatar email={i.assignedEmail} name={i.assignedTo} size={20} /> : <span className="muted">Unassigned</span>}</td>
                                <td className="num">{hours(i.hours.original)}</td>
                                <td className="num">{hours(i.hours.completed)}</td>
                                <td className="num">{hours(i.hours.remaining)}</td>
                              </tr>
                              {shown && i.children.map((c) => (
                                <Fragment key={c.id}>
                                <tr className={`wi-child${c.overrun ? ' row-overrun' : c.noEstimate && !c.closed ? ' row-no-eta' : ''}`}>
                                  <th scope="row" className="wi-title" title={`${c.id} ${c.title}`}>
                                    <TypeIcon type={c.type} /><a href={c.url} target="_blank" rel="noreferrer">{c.id}</a> {c.title}
                                    {c.noEstimate && !c.closed && <span className="sow-flag no-eta">No estimate</span>}
                                    {c.overrun && <span className="sow-flag overrun">0 h left · not closed</span>}
                                    {canLog(c) && (
                                      <button className="link small sow-log-btn" onClick={() => setLogging(logging === c.id ? null : c.id)}>
                                        {logging === c.id ? 'Close' : 'Log time'}
                                      </button>
                                    )}
                                    {logs.some((l) => l.task_id === c.id) && logging !== c.id && (
                                      <small className="muted"> · {hours(logs.filter((l) => l.task_id === c.id).reduce((n, l) => n + l.hours, 0))} h logged here</small>
                                    )}
                                  </th>
                                  <td className={c.closed ? 'ok-text' : ''}>{c.state}</td>
                                  {showImpact && <td />}{showEffort && <td />}
                                  <td className="small" title={c.areaPath}>{c.area}</td>
                                  {clients.length > 0 && <td>{c.client}</td>}
                                  <td>{c.assignedTo ? <WithAvatar email={c.assignedEmail} name={c.assignedTo} size={20} /> : <span className="muted">Unassigned</span>}</td>
                                  <td className="num">{hours(c.original)}</td>
                                  <td className="num">{hours(c.completed)}</td>
                                  <td className="num">{hours(c.remaining)}</td>
                                </tr>
                                {logging === c.id && (
                                  <tr className="sow-log-row">
                                    <td colSpan={7 + (showImpact ? 1 : 0) + (showEffort ? 1 : 0) + (clients.length > 0 ? 1 : 0)}>
                                      <LogTime task={c} logs={logs.filter((l) => l.task_id === c.id)} allLogs={logs} holidays={holidays} leaves={leaves} hpd={hpd}
                                        isAdmin={isAdmin} userId={user?.id}
                                        onDone={(msg) => { setLogging(null); setNotice(msg); load(month); }} onError={setError} />
                                    </td>
                                  </tr>
                                )}
                                </Fragment>
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

      <h2>
        <button type="button" className="drill" aria-expanded={showHolidays} onClick={openHolidays}>
          <span className="drill-caret" aria-hidden="true">▸</span>Holidays ({holidays.length}) &amp; leave ({leaves.length})
        </button>
      </h2>
      {showHolidays && (
        <div className="sow-holidays">
          <p className="muted small">Saturdays and Sundays are always off. These company holidays apply to every team; working days and capacity leave them out. Leave is taken off that person's working days (pick them in Person to see theirs).</p>
          <h3>Company holidays</h3>
          {holidays.length === 0 ? <p className="muted">No holidays added yet.</p> : (
            <div className="table-wrap">
              <table className="grid list">
                <thead><tr><th scope="col">Date</th><th scope="col">Day</th><th scope="col">Holiday</th>{isAdmin && <th><span className="sr-only">Actions</span></th>}</tr></thead>
                <tbody>
                  {holidays.map((h) => (
                    <tr key={h.id} className={h.day < today() ? 'muted' : undefined}>
                      <td>{dayLabel(h.day)}</td>
                      <td>{WEEKDAY[new Date(`${h.day}T00:00:00Z`).getUTCDay()]}</td>
                      <th scope="row">{h.name}</th>
                      {isAdmin && <td className="row-actions small"><button className="link danger" onClick={() => removeHoliday(h)}>Remove</button></td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {isAdmin && (
            <>
              <form className="row" onSubmit={addHoliday}>
                <label>
                  <span>Date</span>
                  <input type="date" value={newHoliday.day} onChange={(e) => setNewHoliday({ ...newHoliday, day: e.target.value })} required />
                </label>
                <label className="grow">
                  <span>Holiday name</span>
                  <input value={newHoliday.name} maxLength={100} placeholder="For example Diwali" onChange={(e) => setNewHoliday({ ...newHoliday, name: e.target.value })} required />
                </label>
                <button className="secondary" type="submit">Add holiday</button>
              </form>
              <h3>Employee leave</h3>
              {leaves.length === 0 ? <p className="muted small">No leave added yet.</p> : (
                <div className="table-wrap">
                  <table className="grid list">
                    <thead><tr><th scope="col">Employee</th><th scope="col">Leave</th><th scope="col">Note</th><th><span className="sr-only">Actions</span></th></tr></thead>
                    <tbody>
                      {leaves.map((l) => (
                        <tr key={l.id} className={l.to_day < today() ? 'muted' : undefined}>
                          <th scope="row">{l.name}</th>
                          <td>{leaveLabel(l)}</td>
                          <td className="small">{l.note || <span className="muted">–</span>}</td>
                          <td className="row-actions small"><button className="link danger" onClick={() => removeLeave(l)}>Remove</button></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <form className="row" onSubmit={addLeave}>
                <label>
                  <span>Employee</span>
                  <select value={newLeave.employee_id} required onChange={(e) => setNewLeave({ ...newLeave, employee_id: e.target.value })}>
                    <option value="">Choose…</option>
                    {(staff || []).map((x) => <option key={x.id} value={x.id}>{x.name}{x.email ? '' : ' (no email)'}</option>)}
                  </select>
                </label>
                <label>
                  <span>From</span>
                  <input type="date" value={newLeave.from_day} required onChange={(e) => setNewLeave({ ...newLeave, from_day: e.target.value, to_day: newLeave.to_day && newLeave.to_day >= e.target.value ? newLeave.to_day : e.target.value })} />
                </label>
                {!newLeave.half && (
                  <label>
                    <span>To</span>
                    <input type="date" value={newLeave.to_day} min={newLeave.from_day} onChange={(e) => setNewLeave({ ...newLeave, to_day: e.target.value })} />
                  </label>
                )}
                <label className="check">
                  <input type="checkbox" checked={newLeave.half} onChange={(e) => setNewLeave({ ...newLeave, half: e.target.checked })} /> Half day
                </label>
                <label className="grow">
                  <span>Note (optional)</span>
                  <input value={newLeave.note} maxLength={200} placeholder="For example Sick leave" onChange={(e) => setNewLeave({ ...newLeave, note: e.target.value })} />
                </label>
                <button className="secondary" type="submit">Add leave</button>
              </form>

              <h3>Hours</h3>
              <form className="row" onSubmit={saveHours}>
                <label>
                  <span>Working hours per day</span>
                  <input type="number" min="0.5" max="24" step="0.5" value={hoursInput} onChange={(e) => setHoursInput(e.target.value)} required />
                </label>
                <button className="secondary" type="submit">Save</button>
              </form>
            </>
          )}
        </div>
      )}
    </section>
  );
}
