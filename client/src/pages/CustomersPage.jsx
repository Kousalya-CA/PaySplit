import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { monthLabel, pct } from '../format.js';
import { navigate } from '../useHashRoute.js';
import { Loading, ErrorNote, Money } from '../components/common.jsx';
import RevenueShares, { newShares, relayoutShares, sharesForApi } from './RevenueShares.jsx';

const thisMonth = () => new Date().toISOString().slice(0, 7);

export default function CustomersPage() {
  const [customers, setCustomers] = useState(null);
  const [error, setError] = useState('');
  const [adding, setAdding] = useState(false);

  useEffect(() => { api.customers.list().then(setCustomers).catch((e) => setError(e.message)); }, []);

  return (
    <section>
      <div className="page-head">
        <h1>Customers</h1>
        {!adding && <button className="primary" onClick={() => setAdding(true)}>Add customer</button>}
      </div>

      {adding && <NewCustomerForm onCancel={() => setAdding(false)} />}
      <ErrorNote>{error}</ErrorNote>

      {!customers ? <Loading /> : customers.length === 0 ? (
        !adding && <div className="empty"><p>No customers yet. Add your first customer to start splitting revenue.</p></div>
      ) : (
        <div className="table-wrap">
          <table className="grid list">
            <thead>
              <tr>
                <th scope="col">Customer</th>
                <th scope="col">Onboarded</th>
                <th scope="col">Payment</th>
                <th scope="col">Onboarding share (Direct / Support / Others)</th>
                <th scope="col" className="num">Revenue</th>
                <th scope="col" className="num">Paid out</th>
              </tr>
            </thead>
            <tbody>
              {customers.map((c) => (
                <tr key={c.id}>
                  <th scope="row"><a href={`#/customers/${c.id}`}>{c.name}</a></th>
                  <td>{monthLabel(c.onboard_month)}</td>
                  <td>{c.frequency}</td>
                  <td>
                    {c.shares[0] && `${pct(c.shares[0].direct_pct)} / ${pct(c.shares[0].support_pct)} / ${pct(c.shares[0].others_pct)}`}
                    {c.shares.length > 1 && <span className="muted small"> +{c.shares.length - 1} more</span>}
                  </td>
                  <td><Money value={c.total_revenue} /></td>
                  <td><Money value={c.total_paid} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

const FREQUENCY_OPTIONS = [
  ['Monthly', 'Enter revenue and the split each month. PaySplit creates 12 months from the onboard month.'],
  ['Yearly', 'Enter the annual revenue once. The split holds for 12 months from the onboard month.'],
  ['Three Years', 'Enter the revenue for the whole contract once. The split holds for 36 months from the onboard month.'],
];

export function FrequencyChoice({ value, onChange }) {
  return (
    <fieldset className="choice">
      <legend>Payment frequency</legend>
      {FREQUENCY_OPTIONS.map(([frequency, help]) => (
        <label key={frequency}>
          <input type="radio" name="freq" checked={value === frequency} onChange={() => onChange(frequency)} />
          <span><strong>{frequency}</strong> {help}</span>
        </label>
      ))}
    </fieldset>
  );
}

function NewCustomerForm({ onCancel }) {
  const [form, setForm] = useState({ name: '', onboard_month: thisMonth(), frequency: 'Monthly' });
  const [shares, setShares] = useState(() => newShares(form.onboard_month, form.frequency));
  // Moving the onboard month or changing the frequency lays the shares out again from the onboard month.
  const changeForm = (patch) => {
    const next = { ...form, ...patch };
    setForm(next);
    if (next.onboard_month && (next.onboard_month !== form.onboard_month || next.frequency !== form.frequency)) {
      setShares(relayoutShares(shares, next.onboard_month, next.frequency));
    }
  };
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setSaving(true);
    try {
      const c = await api.customers.create({ ...form, shares: sharesForApi(shares) });
      navigate(`/customers/${c.id}`);
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  };

  return (
    <form className="panel" onSubmit={submit}>
      <h2>New customer</h2>
      <ErrorNote>{error}</ErrorNote>
      <div className="row">
        <label className="grow">
          <span>Customer name</span>
          <input value={form.name} onChange={(e) => changeForm({ name: e.target.value })} required autoFocus />
        </label>
        <label>
          <span>Onboard month</span>
          <input type="month" value={form.onboard_month} onChange={(e) => changeForm({ onboard_month: e.target.value })} required />
        </label>
      </div>

      <FrequencyChoice value={form.frequency} onChange={(frequency) => changeForm({ frequency })} />

      {form.onboard_month && (
        <RevenueShares shares={shares} onChange={setShares} onboard={form.onboard_month} frequency={form.frequency} />
      )}

      <div className="actions">
        <button className="primary" type="submit" disabled={saving}>{saving ? 'Adding…' : 'Add customer'}</button>
        <button className="secondary" type="button" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}
