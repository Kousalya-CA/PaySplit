import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { monthLabel, dayLabel, moneyList, CURRENCIES } from '../format.js';
import { navigate } from '../useHashRoute.js';
import { Loading, ErrorNote, Money } from '../components/common.jsx';
import RevenueShares, { newShares, relayoutShares, sharesForApi } from './RevenueShares.jsx';
import { latestDeployments, serviceText } from './Deployments.jsx';

const thisMonth = () => new Date().toISOString().slice(0, 7);

export default function CustomersPage() {
  const [customers, setCustomers] = useState(null);
  const [error, setError] = useState('');
  const [adding, setAdding] = useState(false);
  const [deployments, setDeployments] = useState([]);

  useEffect(() => {
    api.customers.list().then(setCustomers).catch((e) => setError(e.message));
    api.deployments.list().then((d) => setDeployments(d.deployments)).catch(() => {});
  }, []);

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
                <th scope="col">Currency</th>
                <th scope="col" className="num">Allocated</th>
                <th scope="col">Deployed</th>
              </tr>
            </thead>
            <tbody>
              {customers.map((c) => (
                <tr key={c.id}>
                  <th scope="row"><a href={`#/customers/${c.id}`}>{c.name}</a></th>
                  <td>{monthLabel(c.onboard_month)}</td>
                  <td>{c.frequency}</td>
                  <td>{c.currency}</td>
                  <td className="num">{moneyList(c.allocated) || <Money value={0} />}</td>
                  <td><DeployedCell customer={c} deployments={deployments} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// The latest deployment of each product and environment, linking to the customer's Deployments section.
function DeployedCell({ customer, deployments }) {
  const latest = latestDeployments(deployments.filter((d) => d.customer_id === customer.id));
  const href = `#/customers/${customer.id}/deployments`;
  if (!latest.length) return <a className="muted small" href={href}>Add</a>;
  return (
    <a className="dep-cell" href={href}>
      {latest.map((d) => (
        <span key={d.id} title={serviceText(d)}>
          {d.product} · {d.environment} · {dayLabel(d.deployed_on)}
        </span>
      ))}
    </a>
  );
}

const FREQUENCY_OPTIONS = [
  ['Monthly', 'Enter revenue and the split each month. PaySplit creates 12 months from the onboard month.'],
  ['Yearly', 'Enter the annual revenue once. The split holds for 12 months from the onboard month.'],
  ['Three Years', 'A 36-month contract with 3 yearly periods: Year 1, Year 2, Year 3. Each year has its own revenue and split.'],
];

// The currency the customer is billed in. Revenue is entered in it, and pay is in it unless a
// payment is converted to INR.
export function CurrencyField({ value, onChange, disabled }) {
  return (
    <label className="currency-field">
      <span>Currency</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled}>
        {CURRENCIES.map((c) => <option key={c}>{c}</option>)}
      </select>
      <small className="muted">
        {disabled ? 'Revenue is already entered in this currency, so it can\'t change.'
          : 'Revenue is entered in this currency. Pay stays in it unless a payment is converted to INR.'}
      </small>
    </label>
  );
}

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
  const [form, setForm] = useState({ name: '', onboard_month: thisMonth(), frequency: 'Monthly', currency: 'INR' });
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

      <CurrencyField value={form.currency} onChange={(currency) => changeForm({ currency })} />
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
