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
  insertArea: db.prepare('INSERT INTO azdo_areas (path, name) VALUES (?, ?)'),
  deleteArea: db.prepare('DELETE FROM azdo_areas WHERE id = ?'),
  iterations: db.prepare('SELECT * FROM azdo_iterations ORDER BY start_date DESC, path'),
  iteration: db.prepare('SELECT * FROM azdo_iterations WHERE id = ?'),
  insertIteration: db.prepare(`
    INSERT INTO azdo_iterations (area_id, path, name, start_date, finish_date) VALUES (?, ?, ?, ?, ?)`),
  updateIteration: db.prepare('UPDATE azdo_iterations SET name = ?, start_date = ?, finish_date = ? WHERE id = ?'),
  deleteIteration: db.prepare('DELETE FROM azdo_iterations WHERE id = ?'),
  employee: db.prepare('SELECT id, name, email, type, active FROM employees WHERE id = ?'),
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
  if (res.status === 403) throw new HttpError(502, 'The PAT doesn\'t have access to this project. It needs Work Items (Read).');
  const data = await res.json().catch(() => null);
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

// One table row from a work item.
function toRow(s, w, client, mine) {
  const f = w.fields || {};
  const assigned = f[F.assignedTo];
  const assignedEmail = String(assigned?.uniqueName || '').toLowerCase();
  const clientValue = client ? f[client] : null;
  return {
    id: w.id,
    type: f[F.type],
    title: f[F.title],
    state: f[F.state],
    areaPath: f[F.area],
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
      months.get(key).sprints.push({ id: it.id, name: it.name, path: it.path, start_date: it.start_date, finish_date: it.finish_date, area: a.name, areaPath: a.path });
    }
  }
  return [...months.values()].sort((x, y) => (x.month === 'undated' ? 1 : y.month === 'undated' ? -1 : y.month.localeCompare(x.month)));
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
      q.insertArea.run(node.path, node.name);
    } catch (err) {
      if (isUnique(err)) throw new HttpError(409, `${node.path} is already added.`);
      throw err;
    }
    setStatus(201);
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
  // Issue with its child Tasks and Bugs below it. A parent is listed when the employee has a task
  // or bug under it (even if the parent is someone else's) or when the parent is theirs, in which
  // case all its children are listed.
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

    // Children of the employee's own User Stories / Issues, whoever they're assigned to.
    const ownParents = [...parentIds].map((id) => items.get(id))
      .filter((w) => w && String(w.fields[F.assignedTo]?.uniqueName || '').toLowerCase() === mine);
    const childIds = [...new Set(ownParents.flatMap(childIdsOf))].filter((id) => !items.has(id));
    for (const w of await workItemsWithLinks(s, childIds)) items.set(w.id, w);

    // Build the table: each parent, then its children; then tasks and bugs with no parent.
    const rows = [];
    const shown = new Set();
    const parents = [...parentIds].map((id) => items.get(id)).filter((w) => w && PARENT_TYPES.includes(w.fields[F.type]));
    parents.sort((a, b) => String(a.fields[F.area]).localeCompare(String(b.fields[F.area])) || a.id - b.id);
    for (const p of parents) {
      const own = String(p.fields[F.assignedTo]?.uniqueName || '').toLowerCase() === mine;
      const kids = childIdsOf(p).map((id) => items.get(id))
        .filter((w) => w && (own || String(w.fields[F.assignedTo]?.uniqueName || '').toLowerCase() === mine))
        .sort((a, b) => a.id - b.id);
      rows.push({ ...toRow(s, p, client, mine), level: 0, childCount: kids.length });
      shown.add(p.id);
      for (const k of kids) {
        rows.push({ ...toRow(s, k, client, mine), level: 1, parentId: p.id });
        shown.add(k.id);
      }
    }
    for (const id of assignedIds) {
      const w = items.get(id);
      if (w && !shown.has(id)) rows.push({ ...toRow(s, w, client, mine), level: 0, childCount: 0, noParent: true });
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
}
