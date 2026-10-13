import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { dayLabel } from '../format.js';
import { Loading, ErrorNote } from '../components/common.jsx';

const LISTS = [['product', 'Products'], ['service', 'Services'], ['feature', 'Features'], ['environment', 'Environments']];
const todayIso = () => new Date().toLocaleDateString('en-CA');
// SQLite's datetime('now') is UTC without a zone: '2026-10-13 08:26:55' -> local date.
const savedOn = (utc) => dayLabel(new Date(`${utc.replace(' ', 'T')}Z`).toLocaleDateString('en-CA'));
export const serviceText = (d) => d.services.map((s) => `${s.name} ${s.version}`).join(' · ');

// The newest deployment of each product in each environment (rows come newest first).
export function latestDeployments(rows) {
  const seen = new Map();
  for (const d of rows) {
    const key = `${d.product}|${d.environment}`;
    if (!seen.has(key)) seen.set(key, d);
  }
  return [...seen.values()];
}

const canChange = (d, user) => user.role === 'admin' || d.created_by_id === user.id;

function useDeployments() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const load = () => api.deployments.list().then(setData).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);
  return { data, setData, error, setError, load };
}

// ---------- Deployments page (everyone) ----------
export default function DeploymentsPage({ user, customerId }) {
  const { data, setData, error, setError, load } = useDeployments();
  const [filters, setFilters] = useState({ customer: customerId ? String(customerId) : '', product: '', service: '', feature: '', environment: '', year: '' });
  const [editing, setEditing] = useState(null); // 'new' or a deployment
  const [managing, setManaging] = useState(false);
  const isAdmin = user.role === 'admin';

  useEffect(() => { setFilters((f) => ({ ...f, customer: customerId ? String(customerId) : '' })); }, [customerId]);

  if (!data) return error ? <ErrorNote>{error}</ErrorNote> : <Loading />;
  const set = (key) => (e) => setFilters({ ...filters, [key]: e.target.value });
  const years = [...new Set(data.deployments.map((d) => d.deployed_on.slice(0, 4)))].sort().reverse();
  const used = (fn) => [...new Set(data.deployments.flatMap(fn))].sort((a, b) => a.localeCompare(b));
  const featuresOf = (customerId) => (data.customerFeatures[customerId] || []).map((f) => f.name);
  const visible = data.deployments.filter((d) =>
    (!filters.customer || String(d.customer_id) === filters.customer) &&
    (!filters.product || d.product === filters.product) &&
    (!filters.service || d.services.some((s) => s.name === filters.service)) &&
    (!filters.feature || featuresOf(d.customer_id).includes(filters.feature)) &&
    (!filters.environment || d.environment === filters.environment) &&
    (!filters.year || d.deployed_on.startsWith(filters.year)));

  const downloadCsv = () => {
    const header = ['Customer', 'Product', 'Environment', 'Deployed on', 'Services and versions', 'Notes', 'Customer features enabled', 'Entered by', 'Entered on', 'Last edited by', 'Last edited on'];
    const rows = visible.map((d) => [d.customer, d.product, d.environment, d.deployed_on, serviceText(d), d.notes || '', featuresOf(d.customer_id).join('; '),
      d.created_by, d.created_at, d.updated_by || '', d.updated_at || '']);
    const csv = [header, ...rows].map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\r\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = `deployments-${todayIso()}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const saved = () => { setEditing(null); load(); };

  return (
    <section>
      <div className="page-head">
        <div>
          <h1>Deployments</h1>
          <p className="muted">What's deployed at each customer: product, service versions and environment, plus each customer's features enabled.</p>
        </div>
        <div className="actions">
          {isAdmin && <button className="secondary" onClick={() => setManaging(!managing)}>{managing ? 'Close lists' : 'Edit lists'}</button>}
          {!editing && <button className="primary" onClick={() => setEditing('new')}>Add deployment</button>}
        </div>
      </div>
      <ErrorNote>{error}</ErrorNote>

      {managing && <ManageLists options={data.options} onChange={(options) => setData({ ...data, options })} />}
      {editing && (
        <DeploymentForm data={data} initial={editing === 'new' ? null : editing}
          customerId={editing === 'new' && filters.customer ? Number(filters.customer) : null}
          onSaved={saved} onCancel={() => setEditing(null)} />
      )}

      {filters.customer && (
        <CustomerFeatures key={filters.customer} data={data} customerId={Number(filters.customer)} onChange={setData} />
      )}

      <div className="filters">
        <label><span>Customer</span>
          <select value={filters.customer} onChange={set('customer')}>
            <option value="">All customers</option>
            {data.customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
        {[['product', 'Product', 'All products', used((d) => [d.product])],
          ['service', 'Service', 'All services', used((d) => d.services.map((s) => s.name))],
          ['feature', 'Customer feature', 'All features', [...new Set(Object.values(data.customerFeatures).flat().map((f) => f.name))].sort((a, b) => a.localeCompare(b))],
          ['environment', 'Environment', 'All environments', used((d) => [d.environment])],
          ['year', 'Year', 'All years', years]].map(([key, label, all, list]) => (
          <label key={key}><span>{label}</span>
            <select value={filters[key]} onChange={set(key)}>
              <option value="">{all}</option>
              {list.map((v) => <option key={v}>{v}</option>)}
            </select>
          </label>
        ))}
      </div>

      {data.deployments.length === 0 ? (
        <div className="empty"><p>No deployments recorded yet. Use Add deployment to record what's installed at a customer.</p></div>
      ) : visible.length === 0 ? (
        <div className="empty"><p>No deployments match these filters.</p></div>
      ) : (
        <>
          <DeploymentTable rows={visible} user={user} showCustomer onEdit={setEditing} onChanged={load} onError={setError} />
          <p className="actions small">
            <span className="muted">{visible.length} of {data.deployments.length} deployments</span>
            <button className="link" onClick={downloadCsv}>Download CSV</button>
          </p>
        </>
      )}
    </section>
  );
}

// ---------- One customer's deployments: its own page at #/customers/:id/deployments (admins) ----------
export function CustomerDeployments({ customerId, user }) {
  const { data, setData, error, setError, load } = useDeployments();
  const [editing, setEditing] = useState(null);

  if (!data) return error ? <ErrorNote>{error}</ErrorNote> : <Loading />;
  const customer = data.customers.find((c) => c.id === customerId);
  if (!customer) return <ErrorNote>Customer not found.</ErrorNote>;
  const rows = data.deployments.filter((d) => d.customer_id === customer.id);
  const latest = latestDeployments(rows);

  return (
    <section className="deployments">
      <a className="back" href={`#/customers/${customer.id}`}>{customer.name}</a>
      <div className="page-head">
        <div>
          <h1>{customer.name}: deployments</h1>
          <p className="muted">Latest version of each product in each environment, with the full history below.</p>
        </div>
        {!editing && <button className="primary" onClick={() => setEditing('new')}>Add deployment</button>}
      </div>
      <ErrorNote>{error}</ErrorNote>
      <CustomerFeatures data={data} customerId={customer.id} onChange={setData} />
      <>
          {editing && (
            <DeploymentForm data={data} initial={editing === 'new' ? null : editing} customerId={customer.id} lockCustomer
              onSaved={() => { setEditing(null); load(); }} onCancel={() => setEditing(null)} />
          )}
          {rows.length === 0 ? (
            !editing && <div className="empty"><p>No deployments recorded for {customer.name} yet.</p></div>
          ) : (
            <>
              <div className="dep-cards">
                {latest.map((d) => (
                  <div key={d.id} className="dep-card">
                    <div className="dep-card-head">
                      <strong>{d.product}</strong>
                      <span className="tag">{d.environment}</span>
                    </div>
                    <span className="muted small">Deployed {dayLabel(d.deployed_on)}</span>
                    <ul className="dep-versions">
                      {d.services.map((s) => <li key={s.name}><span>{s.name}</span><strong>{s.version}</strong></li>)}
                    </ul>
                  </div>
                ))}
              </div>
              <h3>History</h3>
              <DeploymentTable rows={rows} user={user} onEdit={setEditing} onChanged={load} onError={setError} />
            </>
          )}
      </>
    </section>
  );
}

