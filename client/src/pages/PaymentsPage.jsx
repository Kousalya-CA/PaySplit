import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { monthLabel, pct, dayLabel, moneyList, CURRENCIES, quarterLabel, payoutStatusLabel } from '../format.js';
import { Loading, ErrorNote, Money } from '../components/common.jsx';
import { EmpName, useEmployeeMap } from '../components/EmpStatus.jsx';
import Avatar, { WithAvatar } from '../components/Avatar.jsx';

// Same as the "All Payments" sheet: one row per employee per category per period (one row per month
// when a payment is split over months). The first column is the month the pay is for.
// An Employee login gets only their own rows (the server filters them). Pay is in the payment's
// currency (INR when the payment was converted). Total revenue isn't shown, only the employees' share.
export default function PaymentsPage({ isAdmin }) {
  const [rows, setRows] = useState(null);
  const emps = useEmployeeMap(isAdmin); // PIP / Relieved highlights (admins only)
  const [error, setError] = useState('');
  const [filters, setFilters] = useState({ customer: '', employee: '', year: '', status: '', currency: '' });

  useEffect(() => { api.payments().then(setRows).catch((e) => setError(e.message)); }, []);

  const options = useMemo(() => {
    const list = rows || [];
    const uniq = (f) => [...new Set(list.map(f))].sort();
    return {
      customers: uniq((r) => r.customer), employees: uniq((r) => r.employee), years: uniq((r) => r.month.slice(0, 4)),
      currencies: CURRENCIES.filter((c) => list.some((r) => r.currency === c)),
    };
  }, [rows]);

  const visible = (rows || []).filter((r) =>
    (!filters.customer || r.customer === filters.customer) &&
    (!filters.employee || r.employee === filters.employee) &&
    (!filters.year || r.month.startsWith(filters.year)) &&
    (!filters.status || (filters.status === 'paid' ? r.paid_on : !r.paid_on)) &&
    (!filters.currency || r.currency === filters.currency));
  // Totals per currency: [{ currency, amount }]
  const sumBy = (field) => options.currencies
    .map((currency) => ({ currency, amount: visible.filter((r) => r.currency === currency).reduce((s, r) => s + r[field], 0) }))
    .filter((x) => visible.some((r) => r.currency === x.currency));
  const totals = sumBy('pay');
  const paidTotals = sumBy('paid');

  const exportCsv = () => {
    const header = ['Customer', 'Pay month', 'Month', 'Year', 'Period', 'Payment type', 'Part', 'Parts', 'Category', 'Employee',
      'Rate to INR', 'Employees\' share', 'Category %', 'Weightage %', 'Pay (this month)', 'Pay currency', 'Contributor pay for the payment', 'Status', 'Paid on', 'Paid amount', 'Payout', 'Payout status'];
    const lines = visible.map((r) => [
      r.customer, monthLabel(r.month), Number(r.month.slice(5)), Number(r.month.slice(0, 4)), monthLabel(r.start_month),
      r.payout_type === 'custom' ? 'Custom' : 'One time', r.part, r.parts,
      r.category, r.employee,
      r.fx_rate ?? '', r.revenue, +(r.category_pct * 100).toFixed(4), +(r.weightage * 100).toFixed(4), r.pay.toFixed(2), r.currency, r.total_pay.toFixed(2),
      r.paid_on ? 'Paid' : 'Unpaid', r.paid_on || '', r.paid_on ? r.paid.toFixed(2) : '', r.payout_quarter ? quarterLabel(r.payout_quarter) : '', r.payout_status ? payoutStatusLabel[r.payout_status] : '',
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
        <h1>{isAdmin ? 'All payments' : 'My payments'}</h1>
        {rows?.length > 0 && <button className="secondary" onClick={exportCsv}>Download CSV</button>}
      </div>
      <ErrorNote>{error}</ErrorNote>

      {!rows ? <Loading /> : rows.length === 0 ? (
        <div className="empty">
          <p>
            {isAdmin
              ? 'No payments yet. Open a customer, enter revenue and add contributors to see them here.'
              : 'No payments for you yet. If you expected some, ask an admin to check your email on the Employees page matches your login.'}
          </p>
        </div>
      ) : (
        <>
          <div className="filters">
            <label><span>Customer</span>
              <select value={filters.customer} onChange={setFilter('customer')}>
                <option value="">All customers</option>
                {options.customers.map((c) => <option key={c}>{c}</option>)}
              </select>
            </label>
            {isAdmin && (
              <label><span>Employee</span>
                <select value={filters.employee} onChange={setFilter('employee')}>
                  <option value="">All employees</option>
                  {options.employees.map((c) => <option key={c}>{c}</option>)}
                </select>
              </label>
            )}
            <label><span>Year</span>
              <select value={filters.year} onChange={setFilter('year')}>
                <option value="">All years</option>
                {options.years.map((c) => <option key={c}>{c}</option>)}
              </select>
            </label>
            {options.currencies.length > 1 && (
              <label><span>Currency</span>
                <select value={filters.currency} onChange={setFilter('currency')}>
                  <option value="">All currencies</option>
                  {options.currencies.map((c) => <option key={c}>{c}</option>)}
                </select>
              </label>
            )}
            <label><span>Status</span>
              <select value={filters.status} onChange={setFilter('status')}>
                <option value="">Paid and unpaid</option>
                <option value="paid">Paid</option>
                <option value="unpaid">Unpaid</option>
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
                  <th scope="col" className="num">Category</th>
                  <th scope="col" className="num">Weightage</th>
                  <th scope="col" className="num">Pay</th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((r) => (
                  <tr key={r.id}>
                    <td>
                      {monthLabel(r.month)}
                      {r.parts > 1 && <div className="muted small">{r.part} of {r.parts} · {monthLabel(r.start_month)} payment</div>}
                    </td>
                    <td>{isAdmin ? <a href={`#/customers/${r.customer_id}`}>{r.customer}</a> : r.customer}</td>
                    <td>{r.category}</td>
                    <th scope="row"><span className="with-pic"><Avatar id={r.employee_id} name={r.employee} size={20} /><EmpName emp={emps.get(r.employee_id)} name={r.employee} from={r.month} /></span></th>
                    <td className="num">{pct(r.category_pct)}</td>
                    <td className="num">{pct(r.weightage)}</td>
                    <td className="strong"><Money value={r.pay} currency={r.currency} /></td>
                    <td>
                      {r.paid_on ? <span className="paid-tag">✓ Paid {dayLabel(r.paid_on)}</span> : <span className="muted">Unpaid</span>}
                      {r.payout_quarter && <div className="muted small">{quarterLabel(r.payout_quarter)} payout · {payoutStatusLabel[r.payout_status]}</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th scope="row" colSpan={6}>Total for {visible.length} row{visible.length === 1 ? '' : 's'}</th>
                  <td className="num">{moneyList(totals) || '–'}</td>
                  <td className="small">Paid {moneyList(paidTotals) || '–'}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
