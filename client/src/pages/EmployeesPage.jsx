import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Loading, ErrorNote, Money } from '../components/common.jsx';

// Admins manage everyone. An Employee login sees only their own row (the server filters it).
export default function EmployeesPage({ isAdmin }) {
  const [employees, setEmployees] = useState(null);
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [type, setType] = useState('Product');
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(null); // { id, employee_code, name, email, type }
  const [search, setSearch] = useState('');

  // Every word typed must appear in the name, employee ID, email or type. The row being edited stays.
  const words = search.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = (employees || []).filter((emp) => {
    if (!words.length || editing?.id === emp.id) return true;
    const text = [emp.name, emp.employee_code, emp.email, emp.type, emp.active ? 'active' : 'inactive'].join(' ').toLowerCase();
    return words.every((w) => text.includes(w));
  });

  const load = () => api.employees.list().then(setEmployees).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  const add = async (e) => {
    e.preventDefault();
    setError('');
    try {
      await api.employees.create({ employee_code: code, name, type, email });
      setCode('');
      setName('');
      setEmail('');
      setType('Product');
      load();
    } catch (err) { setError(err.message); }
  };

  const saveName = async (e) => {
    e.preventDefault();
    setError('');
    try {
      await api.employees.update(editing.id, { employee_code: editing.employee_code, name: editing.name, email: editing.email, type: editing.type });
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

      {isAdmin && <form className="inline-form" onSubmit={add}>
        <label>
          <span>Employee ID</span>
          <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="CA1023" maxLength={30} size={10} required />
        </label>
        <label className="grow">
          <span>New employee</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Full name" required />
        </label>
        <label className="grow">
          <span>Email</span>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@company.com" required />
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
      </form>}
      <ErrorNote>{error}</ErrorNote>

      {isAdmin && employees?.length > 0 && (
        <div className="search-bar">
          <label className="grow">
            <span className="sr-only">Search employees</span>
            <input type="search" value={search} onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by name, employee ID, email or type" />
          </label>
          <span className="muted small" role="status">
            {search.trim() ? `${shown.length} of ${employees.length} employees` : `${employees.length} employees`}
          </span>
        </div>
      )}

      {!employees ? <Loading /> : employees.length === 0 ? (
        <div className="empty">
          <p>
            {isAdmin
              ? 'No employees yet. Add the people who can get a share of customer revenue.'
              : 'Your login isn\'t linked to an employee yet. Ask an admin to add your email to your entry on the Employees page.'}
          </p>
        </div>
      ) : shown.length === 0 ? (
        <div className="empty"><p>No employees match "{search.trim()}".</p></div>
      ) : (
        <div className="table-wrap">
          <table className="grid list">
            <thead>
              <tr>
                <th scope="col">Employee ID</th>
                <th scope="col">Name</th>
                <th scope="col">Email</th>
                <th scope="col">Type</th>
                <th scope="col">Status</th>
                <th scope="col" className="num">In splits</th>
                <th scope="col" className="num">Total earned</th>
                {isAdmin && <th scope="col"><span className="sr-only">Actions</span></th>}
              </tr>
            </thead>
            <tbody>
              {shown.map((emp) => (
                <tr key={emp.id} className={emp.active ? '' : 'inactive'}>
                  <td>
                    {editing?.id === emp.id ? (
                      <input aria-label="Employee ID" value={editing.employee_code} placeholder="CA1023" maxLength={30} size={10} form={`edit-${emp.id}`}
                        required onChange={(e) => setEditing({ ...editing, employee_code: e.target.value })} />
                    ) : emp.employee_code || (isAdmin ? <span className="warn-text small">Add ID</span> : '–')}
                  </td>
                  <th scope="row">
                    {editing?.id === emp.id ? (
                      <form className="rename" id={`edit-${emp.id}`} onSubmit={saveName}>
                        <input aria-label="Employee name" value={editing.name} autoFocus
                          onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
                        <button className="primary small" type="submit">Save</button>
                        <button className="secondary small" type="button" onClick={() => setEditing(null)}>Cancel</button>
                      </form>
                    ) : <a href={`#/employees/${emp.id}`}>{emp.name}</a>}
                  </th>
                  <td>
                    {editing?.id === emp.id ? (
                      <input type="email" aria-label="Employee email" value={editing.email} placeholder="name@company.com" form={`edit-${emp.id}`}
                        required onChange={(e) => setEditing({ ...editing, email: e.target.value })} />
                    ) : emp.email || <span className="warn-text small">Add email</span>}
                  </td>
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
                  {isAdmin && (
                    <td className="row-actions">
                      {editing?.id !== emp.id && (
                        <>
                          <button className="link" onClick={() => setEditing({ id: emp.id, employee_code: emp.employee_code || '', name: emp.name, email: emp.email || '', type: emp.type })}>Edit</button>
                          <button className="link" onClick={() => toggleActive(emp)}>{emp.active ? 'Mark inactive' : 'Mark active'}</button>
                          {emp.split_count === 0 && <button className="link danger" onClick={() => remove(emp)}>Delete</button>}
                        </>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {isAdmin ? (
        <p className="muted small">
          Each employee's email should be the one they use on the Azure DevOps sprint board and to log in
          to PaySplit: an Employee login sees only the employee with the same email.
          Inactive employees keep their pay history but no longer appear when you add contributors.
          Employees who are already part of a split can't be deleted.
        </p>
      ) : <p className="muted small">Click your name to see your Azure DevOps tasks.</p>}
    </section>
  );
}
