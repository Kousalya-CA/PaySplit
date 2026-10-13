// What's deployed at each customer: product, services (each with its version), features enabled,
// date and environment. Anyone signed in can see and add deployments (only customer names are
// shared, never revenue); people can change or delete the ones they added, admins any of them.
import { db } from '../db.js';
import { HttpError } from '../http.js';

const KINDS = ['product', 'service', 'feature', 'environment'];
const KIND_LABEL = { product: 'product', service: 'service', feature: 'feature', environment: 'environment' };
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const q = {
  all: db.prepare(`
    SELECT d.*, c.name AS customer FROM deployments d JOIN customers c ON c.id = d.customer_id
    ORDER BY d.deployed_on DESC, d.id DESC`),
  one: db.prepare('SELECT d.*, c.name AS customer FROM deployments d JOIN customers c ON c.id = d.customer_id WHERE d.id = ?'),
  insert: db.prepare(`
    INSERT INTO deployments (customer_id, product, environment, deployed_on, services, features, notes, created_by_id, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  update: db.prepare(`
    UPDATE deployments SET customer_id = ?, product = ?, environment = ?, deployed_on = ?, services = ?, features = ?, notes = ?,
      updated_by = ?, updated_at = datetime('now')
    WHERE id = ?`),
  remove: db.prepare('DELETE FROM deployments WHERE id = ?'),
  customers: db.prepare('SELECT id, name FROM customers ORDER BY name'),
  customer: db.prepare('SELECT id FROM customers WHERE id = ?'),
  options: db.prepare('SELECT id, kind, name FROM deployment_options ORDER BY kind, id'),
  option: db.prepare('SELECT * FROM deployment_options WHERE id = ?'),
  insertOption: db.prepare('INSERT INTO deployment_options (kind, name) VALUES (?, ?)'),
  removeOption: db.prepare('DELETE FROM deployment_options WHERE id = ?'),
};

const toApi = (d) => ({ ...d, services: JSON.parse(d.services), features: JSON.parse(d.features) });

function optionsByKind() {
  const out = Object.fromEntries(KINDS.map((k) => [k, []]));
  for (const o of q.options.all()) out[o.kind].push({ id: o.id, name: o.name });
  return out;
}

const validDate = (s) => {
  if (!DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};

// A name must be one of the current choices, or a value the deployment already had (so a choice
// removed from the list doesn't stop old deployments being edited). Returns the list's spelling.
function pick(kind, value, allowed, keep = []) {
  const name = String(value ?? '').trim();
  const match = allowed[kind].find((o) => o.name.toLowerCase() === name.toLowerCase())?.name
    || keep.find((k) => k.toLowerCase() === name.toLowerCase());
  if (!match) throw new HttpError(400, name ? `${name} isn't in the ${KIND_LABEL[kind]} list.` : `Choose the ${KIND_LABEL[kind]}.`);
  return match;
}

function parseDeployment(body, current) {
  const allowed = optionsByKind();
  const customerId = Number(body.customer_id);
  if (!Number.isInteger(customerId) || !q.customer.get(customerId)) throw new HttpError(400, 'Choose the customer.');
  const product = pick('product', body.product, allowed, current ? [current.product] : []);
  const environment = pick('environment', body.environment, allowed, current ? [current.environment] : []);

  const deployedOn = String(body.deployed_on ?? '');
  if (!validDate(deployedOn)) throw new HttpError(400, 'Choose the date it was deployed.');

  if (!Array.isArray(body.services) || !body.services.length) throw new HttpError(400, 'Choose at least one service and enter its version.');
  const keepServices = current ? current.services.map((s) => s.name) : [];
  const services = [];
  for (const s of body.services) {
    const name = pick('service', s?.name, allowed, keepServices);
    const version = String(s?.version ?? '').trim();
    if (!version) throw new HttpError(400, `Enter the ${name} version.`);
    if (version.length > 40) throw new HttpError(400, `Keep the ${name} version to 40 characters or fewer.`);
    if (services.some((x) => x.name === name)) throw new HttpError(400, `${name} is listed twice.`);
    services.push({ name, version });
  }

  if (body.features !== undefined && !Array.isArray(body.features)) throw new HttpError(400, 'Features must be a list.');
  const keepFeatures = current ? current.features : [];
  const features = [...new Set((body.features || []).map((f) => pick('feature', f, allowed, keepFeatures)))];

  const notes = String(body.notes ?? '').trim();
  if (notes.length > 2000) throw new HttpError(400, 'Keep the notes to 2000 characters or fewer.');
  return { customerId, product, environment, deployedOn, services, features, notes: notes || null };
}

function requireOwn(id, user) {
  const row = q.one.get(id);
  if (!row) throw new HttpError(404, 'Deployment not found.');
  if (user.role !== 'admin' && row.created_by_id !== user.id) {
    throw new HttpError(403, `Only ${row.created_by} or an admin can change this deployment.`);
  }
  return toApi(row);
}

export function registerDeploymentRoutes(router) {
  router.get('/api/deployments', () => ({
    deployments: q.all.all().map(toApi),
    customers: q.customers.all(),
    options: optionsByKind(),
  }));

  router.post('/api/deployments', ({ body, user, setStatus }) => {
    const d = parseDeployment(body);
    const id = q.insert.run(d.customerId, d.product, d.environment, d.deployedOn, JSON.stringify(d.services),
      JSON.stringify(d.features), d.notes, user.id, user.name).lastInsertRowid;
    setStatus(201);
    return toApi(q.one.get(id));
  });

  router.patch('/api/deployments/:id', ({ params, body, user }) => {
    const current = requireOwn(params.id, user);
    const d = parseDeployment(body, current);
    q.update.run(d.customerId, d.product, d.environment, d.deployedOn, JSON.stringify(d.services),
      JSON.stringify(d.features), d.notes, user.name, params.id);
    return toApi(q.one.get(params.id));
  });

  router.delete('/api/deployments/:id', ({ params, user }) => {
    requireOwn(params.id, user);
    q.remove.run(params.id);
  });

  // Admins manage the choices offered in the form.
  router.post('/api/deployment-options', ({ body, setStatus }) => {
    const kind = String(body.kind ?? '');
    if (!KINDS.includes(kind)) throw new HttpError(400, 'Unknown list.');
    const name = String(body.name ?? '').trim();
    if (!name) throw new HttpError(400, `Enter the ${KIND_LABEL[kind]} name.`);
    if (name.length > 60) throw new HttpError(400, 'Keep the name to 60 characters or fewer.');
    try {
      q.insertOption.run(kind, name);
    } catch (err) {
      if (/UNIQUE constraint failed/i.test(err?.message || '')) throw new HttpError(409, `${name} is already in the ${KIND_LABEL[kind]} list.`);
      throw err;
    }
    setStatus(201);
    return optionsByKind();
  }, { admin: true });

  router.delete('/api/deployment-options/:id', ({ params }) => {
    if (!q.option.get(params.id)) throw new HttpError(404, 'Choice not found.');
    q.removeOption.run(params.id);
    return optionsByKind();
  }, { admin: true });
}
