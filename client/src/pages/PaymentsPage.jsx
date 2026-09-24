import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { monthLabel, pct } from '../format.js';
import { Loading, ErrorNote, Money } from '../components/common.jsx';

// Same as the "All Payments" sheet: one row per employee per category per period.
export default function PaymentsPage() {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');
  const [filters, setFilters] = useState({ customer: '', employee: '', year: '' });

  useEffect(() => { api.payments().then(setRows).catch((e) => setError(e.message)); }, []);

  const options = useMemo(() => {
    const list = rows || [];
    const uniq = (f) => [...new Set(list.map(f))].sort();
    return { customers: uniq((r) => r.customer), employees: uniq((r) => r.employee), years: uniq((r) => r.start_month.slice(0, 4)) };
  }, [rows]);

  const visible = (rows || []).filter((r) =>
    (!filters.customer || r.customer === filters.customer) &&
    (!filters.employee || r.employee === filters.employee) &&
    (!filters.year || r.start_month.startsWith(filters.year)));
  const total = visible.reduce((s, r) => s + r.pay, 0);

  const exportCsv = () => {
    const header = ['Customer', 'Period', 'Month', 'Year', 'Category', 'Employee', 'Revenue', 'Category %', 'Weightage %', 'Pay'];
    const lines = visible.map((r) => [
      r.customer, monthLabel(r.start_month), Number(r.start_month.slice(5)), Number(r.start_month.slice(0, 4)),
      r.category, r.employee, r.revenue, +(r.category_pct * 100).toFixed(4), +(r.weightage * 100).toFixed(4), r.pay.toFixed(2),
    ]);
    const csv = [header, ...lines].map((l) => l.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\r\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: 'paysplit-payments.csv' });
    a.click();
    URL.revokeObjectURL(url);
  };

  const setFilter = (k) => (e) => setFilters({ ...filters, [k]: e.target.value });

  return (
    <section>
      <div className="page-head">
        <h1>All payments</h1>
        {rows?.length > 0 && <button className="secondary" onClick={exportCsv}>Download CSV</button>}
      </div>
      <ErrorNote>{error}</ErrorNote>

      {!rows ? <Loading /> : rows.length === 0 ? (
        <div className="empty"><p>No payments yet. Open a customer, enter revenue and add contributors to see them here.</p></div>
      ) : (
        <>
          <div className="filters">
            <label><span>Customer</span>
              <select value={filters.customer} onChange={setFilter('customer')}>
                <option value="">All customers</option>
                {options.customers.map((c) => <option key={c}>{c}</option>)}
              </select>
            </label>
            <label><span>Employee</span>
              <select value={filters.employee} onChange={setFilter('employee')}>
                <option value="">All employees</option>
                {options.employees.map((c) => <option key={c}>{c}</option>)}
              </select>
            </label>
            <label><span>Year</span>
              <select value={filters.year} onChange={setFilter('year')}>
                <option value="">All years</option>
                {options.years.map((c) => <option key={c}>{c}</option>)}
              </select>
            </label>
          </div>

          <div className="table-wrap">
            <table className="grid list">
              <thead>
                <tr>
                  <th scope="col">Period</th>
                  <th scope="col">Customer</th>
                  <th scope="col">Category</th>
                  <th scope="col">Employee</th>
                  <th scope="col" className="num">Revenue</th>
                  <th scope="col" className="num">Category</th>
                  <th scope="col" className="num">Weightage</th>
                  <th scope="col" className="num">Pay</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((r) => (
                  <tr key={r.id}>
                    <td>{monthLabel(r.start_month)}</td>
                    <td><a href={`#/customers/${r.customer_id}`}>{r.customer}</a></td>
                    <td>{r.category}</td>
                    <th scope="row">{r.employee}</th>
                    <td><Money value={r.revenue} /></td>
                    <td className="num">{pct(r.category_pct)}</td>
                    <td className="num">{pct(r.weightage)}</td>
                    <td className="strong"><Money value={r.pay} /></td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th scope="row" colSpan={7}>Total for {visible.length} row{visible.length === 1 ? '' : 's'}</th>
                  <td><Money value={total} /></td>
                </tr>
              </tfoot>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
