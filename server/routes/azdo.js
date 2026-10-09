// Azure DevOps sprint board: settings (organisation, project, area paths and their sprints) and
// each employee's work by month, found by their email: User Stories and Issues with their child
// Tasks and Bugs.
// The PAT is read from the AZ_PAT environment variable only; it's never stored or sent to the browser.
import { db } from '../db.js';
import { HttpError } from '../http.js';
import { isAdmin, myEmployeeId } from './data.js';

const API_VERSION = '7.1';
const BATCH = 200; // work items per call (the API's limit)

const q = {
  setting: db.prepare('SELECT value FROM azdo_settings WHERE key = ?'),
  saveSetting: db.prepare(`
    INSERT INTO azdo_settings (key, value) VALUES (?, ?)
    ON CONFLICT (key) DO UPDATE SET value = excluded.value`),
  areas: db.prepare('SELECT * FROM azdo_areas ORDER BY path'),
  area: db.prepare('SELECT * FROM azdo_areas WHERE id = ?'),
  insertArea: db.prepare('INSERT INTO azdo_areas (path, name, display_name) VALUES (?, ?, ?)'),
  renameArea: db.prepare('UPDATE azdo_areas SET display_name = ? WHERE id = ?'),
  deleteArea: db.prepare('DELETE FROM azdo_areas WHERE id = ?'),
  iterations: db.prepare('SELECT * FROM azdo_iterations ORDER BY start_date DESC, path'),
  iteration: db.prepare('SELECT * FROM azdo_iterations WHERE id = ?'),
  insertIteration: db.prepare(`
    INSERT INTO azdo_iterations (area_id, path, name, start_date, finish_date) VALUES (?, ?, ?, ?, ?)`),
  updateIteration: db.prepare('UPDATE azdo_iterations SET name = ?, start_date = ?, finish_date = ? WHERE id = ?'),
  deleteIteration: db.prepare('DELETE FROM azdo_iterations WHERE id = ?'),
  employee: db.prepare('SELECT id, employee_code, name, email, type, active FROM employees WHERE id = ?'),
  customer: db.prepare('SELECT id, name, azdo_client FROM customers WHERE id = ?'),
  employeesWithEmail: db.prepare('SELECT id, name, email, active FROM employees WHERE email IS NOT NULL'),
  splitEmployees: db.prepare(`
    SELECT DISTINCT a.employee_id FROM allocations a JOIN periods p ON p.id = a.period_id WHERE p.customer_id = ?`),
};

const settings = () => ({
  org: q.setting.get('org')?.value || '',
  project: q.setting.get('project')?.value || '',
  pat: process.env.AZ_PAT || '',
});

function requireSettings() {
  const s = settings();
  if (!s.org || !s.project) throw new HttpError(400, 'Set the Azure DevOps organisation and project on the Azure DevOps page first.');
  if (!s.pat) throw new HttpError(400, 'The AZ_PAT setting is missing on the server, so Azure DevOps can\'t be reached.');
  return s;
}

