// Azure DevOps sprint board: settings (organisation, project, area paths and their sprints) and
// each employee's tasks, found by their email and grouped under the parent User Story.
// The PAT is read from the AZ_PAT environment variable only; it's never stored or sent to the browser.
import { db } from '../db.js';
import { HttpError } from '../http.js';
import { isAdmin, myEmployeeId } from './data.js';

const API_VERSION = '7.1';
const BATCH = 200; // work items per workitemsbatch call (the API's limit)

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

// Fetch work items by id in batches, with the given fields.
async function workItems(s, ids, fields) {
  const items = [];
  for (let i = 0; i < ids.length; i += BATCH) {
    const data = await azFetch(s, 'wit/workitemsbatch', {
      method: 'POST', body: { ids: ids.slice(i, i + BATCH), fields, errorPolicy: 'Omit' },
    });
    items.push(...(data?.value || []).filter(Boolean));
  }
  return items;
}

const F = {
  title: 'System.Title', state: 'System.State', type: 'System.WorkItemType', area: 'System.AreaPath',
  iteration: 'System.IterationPath', parent: 'System.Parent',
  original: 'Microsoft.VSTS.Scheduling.OriginalEstimate',
  completed: 'Microsoft.VSTS.Scheduling.CompletedWork',
  remaining: 'Microsoft.VSTS.Scheduling.RemainingWork',
};

// The configured path a work item belongs to: the longest configured path it's under.
const underPath = (itemPath, path) => {
  const a = String(itemPath || '').toLowerCase();
  const b = path.toLowerCase();
  return a === b || a.startsWith(`${b}\\`);
};
const bestMatch = (itemPath, list) =>
  list.filter((x) => underPath(itemPath, x.path)).sort((x, y) => y.path.length - x.path.length)[0];

const sumHours = (tasks) => ({
  original: tasks.reduce((n, t) => n + (t.original || 0), 0),
  completed: tasks.reduce((n, t) => n + (t.completed || 0), 0),
  remaining: tasks.reduce((n, t) => n + (t.remaining || 0), 0),
});

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

  // One employee's tasks in every configured area and sprint, grouped under their User Story.
  // Admins can open anyone's; an Employee login only its own.
  router.get('/api/employees/:id/tasks', async ({ params, user }) => {
    const employee = q.employee.get(params.id);
    if (!employee || (!isAdmin(user) && myEmployeeId(user) !== employee.id)) throw new HttpError(404, 'Employee not found.');
    const result = { employee: { ...employee, active: Boolean(employee.active) }, areas: [] };
    if (!employee.email) return { ...result, message: `Add ${employee.name}'s email on the Employees page to see their Azure DevOps tasks.` };

    const s = settings();
    const iterations = q.iterations.all();
    const areas = q.areas.all().map((a) => ({ ...a, iterations: iterations.filter((i) => i.area_id === a.id) }));
    if (!s.org || !s.project || !areas.some((a) => a.iterations.length)) {
      return { ...result, message: 'Azure DevOps isn\'t set up yet. An admin can add area paths and sprints on the Azure DevOps page.' };
    }
    requireSettings();

    // One query for every area and its sprints.
    const clauses = areas.filter((a) => a.iterations.length).map((a) =>
      `([System.AreaPath] UNDER '${esc(a.path)}' AND (${a.iterations.map((i) => `[System.IterationPath] UNDER '${esc(i.path)}'`).join(' OR ')}))`);
    const query = `SELECT [System.Id] FROM WorkItems
      WHERE [System.TeamProject] = @project AND [System.WorkItemType] = 'Task'
        AND [System.AssignedTo] = '${esc(employee.email)}' AND (${clauses.join(' OR ')})
      ORDER BY [System.Id]`;
    const found = await azFetch(s, 'wit/wiql', { method: 'POST', body: { query } });
    const ids = (found?.workItems || []).map((w) => w.id);

    const tasks = (await workItems(s, ids, ['System.Id', ...Object.values(F)])).map((w) => ({
      id: w.id,
      title: w.fields[F.title],
      state: w.fields[F.state],
      areaPath: w.fields[F.area],
      iterationPath: w.fields[F.iteration],
      parentId: w.fields[F.parent] ?? null,
      original: w.fields[F.original] ?? null,
      completed: w.fields[F.completed] ?? null,
      remaining: w.fields[F.remaining] ?? null,
      url: `https://dev.azure.com/${encodeURIComponent(s.org)}/${encodeURIComponent(s.project)}/_workitems/edit/${w.id}`,
    }));
    const parentIds = [...new Set(tasks.map((t) => t.parentId).filter(Boolean))];
    const parents = new Map((await workItems(s, parentIds, ['System.Id', F.title, F.state, F.type]))
      .map((w) => [w.id, { id: w.id, title: w.fields[F.title], state: w.fields[F.state], type: w.fields[F.type] }]));

    result.areas = areas.map((a) => ({
      id: a.id, path: a.path, name: a.name,
      sprints: a.iterations.map((it) => {
        const mine = tasks.filter((t) => bestMatch(t.areaPath, areas)?.id === a.id
          && bestMatch(t.iterationPath, a.iterations)?.id === it.id);
        const stories = new Map();
        for (const t of mine) {
          const key = t.parentId || 0;
          if (!stories.has(key)) {
            const p = parents.get(t.parentId);
            stories.set(key, {
              id: p?.id ?? null,
              title: p ? p.title : 'No user story',
              type: p?.type ?? null,
              state: p?.state ?? null,
              url: p ? `https://dev.azure.com/${encodeURIComponent(s.org)}/${encodeURIComponent(s.project)}/_workitems/edit/${p.id}` : null,
              tasks: [],
            });
          }
          stories.get(key).tasks.push(t);
        }
        const list = [...stories.values()].map((st) => ({ ...st, hours: sumHours(st.tasks) }));
        return {
          id: it.id, path: it.path, name: it.name, start_date: it.start_date, finish_date: it.finish_date,
          stories: list, taskCount: mine.length, hours: sumHours(mine),
        };
      }),
    }));
    return result;
  });
}