// ---------- shared pieces ----------
function DeploymentTable({ rows, user, showCustomer, onEdit, onChanged, onError }) {
  const remove = async (d) => {
    if (!window.confirm(`Delete the ${d.product} ${d.environment} deployment of ${dayLabel(d.deployed_on)}${showCustomer ? ` for ${d.customer}` : ''}?`)) return;
    try {
      await api.deployments.remove(d.id);
      onChanged();
    } catch (e) { onError(e.message); }
  };
  return (
    <div className="table-wrap">
      <table className="grid list dep-table">
        <thead>
          <tr>
            <th scope="col">Deployed on</th>
            {showCustomer && <th scope="col">Customer</th>}
            <th scope="col">Product</th>
            <th scope="col">Environment</th>
            <th scope="col">Services and versions</th>
            <th scope="col">Notes</th>
            <th scope="col">Entered by</th>
            <th><span className="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((d) => (
            <tr key={d.id}>
              <th scope="row">{dayLabel(d.deployed_on)}</th>
              {showCustomer && <td>{user.role === 'admin' ? <a href={`#/customers/${d.customer_id}/deployments`}>{d.customer}</a> : d.customer}</td>}
              <td>{d.product}</td>
              <td>{d.environment}</td>
              <td className="dep-wrap">{d.services.map((s) => <div key={s.name}>{s.name} <strong>{s.version}</strong></div>)}</td>
              <td className="dep-wrap dep-notes" title={d.notes || undefined}>{d.notes || <span className="muted">–</span>}</td>
              <td className="small">
                {d.created_by}<div className="muted">{savedOn(d.created_at)}</div>
                {d.updated_at && <div className="muted">Edited by {d.updated_by}, {savedOn(d.updated_at)}</div>}
              </td>
              <td>
                {canChange(d, user) && (
                  <span className="row-actions">
                    <button className="link" onClick={() => { onEdit(d); window.scrollTo({ top: 0, behavior: 'smooth' }); }}>Edit</button>
                    <button className="link danger" onClick={() => remove(d)}>Delete</button>
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DeploymentForm({ data, initial, customerId, lockCustomer, onSaved, onCancel }) {
  const [form, setForm] = useState(() => ({
    customer_id: String(initial?.customer_id ?? customerId ?? ''),
    product: initial?.product ?? (data.options.product.length === 1 ? data.options.product[0].name : ''),
    environment: initial?.environment ?? '',
    deployed_on: initial?.deployed_on ?? todayIso(),
    notes: initial?.notes ?? '',
  }));
  // service name -> version, for the services ticked
  const [versions, setVersions] = useState(() => Object.fromEntries((initial?.services || []).map((s) => [s.name, s.version])));
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  // The current choices, plus anything this deployment already had that's since been taken off the list.
  const choices = (kind, current = []) => {
    const names = data.options[kind].map((o) => o.name);
    return [...names, ...current.filter((c) => c && !names.includes(c))];
  };
  const services = choices('service', initial?.services.map((s) => s.name));
  const set = (key) => (e) => setForm({ ...form, [key]: e.target.value });
  const toggleService = (name) => setVersions((v) => {
    const next = { ...v };
    if (name in next) delete next[name]; else next[name] = '';
    return next;
  });

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setSaving(true);
    const body = {
      ...form,
      customer_id: Number(form.customer_id),
      services: services.filter((s) => s in versions).map((name) => ({ name, version: versions[name] })),
    };
    try {
      await (initial ? api.deployments.update(initial.id, body) : api.deployments.create(body));
      onSaved();
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  };

  return (
    <form className="panel dep-form" onSubmit={submit}>
      <h2>{initial ? 'Edit deployment' : 'New deployment'}</h2>
      <ErrorNote>{error}</ErrorNote>
      <div className="row">
        <label className="grow"><span>Customer</span>
          <select value={form.customer_id} onChange={set('customer_id')} required disabled={lockCustomer}>
            <option value="">Choose…</option>
            {data.customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
        <label className="grow"><span>Product</span>
          <select value={form.product} onChange={set('product')} required>
            <option value="">Choose…</option>
            {choices('product', [initial?.product]).map((p) => <option key={p}>{p}</option>)}
          </select>
        </label>
      </div>
      <div className="row">
        <label className="grow"><span>Environment</span>
          <select value={form.environment} onChange={set('environment')} required>
            <option value="">Choose…</option>
            {choices('environment', [initial?.environment]).map((p) => <option key={p}>{p}</option>)}
          </select>
        </label>
        <label className="grow"><span>Deployed on</span>
          <input type="date" value={form.deployed_on} max={todayIso()} onChange={set('deployed_on')} required />
        </label>
      </div>

      <fieldset>
        <legend>Services and versions</legend>
        <div className="dep-services">
          {services.map((name) => {
            const on = name in versions;
            return (
              <div key={name} className={`dep-service${on ? ' on' : ''}`}>
                <label className="check">
                  <input type="checkbox" checked={on} onChange={() => toggleService(name)} />
                  <span>{name}</span>
                </label>
                {on && (
                  <input aria-label={`${name} version`} placeholder="Version, e.g. 4.2.1" value={versions[name]} maxLength={40} required
                    onChange={(e) => setVersions({ ...versions, [name]: e.target.value })} />
                )}
              </div>
            );
          })}
        </div>
      </fieldset>

      <label><span>Notes</span>
        <textarea rows={3} value={form.notes} onChange={set('notes')} maxLength={2000} placeholder="Anything worth knowing about this deployment" />
      </label>

      <div className="actions">
        <button className="primary" type="submit" disabled={saving}>{saving ? 'Saving…' : initial ? 'Save changes' : 'Add deployment'}</button>
        <button className="secondary" type="button" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

// The features enabled for a customer. Ticking or unticking saves straight away. Anyone can add a
// new feature to the list here; it's switched on for this customer at the same time.
function CustomerFeatures({ data, customerId, onChange }) {
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState('');
  const [error, setError] = useState('');
  const enabled = data.customerFeatures[customerId] || [];
  const names = enabled.map((f) => f.name);
  const listed = data.options.feature.map((o) => o.name);
  const choices = [...listed, ...names.filter((n) => !listed.includes(n))];

  const save = async (next, options = data.options) => {
    setBusy(true);
    setError('');
    try {
      const saved = await api.deployments.setFeatures(customerId, next);
      onChange({ ...data, options, customerFeatures: { ...data.customerFeatures, [customerId]: saved } });
      return true;
    } catch (e) {
      setError(e.message);
      return false;
    } finally {
      setBusy(false);
    }
  };
  const toggle = (name) => save(names.includes(name) ? names.filter((n) => n !== name) : [...names, name]);
  const addNew = async (e) => {
    e.preventDefault();
    const name = adding.trim();
    if (!name) return;
    setError('');
    let options = data.options;
    const existing = listed.find((n) => n.toLowerCase() === name.toLowerCase());
    if (!existing) {
      try { options = await api.deployments.addOption('feature', name); } catch (err) { setError(err.message); return; }
    }
    const finalName = existing || name;
    if (await save(names.includes(finalName) ? names : [...names, finalName], options)) setAdding('');
  };

  return (
    <div className="panel dep-features">
      <div>
        <h2>Features enabled</h2>
        <p className="muted small">For this customer. Tick to switch a feature on; changes save straight away.</p>
      </div>
      <ErrorNote>{error}</ErrorNote>
      <div className="chips" aria-busy={busy}>
        {choices.map((name) => {
          const on = enabled.find((f) => f.name === name);
          return (
            <label key={name} className={`chip chip-check${on ? ' on' : ''}`}
              title={on ? `Switched on by ${on.added_by || 'someone'}, ${savedOn(on.added_at)}` : undefined}>
              <input type="checkbox" checked={Boolean(on)} disabled={busy} onChange={() => toggle(name)} />
              {name}
            </label>
          );
        })}
      </div>
      <form className="dep-add" onSubmit={addNew}>
        <input aria-label="New feature" placeholder="Add another feature" value={adding} maxLength={60} onChange={(e) => setAdding(e.target.value)} />
        <button className="secondary" type="submit" disabled={busy || !adding.trim()}>Add</button>
      </form>
    </div>
  );
}

// Admins add or remove the choices offered in the form. Removing one leaves past deployments as they were.
function ManageLists({ options, onChange }) {
  const [draft, setDraft] = useState({});
  const [error, setError] = useState('');
  const run = async (fn) => {
    setError('');
    try { onChange(await fn()); return true; } catch (e) { setError(e.message); return false; }
  };
  const add = async (kind, e) => {
    e.preventDefault();
    if (await run(() => api.deployments.addOption(kind, draft[kind] || ''))) setDraft({ ...draft, [kind]: '' });
  };
  return (
    <div className="panel dep-lists">
      <h2>Lists</h2>
      <p className="muted small">The choices offered when adding a deployment or a customer's features. Removing one doesn't change what's already recorded.</p>
      <ErrorNote>{error}</ErrorNote>
      <div className="dep-lists-grid">
        {LISTS.map(([kind, label]) => (
          <div key={kind}>
            <h3>{label}</h3>
            <div className="chips">
              {options[kind].map((o) => (
                <span key={o.id} className="chip">
                  {o.name}
                  <button className="chip-x" aria-label={`Remove ${o.name}`}
                    onClick={() => window.confirm(`Remove ${o.name} from the ${label.toLowerCase()} list?`) && run(() => api.deployments.removeOption(o.id))}>×</button>
                </span>
              ))}
            </div>
            <form className="dep-add" onSubmit={(e) => add(kind, e)}>
              <input aria-label={`New ${kind}`} placeholder={`Add ${kind}`} value={draft[kind] || ''} maxLength={60}
                onChange={(e) => setDraft({ ...draft, [kind]: e.target.value })} />
              <button className="secondary" type="submit" disabled={!draft[kind]?.trim()}>Add</button>
            </form>
          </div>
        ))}
      </div>
    </div>
  );
}