// Call the Azure DevOps REST API for the configured project. Errors become readable messages.
async function azFetch(s, path, { method = 'GET', body } = {}) {
  const sep = path.includes('?') ? '&' : '?';
  const url = `https://dev.azure.com/${encodeURIComponent(s.org)}/${encodeURIComponent(s.project)}/_apis/${path}${sep}api-version=${API_VERSION}`;
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: {
        Authorization: `Basic ${Buffer.from(`:${s.pat}`).toString('base64')}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      redirect: 'manual',
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    throw new HttpError(502, 'Couldn\'t reach Azure DevOps. Try again in a moment.');
  }
  // A bad or expired PAT gets a sign-in page (203/302) or 401 instead of JSON.
  if ([203, 302, 401].includes(res.status)) {
    throw new HttpError(502, 'Azure DevOps didn\'t accept the PAT. Check AZ_PAT is valid and has Work Items (Read) access.');
  }
  const data = await res.json().catch(() => null);
  // Pass on Azure DevOps' own reason so it's clear which permission or policy is missing.
  if (res.status === 403) {
    const reason = data?.message ? ` Azure DevOps said: ${data.message}` : '';
    throw new HttpError(502, `Azure DevOps refused access to ${s.org}/${s.project}. The PAT must be made in the ${s.org} organisation, with Work Items (Read), by someone who can open this project.${reason}`);
  }
  if (res.status === 404) return null;
  if (!res.ok) throw new HttpError(502, `Azure DevOps said: ${data?.message || `error ${res.status}`}`);
  return data;
}

// Accept 'Trisul.Org\Sprint 3', 'Trisul.Org\\Sprint 3', 'Trisul.Org/Sprint 3' or the full
// '\Trisul.Org\Iteration\Sprint 3' form, and return the path as WIQL uses it plus the part
// after the project name (for the classification node API).
function parsePath(input, project, kind) {
  const label = kind === 'Iterations' ? 'iteration path' : 'area path';
  let parts = String(input ?? '').trim().split(/[\\/]+/).map((p) => p.trim()).filter(Boolean);
  if (!parts.length) throw new HttpError(400, `Enter the ${label}.`);
  if (parts[0].toLowerCase() !== project.toLowerCase()) {
    throw new HttpError(400, `The ${label} has to start with the project name, for example ${project}\\${kind === 'Iterations' ? 'Sprint 3' : 'Team name'}.`);
  }
  // Full form: '\Project\Iteration\...' or '\Project\Area\...'
  const marker = kind === 'Iterations' ? 'iteration' : 'area';
  if (parts[1]?.toLowerCase() === marker) parts = [parts[0], ...parts.slice(2)];
  return { path: parts.join('\\'), relative: parts.slice(1) };
}

// Look up an area or iteration in Azure DevOps. Returns { path, name, startDate, finishDate } or
// throws. The path uses Azure DevOps' own capitals. isTaken(path) rejects duplicates before the call.
async function lookupNode(s, kind, input, isTaken = () => false) {
  const { path, relative } = parsePath(input, s.project, kind);
  if (isTaken(path)) throw new HttpError(409, `${path} is already added.`);
  const node = await azFetch(s, `wit/classificationnodes/${kind}${relative.map((p) => `/${encodeURIComponent(p)}`).join('')}`);
  if (!node) throw new HttpError(404, `${path} wasn't found in Azure DevOps project ${s.project}.`);
  const day = (iso) => (iso ? String(iso).slice(0, 10) : null);
  // node.path looks like '\Trisul.Org\Iteration\Sprint 3'; use it for the exact capitals if it parses.
  let canonical = path;
  try { if (node.path) canonical = parsePath(node.path, s.project, kind).path; } catch { /* keep the typed path */ }
  return { path: canonical, name: node.name, startDate: day(node.attributes?.startDate), finishDate: day(node.attributes?.finishDate) };
}

const isUnique = (err) => /UNIQUE constraint failed/i.test(err?.message || '');

function parseDisplayName(value) {
  const name = String(value ?? '').trim();
  if (name.length > 60) throw new HttpError(400, 'Keep the display name to 60 characters or fewer.');
  return name || null;
}
const esc = (text) => String(text).replace(/'/g, "''"); // WIQL string literal

function configView() {
  const s = settings();
  const iterations = q.iterations.all();
  return {
    org: s.org,
    project: s.project,
    patSet: Boolean(s.pat),
    areas: q.areas.all().map((a) => ({ ...a, iterations: iterations.filter((i) => i.area_id === a.id) })),
  };
}

// Fetch work items with all their fields and their links (for a parent's child tasks and bugs).
async function workItemsWithLinks(s, ids) {
  const items = [];
  for (let i = 0; i < ids.length; i += BATCH) {
    const data = await azFetch(s, `wit/workitems?ids=${ids.slice(i, i + BATCH).join(',')}&$expand=relations&errorPolicy=omit`);
    items.push(...(data?.value || []).filter(Boolean));
  }
  return items;
}

const F = {
  title: 'System.Title', state: 'System.State', type: 'System.WorkItemType', area: 'System.AreaPath',
  iteration: 'System.IterationPath', parent: 'System.Parent', assignedTo: 'System.AssignedTo',
  original: 'Microsoft.VSTS.Scheduling.OriginalEstimate',
  completed: 'Microsoft.VSTS.Scheduling.CompletedWork',
  remaining: 'Microsoft.VSTS.Scheduling.RemainingWork',
};
const PARENT_TYPES = ['User Story', 'Issue'];
const CHILD_TYPES = ['Task', 'Bug'];

// The reference name of the custom field called "Client" (e.g. Custom.Client), looked up once per
// project. null if the project has no such field.
const clientFieldCache = new Map();
async function clientField(s) {
  const key = `${s.org}/${s.project}`;
  if (!clientFieldCache.has(key)) {
    const data = await azFetch(s, 'wit/fields');
    const field = (data?.value || []).find((f) => f.name?.toLowerCase() === 'client')
      || (data?.value || []).find((f) => /\.client$/i.test(f.referenceName || ''));
    clientFieldCache.set(key, field?.referenceName || null);
  }
  return clientFieldCache.get(key);
}

// Each work item type's states and their Azure DevOps category (Proposed, InProgress, Resolved,
// Completed or Removed), looked up once per project, so custom state names are handled too.
// Map of 'type' -> Map of 'state' (lower case) -> category.
const statesCache = new Map();
async function stateCategories(s) {
  const key = `${s.org}/${s.project}`;
  if (!statesCache.has(key)) {
    const byType = new Map();
    for (const type of [...PARENT_TYPES, ...CHILD_TYPES]) {
      const data = await azFetch(s, `wit/workitemtypes/${encodeURIComponent(type)}/states`);
      byType.set(type, new Map((data?.value || []).map((st) => [String(st.name).toLowerCase(), st.category])));
    }
    statesCache.set(key, byType);
  }
  return statesCache.get(key);
}

// A state's category, guessed from common names if the type's states couldn't be read.
function stateCategory(states, type, state) {
  const name = String(state || '').toLowerCase();
  const known = states?.get(type)?.get(name);
  if (known) return known;
  if (['closed', 'done', 'completed'].includes(name)) return 'Completed';
  if (name === 'resolved') return 'Resolved';
  if (name === 'removed') return 'Removed';
  return name === 'new' || name === 'proposed' || name === 'to do' ? 'Proposed' : 'InProgress';
}

// The label for a work item's area: the display name (or name) of the configured area path it's
// under, picking the longest match; otherwise its path without the project name.
function areaLabel(path, areas) {
  const p = String(path || '').toLowerCase();
  const match = areas
    .filter((a) => p === a.path.toLowerCase() || p.startsWith(`${a.path.toLowerCase()}\\`))
    .sort((x, y) => y.path.length - x.path.length)[0];
  return match ? match.display_name || match.name : String(path || '').split('\\').slice(1).join('\\') || path;
}

// One table row from a work item.
function toRow(s, w, client, mine, areas, states) {
  const f = w.fields || {};
  const assigned = f[F.assignedTo];
  const assignedEmail = String(assigned?.uniqueName || '').toLowerCase();
  const clientValue = client ? f[client] : null;
  return {
    id: w.id,
    type: f[F.type],
    title: f[F.title],
    state: f[F.state],
    stateCategory: stateCategory(states, f[F.type], f[F.state]),
    areaPath: f[F.area],
    area: areaLabel(f[F.area], areas),
    iterationPath: f[F.iteration],
    client: clientValue == null ? '' : typeof clientValue === 'object' ? clientValue.displayName ?? '' : String(clientValue),
    assignedTo: assigned?.displayName || '',
    mine: assignedEmail === mine,
    original: f[F.original] ?? null,
    completed: f[F.completed] ?? null,
    remaining: f[F.remaining] ?? null,
    url: `https://dev.azure.com/${encodeURIComponent(s.org)}/${encodeURIComponent(s.project)}/_workitems/edit/${w.id}`,
  };
}

const childIdsOf = (w) => (w.relations || [])
  .filter((r) => r.rel === 'System.LinkTypes.Hierarchy-Forward')
  .map((r) => Number(String(r.url).split('/').pop()))
  .filter(Number.isFinite);

// Sprints grouped by the month they start in ('2026-10'), or 'undated' when Azure DevOps has no dates.
function sprintMonths(areas) {
  const months = new Map();
  for (const a of areas) {
    for (const it of a.iterations) {
      const key = it.start_date ? it.start_date.slice(0, 7) : 'undated';
      if (!months.has(key)) months.set(key, { month: key, sprints: [] });
      months.get(key).sprints.push({ id: it.id, name: it.name, path: it.path, start_date: it.start_date, finish_date: it.finish_date, area: a.display_name || a.name, areaPath: a.path });
    }
  }
  return [...months.values()].sort((x, y) => (x.month === 'undated' ? 1 : y.month === 'undated' ? -1 : y.month.localeCompare(x.month)));
}

// ---------- a customer's work -------------------------------------------------
const CUSTOMER_WORK_TTL = 5 * 60 * 1000;
const customerWorkCache = new Map();

const isUnder = (path, parent) => {
  const p = String(path || '').toLowerCase();
  const top = String(parent).toLowerCase();
  return p === top || p.startsWith(`${top}\\`);
};

// The month of the configured sprint a work item is in (by area path and iteration path), or null.
function monthOf(fields, months) {
  const m = months.find((x) => x.sprints.some((sp) => isUnder(fields[F.area], sp.areaPath) && isUnder(fields[F.iteration], sp.path)));
  return m ? m.month : null;
}

// Every work item for a customer in the configured sprints, as small records with the month,
// closed flag and hours. Removed items are left out. A Task or Bug whose Client is empty counts
// when its parent matches; one with another client never does.
async function customerItems(s, client, clientNames, months) {
  const pairs = months.flatMap((m) => m.sprints).map((sp) =>
    `([System.AreaPath] UNDER '${esc(sp.areaPath)}' AND [System.IterationPath] UNDER '${esc(sp.path)}')`);
  const types = [...PARENT_TYPES, ...CHILD_TYPES].map((t) => `'${t}'`).join(', ');
  const query = `SELECT [System.Id] FROM WorkItems
    WHERE [System.TeamProject] = @project AND [System.WorkItemType] IN (${types})
      AND [${client}] IN (${clientNames.map((n) => `'${esc(n)}'`).join(', ')}) AND (${pairs.join(' OR ')})
    ORDER BY [System.Id]`;
  const found = await azFetch(s, 'wit/wiql', { method: 'POST', body: { query } });
  const items = new Map((await workItemsWithLinks(s, (found?.workItems || []).map((w) => w.id))).map((w) => [w.id, w]));

  // Tasks and Bugs under the matched User Stories and Issues.
  const childIds = [...new Set([...items.values()]
    .filter((w) => PARENT_TYPES.includes(w.fields[F.type]))
    .flatMap(childIdsOf)
    .filter((id) => !items.has(id)))];
  const wanted = new Set(clientNames.map((n) => n.toLowerCase()));
  for (const w of await workItemsWithLinks(s, childIds)) {
    const value = w.fields[client];
    const name = String(value == null ? '' : typeof value === 'object' ? value.displayName ?? '' : value).trim().toLowerCase();
    if (CHILD_TYPES.includes(w.fields[F.type]) && (!name || wanted.has(name))) items.set(w.id, w);
  }

  const states = await stateCategories(s);
  const records = [];
  for (const w of items.values()) {
    const f = w.fields || {};
    const month = monthOf(f, months);
    const category = stateCategory(states, f[F.type], f[F.state]);
    if (!month || category === 'Removed') continue;
    records.push({
      id: w.id,
      type: f[F.type],
      month,
      closed: category === 'Completed' || category === 'Resolved',
      email: String(f[F.assignedTo]?.uniqueName || '').toLowerCase(),
      assignedTo: f[F.assignedTo]?.displayName || '',
      original: f[F.original] || 0,
      completed: f[F.completed] || 0,
      remaining: f[F.remaining] || 0,
    });
  }
  return records;
}
export function registerAzdoRoutes(router) {
  const admin = { admin: true };

  router.get('/api/azdo/config', () => configView(), admin);

  router.put('/api/azdo/config', ({ body }) => {
    const org = String(body.org ?? '').trim();
    const project = String(body.project ?? '').trim();
    if (!org) throw new HttpError(400, 'Enter the Azure DevOps organisation, for example cloudassert.');
    if (!project) throw new HttpError(400, 'Enter the Azure DevOps project, for example Trisul.Org.');
    q.saveSetting.run('org', org);
    q.saveSetting.run('project', project);
    return configView();
  }, admin);

  // Checks the organisation, project and PAT by reading the project's root area.
  router.post('/api/azdo/test', async () => {
    const s = requireSettings();
    const root = await azFetch(s, 'wit/classificationnodes/Areas');
    if (!root) throw new HttpError(404, `Project ${s.project} wasn't found in organisation ${s.org}.`);
    return { ok: true, message: `Connected to ${s.org} / ${s.project}.` };
  }, admin);

  router.post('/api/azdo/areas', async ({ body, setStatus }) => {
    const s = requireSettings();
    const taken = (path) => q.areas.all().some((a) => a.path.toLowerCase() === path.toLowerCase());
    const node = await lookupNode(s, 'Areas', body.path, taken);
    try {
      q.insertArea.run(node.path, node.name, parseDisplayName(body.display_name));
    } catch (err) {
      if (isUnique(err)) throw new HttpError(409, `${node.path} is already added.`);
      throw err;
    }
    setStatus(201);
    return configView();
  }, admin);

  // The short name shown in the task table. Empty means use the area's own name.
  router.patch('/api/azdo/areas/:id', ({ params, body }) => {
    if (!q.area.get(params.id)) throw new HttpError(404, 'Area path not found.');
    q.renameArea.run(parseDisplayName(body.display_name), params.id);
    return configView();
  }, admin);

  router.delete('/api/azdo/areas/:id', ({ params }) => {
    if (!q.area.get(params.id)) throw new HttpError(404, 'Area path not found.');
    q.deleteArea.run(params.id);
    return configView();
  }, admin);

  router.post('/api/azdo/areas/:id/iterations', async ({ params, body, setStatus }) => {
    if (!q.area.get(params.id)) throw new HttpError(404, 'Area path not found.');
    const s = requireSettings();
    const taken = (path) => q.iterations.all().some((i) => i.area_id === params.id && i.path.toLowerCase() === path.toLowerCase());
    const node = await lookupNode(s, 'Iterations', body.path, taken);
    try {
      q.insertIteration.run(params.id, node.path, node.name, node.startDate, node.finishDate);
    } catch (err) {
      if (isUnique(err)) throw new HttpError(409, `${node.path} is already added to this area path.`);
      throw err;
    }
    setStatus(201);
    return configView();
  }, admin);

  // Re-read a sprint's name and dates from Azure DevOps (e.g. after its dates were set there).
  router.post('/api/azdo/iterations/:id/refresh', async ({ params }) => {
    const it = q.iteration.get(params.id);
    if (!it) throw new HttpError(404, 'Sprint not found.');
    const node = await lookupNode(requireSettings(), 'Iterations', it.path);
    q.updateIteration.run(node.name, node.startDate, node.finishDate, it.id);
    return configView();
  }, admin);

  router.delete('/api/azdo/iterations/:id', ({ params }) => {
    if (!q.iteration.get(params.id)) throw new HttpError(404, 'Sprint not found.');
    q.deleteIteration.run(params.id);
    return configView();
  }, admin);

  // An employee's Azure DevOps work. Admins can open anyone's; an Employee login only its own.
  // Without ?month= it returns the months that have sprints (newest first). With ?month=2026-10
  // it returns one table for every area path's sprints starting that month: each User Story or
  // Issue with the employee's own Tasks and Bugs below it. A parent is listed when it's theirs or
  // when they have a task or bug under it (even if the parent is someone else's); other people's
  // tasks and bugs are never listed.
  router.get('/api/employees/:id/tasks', async ({ params, user, req }) => {
    const employee = q.employee.get(params.id);
    if (!employee || (!isAdmin(user) && myEmployeeId(user) !== employee.id)) throw new HttpError(404, 'Employee not found.');
    const result = { employee: { ...employee, active: Boolean(employee.active) }, months: [] };
    if (!employee.email) return { ...result, message: `Add ${employee.name}'s email on the Employees page to see their Azure DevOps tasks.` };

    const s = settings();
    const iterations = q.iterations.all();
    const areas = q.areas.all().map((a) => ({ ...a, iterations: iterations.filter((i) => i.area_id === a.id) }));
    if (!s.org || !s.project || !areas.some((a) => a.iterations.length)) {
      return { ...result, message: 'Azure DevOps isn\'t set up yet. An admin can add area paths and sprints on the Azure DevOps page.' };
    }
    result.months = sprintMonths(areas);
    const month = new URL(req.url, 'http://x').searchParams.get('month');
    if (!month) return result;
    const chosen = result.months.find((m) => m.month === month);
    if (!chosen) throw new HttpError(404, 'There are no sprints for that month.');
    requireSettings();

    // Everything assigned to the employee in these area paths and sprints.
    const pairs = chosen.sprints.map((sp) =>
      `([System.AreaPath] UNDER '${esc(sp.areaPath)}' AND [System.IterationPath] UNDER '${esc(sp.path)}')`);
    const types = [...PARENT_TYPES, ...CHILD_TYPES].map((t) => `'${t}'`).join(', ');
    const query = `SELECT [System.Id] FROM WorkItems
      WHERE [System.TeamProject] = @project AND [System.WorkItemType] IN (${types})
        AND [System.AssignedTo] = '${esc(employee.email)}' AND (${pairs.join(' OR ')})
      ORDER BY [System.Id]`;
    const found = await azFetch(s, 'wit/wiql', { method: 'POST', body: { query } });
    const assignedIds = (found?.workItems || []).map((w) => w.id);

    const client = await clientField(s);
    const states = await stateCategories(s);
    const mine = employee.email.toLowerCase();
    const items = new Map((await workItemsWithLinks(s, assignedIds)).map((w) => [w.id, w]));

    // Parents: User Stories / Issues assigned to the employee, and the parents of their tasks and bugs.
    const parentIds = new Set();
    for (const w of items.values()) {
      if (PARENT_TYPES.includes(w.fields[F.type])) parentIds.add(w.id);
      else if (w.fields[F.parent]) parentIds.add(w.fields[F.parent]);
    }
    const missing = [...parentIds].filter((id) => !items.has(id));
    for (const w of await workItemsWithLinks(s, missing)) items.set(w.id, w);

    // Build the table: each parent, then the employee's own tasks and bugs under it (never other
    // people's); then their tasks and bugs with no parent.
    const isMine = (w) => String(w.fields[F.assignedTo]?.uniqueName || '').toLowerCase() === mine;
    const rows = [];
    const shown = new Set();
    const parents = [...parentIds].map((id) => items.get(id)).filter((w) => w && PARENT_TYPES.includes(w.fields[F.type]));
    parents.sort((a, b) => String(a.fields[F.area]).localeCompare(String(b.fields[F.area])) || a.id - b.id);
    for (const p of parents) {
      const kids = childIdsOf(p).map((id) => items.get(id))
        .filter((w) => w && CHILD_TYPES.includes(w.fields[F.type]) && isMine(w))
        .sort((a, b) => a.id - b.id);
      rows.push({ ...toRow(s, p, client, mine, areas, states), level: 0, childCount: kids.length });
      shown.add(p.id);
      for (const k of kids) {
        rows.push({ ...toRow(s, k, client, mine, areas, states), level: 1, parentId: p.id });
        shown.add(k.id);
      }
    }
    for (const id of assignedIds) {
      const w = items.get(id);
      if (w && !shown.has(id)) rows.push({ ...toRow(s, w, client, mine, areas, states), level: 0, childCount: 0, noParent: true });
    }

    // The employee's own hours: their tasks and bugs (not parents, whose hours roll up from tasks).
    const theirs = rows.filter((r) => r.mine && CHILD_TYPES.includes(r.type));
    const total = (k) => theirs.reduce((n, r) => n + (r[k] || 0), 0);
    return {
      ...result, month, sprints: chosen.sprints, clientField: client, rows,
      hours: { original: total('original'), completed: total('completed'), remaining: total('remaining') },
      counts: { parents: parents.length, mine: theirs.length },
    };
  });

  // A customer's progress on the sprint board: every User Story, Issue, Task and Bug whose Client
  // field matches the customer (Tasks and Bugs with no client count through their parent), in the
  // configured area paths and sprints, totalled per employee. ?month=2026-10 limits it to that
  // month's sprints; ?refresh=1 skips the 5-minute cache.
  router.get('/api/customers/:id/work', async ({ params, req }) => {
    const customer = q.customer.get(params.id);
    if (!customer) throw new HttpError(404, 'Customer not found.');
    const clientNames = (customer.azdo_client || customer.name).split(',').map((n) => n.trim()).filter(Boolean);
    const result = { clientNames, months: [] };

    const s = settings();
    const iterations = q.iterations.all();
    const areas = q.areas.all().map((a) => ({ ...a, iterations: iterations.filter((i) => i.area_id === a.id) }));
    if (!s.org || !s.project || !areas.some((a) => a.iterations.length)) {
      return { ...result, message: 'Azure DevOps isn\'t set up yet. Add area paths and sprints on the Azure DevOps page.' };
    }
    result.months = sprintMonths(areas).filter((m) => m.month !== 'undated');
    const search = new URL(req.url, 'http://x').searchParams;
    const month = search.get('month') || '';
    if (month && !result.months.some((m) => m.month === month)) throw new HttpError(404, 'There are no sprints for that month.');
    requireSettings();

    const key = `${s.org}/${s.project}/${customer.id}/${clientNames.join('|')}`;
    let cached = customerWorkCache.get(key);
    if (!cached || search.get('refresh') || Date.now() - cached.at > CUSTOMER_WORK_TTL) {
      const client = await clientField(s);
      if (!client) return { ...result, message: 'No field called "Client" was found in Azure DevOps, so work can\'t be matched to customers.' };
      cached = { at: Date.now(), items: await customerItems(s, client, clientNames, result.months) };
      customerWorkCache.set(key, cached);
    }

    // Totals per employee (matched by email); anyone else goes into one "Not in PaySplit" row.
    const items = cached.items.filter((w) => !month || w.month === month);
    const byEmail = new Map(q.employeesWithEmail.all().map((e) => [e.email.toLowerCase(), e]));
    const inSplit = new Set(q.splitEmployees.all(customer.id).map((r) => r.employee_id));
    const blank = () => ({ tasks: { total: 0, closed: 0 }, bugs: { total: 0, closed: 0 }, original: 0, completed: 0, remaining: 0, months: new Set() });
    const people = new Map();
    const others = { ...blank(), names: new Set() };
    for (const w of items.filter((x) => CHILD_TYPES.includes(x.type))) {
      const emp = byEmail.get(w.email);
      let row = others;
      if (emp) {
        if (!people.has(emp.id)) people.set(emp.id, { id: emp.id, name: emp.name, active: Boolean(emp.active), inSplit: inSplit.has(emp.id), ...blank() });
        row = people.get(emp.id);
      } else others.names.add(w.assignedTo || 'Unassigned');
      const bucket = w.type === 'Bug' ? row.bugs : row.tasks;
      bucket.total += 1;
      if (w.closed) bucket.closed += 1;
      row.original += w.original;
      row.completed += w.completed;
      row.remaining += w.remaining;
      row.months.add(w.month);
    }
    const finish = (r) => ({ ...r, months: [...r.months].sort(), names: r.names ? [...r.names].sort() : undefined });
    const closedCount = (r) => r.tasks.closed + r.bugs.closed;
    const rows = [...people.values()].sort((a, b) => closedCount(b) - closedCount(a) || b.completed - a.completed || a.name.localeCompare(b.name));
    const all = [...rows, others];
    const total = (pick) => all.reduce((n, r) => n + pick(r), 0);
    const parents = items.filter((x) => PARENT_TYPES.includes(x.type));
    return {
      ...result,
      month,
      fetchedAt: new Date(cached.at).toISOString(),
      people: rows.map(finish),
      others: others.tasks.total + others.bugs.total ? finish(others) : null,
      summary: {
        parents: { total: parents.length, closed: parents.filter((x) => x.closed).length },
        tasks: { total: total((r) => r.tasks.total), closed: total((r) => r.tasks.closed) },
        bugs: { total: total((r) => r.bugs.total), closed: total((r) => r.bugs.closed) },
        original: total((r) => r.original), completed: total((r) => r.completed), remaining: total((r) => r.remaining),
      },
    };
  }, admin);
}
