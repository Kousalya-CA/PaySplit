import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { dayLabel, monthLabel } from '../format.js';

// PIP and Relieved (admins only; pay isn't affected). An employee's name is highlighted in the months
// of a PIP, and from their relieved month on. Months are 'YYYY-MM'; a range is From..To.
export function empFlags(emp, from, to = from) {
  if (!emp || !from) return [];
  const flags = [];
  const pips = (emp.pips || []).filter((p) => p.from_month <= to && p.to_month >= from);
  if (pips.length) {
    flags.push({
      kind: 'pip',
      label: 'PIP',
      title: pips.map((p) => `PIP ${monthLabel(p.from_month)} to ${monthLabel(p.to_month)}${p.comment ? `: ${p.comment}` : ''}`).join('\n'),
    });
  }
  const relievedMonth = emp.relieved_on?.slice(0, 7);
  if (relievedMonth && to >= relievedMonth) {
    flags.push({ kind: 'relieved', label: 'Relieved', title: `Relieved ${dayLabel(emp.relieved_on)}${emp.relieved_note ? `: ${emp.relieved_note}` : ''}` });
  }
  return flags;
}

// A year column ('2027') covers Jan to Dec.
export const columnRange = (col) => (/^\d{4}$/.test(col) ? [`${col}-01`, `${col}-12`] : [col, col]);

// Highlight classes for a table cell in that month (or range).
export const flagClass = (emp, from, to = from) => empFlags(emp, from, to).map((f) => `cell-${f.kind}`).join(' ') || undefined;

// Just the PIP / Relieved tags, for next to a name shown elsewhere.
export function EmpTags({ emp, from, to = from }) {
  return empFlags(emp, from, to).map((f) => (
    <span key={f.kind} className={`emp-tag emp-tag-${f.kind}`} title={f.title}>{f.label}</span>
  ));
}

// The name, highlighted (with its tags) when the employee is on a PIP or relieved in those months.
export function EmpName({ emp, name, from, to = from, children }) {
  const flags = empFlags(emp, from, to);
  const shown = children ?? name;
  if (!flags.length) return shown;
  return (
    <span className={`emp-flagged ${flags.map((f) => `emp-${f.kind}`).join(' ')}`} title={flags.map((f) => f.title).join('\n')}>
      {shown}
      {flags.map((f) => <span key={f.kind} className={`emp-tag emp-tag-${f.kind}`}>{f.label}</span>)}
    </span>
  );
}

// Employees by id with their PIPs and relieved date, for pages that only have names. Empty for
// employee logins (the API doesn't send these to them).
export function useEmployeeMap(enabled = true) {
  const [map, setMap] = useState(() => new Map());
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    api.employees.list().then((list) => { if (live) setMap(new Map(list.map((e) => [e.id, e]))); }).catch(() => {});
    return () => { live = false; };
  }, [enabled]);
  return map;
}

// Today's month, for "is this employee on a PIP / relieved now".
export const thisMonth = () => new Date().toISOString().slice(0, 7);
