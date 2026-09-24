import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { monthLabel, pct, parseNum } from '../format.js';
import { navigate } from '../useHashRoute.js';
import { Loading, ErrorNote, Money } from '../components/common.jsx';

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
                <th scope="col">Direct / Support / Others</th>
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
                  <td>{pct(c.direct_pct)} / {pct(c.support_pct)} / {pct(c.others_pct)}</td>
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

export function SplitInputs({ values, onChange }) {
  const sum = ['direct', 'support', 'others'].reduce((s, k) => s + (parseNum(values[k]) || 0), 0);
  const ok = Math.abs(sum - 100) < 0.0001;
  return (
    <fieldset className="split-inputs">
      <legend>Share of revenue for each category</legend>
      <div className="row">
        {[['direct', 'Direct'], ['support', 'Support'], ['others', 'Others']].map(([k, label]) => (
          <label key={k}>
            <span>{label}</span>
            <span className="suffix-input">
              <input inputMode="decimal" value={values[k]} onChange={(e) => onChange({ ...values, [k]: e.target.value })} />
              <span aria-hidden="true">%</span>
            </span>
          </label>
        ))}
      </div>
      <p className={ok ? 'muted small' : 'warn-text small'}>
        {ok ? 'Adds up to 100%.' : `Adds up to ${+sum.toFixed(4)}%. It needs to be exactly 100%.`}
      </p>
    </fieldset>
  );
}

function NewCustomerForm({ onCancel }) {
  const [form, setForm] = useState({ name: '', onboard_month: thisMonth(), frequency: 'Monthly' });
  const [split, setSplit] = useState({ direct: '70', support: '20', others: '10' });
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setSaving(true);
    try {
      const c = await api.customers.create({
        ...form,
        direct_pct: parseNum(split.direct) / 100,
        support_pct: parseNum(split.support) / 100,
        others_pct: parseNum(split.others) / 100,
      });
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
          <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required autoFocus />
        </label>
        <label>
          <span>Onboard month</span>
          <input type="month" value={form.onboard_month} onChange={(e) => setForm({ ...form, onboard_month: e.target.value })} required />
        </label>
      </div>

      <fieldset className="choice">
        <legend>Payment frequency</legend>
        <label>
          <input type="radio" name="freq" checked={form.frequency === 'Monthly'} onChange={() => setForm({ ...form, frequency: 'Monthly' })} />
          <span><strong>Monthly</strong> Enter revenue and the split each month. PaySplit creates 12 months from the onboard month.</span>
        </label>
        <label>
          <input type="radio" name="freq" checked={form.frequency === 'Yearly'} onChange={() => setForm({ ...form, frequency: 'Yearly' })} />
          <span><strong>Yearly</strong> Enter the annual revenue once. The split holds for 12 months from the onboard month.</span>
        </label>
      </fieldset>

      <SplitInputs values={split} onChange={setSplit} />

      <div className="actions">
        <button className="primary" type="submit" disabled={saving}>{saving ? 'Adding…' : 'Add customer'}</button>
        <button className="secondary" type="button" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}
