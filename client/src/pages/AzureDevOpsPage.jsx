import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Loading, ErrorNote } from '../components/common.jsx';
import { dayLabel } from '../format.js';

// Azure DevOps settings (admins only): organisation and project, then area paths, each with its
// sprints (iteration paths). Each path is checked with Azure DevOps when it's added, and a sprint's
// name and dates are copied from there. The PAT comes from the server's AZ_PAT setting only.
export default function AzureDevOpsPage() {
  const [config, setConfig] = useState(null);
  const [form, setForm] = useState({ org: '', project: '' });
  const [newArea, setNewArea] = useState('');
  const [newSprint, setNewSprint] = useState({}); // areaId -> text
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const show = (c) => { setConfig(c); setForm({ org: c.org, project: c.project }); };
  useEffect(() => { api.azdo.config().then(show).catch((e) => setError(e.message)); }, []);

  // Run an API call, showing a busy label on the button that started it.
  const run = async (key, fn, done) => {
    setBusy(key);
    setError('');
    setNotice('');
    try {
      const result = await fn();
      if (result?.areas) setConfig(result);
      if (done) done(result);
    } catch (err) { setError(err.message); }
    finally { setBusy(''); }
  };

  if (!config) return error ? <ErrorNote>{error}</ErrorNote> : <Loading />;
  const saved = config.org && config.project;

  return (
    <section>
      <div className="page-head"><h1>Azure DevOps</h1></div>
      <p className="muted">
        PaySplit reads each employee's tasks from these area paths and sprints, matching people by their email.
      </p>

      <form className="panel" onSubmit={(e) => { e.preventDefault(); run('save', () => api.azdo.saveConfig(form), (c) => { show(c); setNotice('Saved.'); }); }}>
        <h2>Connection</h2>
        <div className="row">
          <label className="grow">
            <span>Organisation</span>
            <input value={form.org} placeholder="cloudassert" required onChange={(e) => setForm({ ...form, org: e.target.value })} />
          </label>
          <label className="grow">
            <span>Project</span>
            <input value={form.project} placeholder="Trisul.Org" required onChange={(e) => setForm({ ...form, project: e.target.value })} />
          </label>
        </div>
        <p className="small">
          Personal access token (PAT):{' '}
          {config.patSet
            ? <strong className="ok-text">set on the server</strong>
            : <strong className="warn-text">not set</strong>}
          <span className="muted">
            {' '}It's read from the <code>AZ_PAT</code> app setting on the server and is never stored in PaySplit.
            It needs Work Items (Read) access.
          </span>
        </p>
        <div className="actions">
          <button className="primary" type="submit" disabled={busy === 'save'}>{busy === 'save' ? 'Saving…' : 'Save'}</button>
          <button className="secondary" type="button" disabled={!saved || !config.patSet || busy === 'test'}
            onClick={() => run('test', () => api.azdo.test(), (r) => setNotice(r.message))}>
            {busy === 'test' ? 'Testing…' : 'Test connection'}
          </button>
        </div>
      </form>

      <ErrorNote>{error}</ErrorNote>
      {notice && <p className="ok-text" role="status">{notice}</p>}

      <h2>Area paths and sprints</h2>
      {!saved && <p className="muted">Save the organisation and project first.</p>}

      {config.areas.map((a) => (
        <div key={a.id} className="panel azdo-area">
          <div className="azdo-area-head">
            <div>
              <h3>{a.name}</h3>
              <p className="muted small"><code>{a.path}</code></p>
            </div>
            <button className="link danger" disabled={busy === `area-${a.id}`}
              onClick={() => window.confirm(`Remove ${a.path} and its sprints from PaySplit? Nothing changes in Azure DevOps.`)
                && run(`area-${a.id}`, () => api.azdo.removeArea(a.id))}>
              Remove area path
            </button>
          </div>

          {a.iterations.length > 0 ? (
            <div className="table-wrap">
              <table className="grid list">
                <thead>
                  <tr>
                    <th scope="col">Sprint</th>
                    <th scope="col">Dates</th>
                    <th scope="col">Iteration path</th>
                    <th scope="col"><span className="sr-only">Actions</span></th>
                  </tr>
                </thead>
                <tbody>
                  {a.iterations.map((it) => (
                    <tr key={it.id}>
                      <th scope="row">{it.name}</th>
                      <td>{it.start_date ? `${dayLabel(it.start_date)} to ${dayLabel(it.finish_date)}` : <span className="warn-text small">No dates set in Azure DevOps</span>}</td>
                      <td><code className="small">{it.path}</code></td>
                      <td className="row-actions">
                        <button className="link" disabled={busy === `it-${it.id}`} onClick={() => run(`it-${it.id}`, () => api.azdo.refreshIteration(it.id))}>
                          {busy === `it-${it.id}` ? 'Refreshing…' : 'Refresh dates'}
                        </button>
                        <button className="link danger" onClick={() => run(`it-${it.id}`, () => api.azdo.removeIteration(it.id))}>Remove</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <p className="muted small">No sprints yet.</p>}

          <form className="inline-form" onSubmit={(e) => {
            e.preventDefault();
            run(`add-${a.id}`, () => api.azdo.addIteration(a.id, newSprint[a.id] || ''), () => setNewSprint({ ...newSprint, [a.id]: '' }));
          }}>
            <label className="grow">
              <span>Add sprint (iteration path)</span>
              <input value={newSprint[a.id] || ''} placeholder={`${config.project}\\Sprint 3`} required
                onChange={(e) => setNewSprint({ ...newSprint, [a.id]: e.target.value })} />
            </label>
            <button className="secondary" type="submit" disabled={busy === `add-${a.id}`}>{busy === `add-${a.id}` ? 'Checking…' : 'Add sprint'}</button>
          </form>
        </div>
      ))}

      {saved && (
        <form className="inline-form" onSubmit={(e) => { e.preventDefault(); run('area', () => api.azdo.addArea(newArea), () => setNewArea('')); }}>
          <label className="grow">
            <span>Add area path</span>
            <input value={newArea} placeholder={`${config.project}\\Agentic - Billing and Data Platform`} required
              onChange={(e) => setNewArea(e.target.value)} />
          </label>
          <button className="primary" type="submit" disabled={busy === 'area'}>{busy === 'area' ? 'Checking…' : 'Add area path'}</button>
        </form>
      )}
      <p className="muted small">
        Type paths the way Azure DevOps shows them, for example <code>{config.project || 'Trisul.Org'}\Sprint 3</code>.
        The full form <code>\{config.project || 'Trisul.Org'}\Iteration\Sprint 3</code> works too.
      </p>
    </section>
  );
}
