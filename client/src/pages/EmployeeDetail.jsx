import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Loading, ErrorNote } from '../components/common.jsx';
import { dayLabel } from '../format.js';

const hours = (n) => (n ? `${+n.toFixed(2)} h` : '–');

// One employee: their Azure DevOps tasks in every configured area path and sprint, found by their
// email and grouped under the parent User Story.
export default function EmployeeDetail({ id }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const load = () => {
    setLoading(true);
    setError('');
    api.employees.tasks(id)
      .then(setData)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  };
  useEffect(load, [id]);

  const emp = data?.employee;
  return (
    <section>
      <a className="back" href="#/employees">Employees</a>
      <div className="page-head">
        <div>
          <h1>{emp ? emp.name : 'Employee'}</h1>
          {emp && (
            <p className="muted">
              {emp.email || 'No email yet'} · {emp.type}{emp.active ? '' : ' · Inactive'}
            </p>
          )}
        </div>
        {data && !loading && <button className="secondary" onClick={load}>Reload tasks</button>}
      </div>

      <h2>Azure DevOps tasks</h2>
      {loading ? <Loading /> : error ? <ErrorNote>{error}</ErrorNote> : data.message ? (
        <div className="empty"><p>{data.message}</p></div>
      ) : data.areas.map((a) => (
        <div key={a.id} className="panel azdo-area">
          <div>
            <h3>{a.name}</h3>
            <p className="muted small"><code>{a.path}</code></p>
          </div>
          {a.sprints.length === 0 && <p className="muted small">No sprints added for this area path.</p>}
          {a.sprints.map((sp) => (
            <div key={sp.id} className="azdo-sprint">
              <h4>
                {sp.name}
                <span className="muted small">
                  {sp.start_date ? ` · ${dayLabel(sp.start_date)} to ${dayLabel(sp.finish_date)}` : ''}
                  {` · ${sp.taskCount} task${sp.taskCount === 1 ? '' : 's'}`}
                  {sp.hours.completed ? ` · ${hours(sp.hours.completed)} completed` : ''}
                </span>
              </h4>
              {sp.stories.length === 0 ? <p className="muted small">No tasks assigned in this sprint.</p> : sp.stories.map((st) => (
                <div key={st.id ?? 'none'} className="azdo-story">
                  <p className="azdo-story-title">
                    {st.url
                      ? <a href={st.url} target="_blank" rel="noreferrer">{st.type || 'User Story'} {st.id}: {st.title}</a>
                      : <strong>{st.title}</strong>}
                    {st.state && <span className="muted small"> · {st.state}</span>}
                  </p>
                  <div className="table-wrap">
                    <table className="grid list">
                      <thead>
                        <tr>
                          <th scope="col">Task</th>
                          <th scope="col">State</th>
                          <th scope="col" className="num">Original</th>
                          <th scope="col" className="num">Completed</th>
                          <th scope="col" className="num">Remaining</th>
                        </tr>
                      </thead>
                      <tbody>
                        {st.tasks.map((t) => (
                          <tr key={t.id}>
                            <th scope="row"><a href={t.url} target="_blank" rel="noreferrer">{t.id}</a> {t.title}</th>
                            <td>{t.state}</td>
                            <td className="num">{hours(t.original)}</td>
                            <td className="num">{hours(t.completed)}</td>
                            <td className="num">{hours(t.remaining)}</td>
                          </tr>
                        ))}
                      </tbody>
                      {st.tasks.length > 1 && (
                        <tfoot>
                          <tr>
                            <th scope="row" colSpan={2}>Total</th>
                            <td className="num">{hours(st.hours.original)}</td>
                            <td className="num">{hours(st.hours.completed)}</td>
                            <td className="num">{hours(st.hours.remaining)}</td>
                          </tr>
                        </tfoot>
                      )}
                    </table>
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>
      ))}
    </section>
  );
}
