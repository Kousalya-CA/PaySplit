import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Loading, ErrorNote, Money } from '../components/common.jsx';

export default function EmployeesPage() {
  const [employees, setEmployees] = useState(null);
  const [name, setName] = useState('');
  const [type, setType] = useState('Product');
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(null); // { id, name, type }

  const load = () => api.employees.list().then(setEmployees).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  const add = async (e) => {
    e.preventDefault();
    setError('');
    try {
      await api.employees.create(name, type);
      setName('');
      setType('Product');
      load();
    } catch (err) { setError(err.message); }
  };

  const saveName = async (e) => {
    e.preventDefault();
    setError('');
    try {
      await api.employees.update(editing.id, { name: editing.name, type: editing.type });
      setEditing(null);
      load();
    } catch (err) { setError(err.message); }
  };

  const toggleActive = async (emp) => {
    setError('');
    try { await api.employees.update(emp.id, { active: !emp.active }); load(); }
    catch (err) { setError(err.message); }
  };

  const remove = async (emp) => {
    if (!window.confirm(`Delete ${emp.name}?`)) return;
    setError('');
    try { await api.employees.remove(emp.id); load(); }
    catch (err) { setError(err.message); }
  };

  return (
    <section>
      <div className="page-head"><h1>Employees</h1></div>

      <form className="inline-form" onSubmit={add}>
        <label className="grow">
          <span>New employee</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Full name" required />
        </label>
        <label>
          <span>Type</span>
          <select value={type} onChange={(e) => setType(e.target.value)}>
            <option value="Product">Product</option>
            <option value="Support">Support</option>
            <option value="Admin">Admin</option>
          </select>
        </label>
        <button className="primary" type="submit">Add employee</button>
      </form>
      <ErrorNote>{error}</ErrorNote>

      {!employees ? <Loading /> : employees.length === 0 ? (
        <div className="empty"><p>No employees yet. Add the people who can get a share of customer revenue.</p></div>
      ) : (
        <div className="table-wrap">
          <table className="grid list">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Type</th>
                <th scope="col">Status</th>
                <th scope="col" className="num">In splits</th>
                <th scope="col" className="num">Total earned</th>
                <th scope="col"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {employees.map((emp) => (
                <tr key={emp.id} className={emp.active ? '' : 'inactive'}>
                  <th scope="row">
                    {editing?.id === emp.id ? (
                      <form className="rename" onSubmit={saveName}>
                        <input aria-label="Employee name" value={editing.name} autoFocus
                          onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
                        <button className="primary small" type="submit">Save</button>
                        <button className="secondary small" type="button" onClick={() => setEditing(null)}>Cancel</button>
                      </form>
                    ) : emp.name}
                  </th>
                  <td>
                    {editing?.id === emp.id ? (
                      <select value={editing.type} onChange={(e) => setEditing({ ...editing, type: e.target.value })}>
                        <option value="Product">Product</option>
                        <option value="Support">Support</option>
                        <option value="Admin">Admin</option>
                      </select>
                    ) : emp.type}
                  </td>
                  <td>{emp.active ? 'Active' : 'Inactive'}</td>
                  <td className="num">{emp.split_count}</td>
                  <td><Money value={emp.total_pay} /></td>
                  <td className="row-actions">
                    {editing?.id !== emp.id && (
                      <>
                        <button className="link" onClick={() => setEditing({ id: emp.id, name: emp.name, type: emp.type })}>Edit</button>
                        <button className="link" onClick={() => toggleActive(emp)}>{emp.active ? 'Mark inactive' : 'Mark active'}</button>
                        {emp.split_count === 0 && <button className="link danger" onClick={() => remove(emp)}>Delete</button>}
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="muted small">
        Inactive employees keep their pay history but no longer appear when you add contributors.
        Employees who are already part of a split can't be deleted.
      </p>
    </section>
  );
}
