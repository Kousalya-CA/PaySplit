import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { monthLabel, periodLabel, pct, money, addMonths, periodMonths } from '../format.js';
import { navigate } from '../useHashRoute.js';
import { Loading, ErrorNote } from '../components/common.jsx';
import { FrequencyChoice } from './CustomersPage.jsx';
import RevenueShares, { sharesFromCustomer, relayoutShares, sharesForApi, shareMonths } from './RevenueShares.jsx';
import PeriodEditor from './PeriodEditor.jsx';

export default function CustomerDetail({ id }) {
  const [customer, setCustomer] = useState(null);
  const [employees, setEmployees] = useState([]);
  const [error, setError] = useState('');
  const [selectedId, setSelectedId] = useState(null);
  const [dirty, setDirty] = useState(false);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    Promise.all([api.customers.get(id), api.employees.list()])
      .then(([c, e]) => {
        setCustomer(c);
        setEmployees(e);
        // Open the latest period that has revenue, otherwise the first one.
        const withRevenue = c.periods.filter((p) => p.revenue > 0);
        setSelectedId((withRevenue.at(-1) || c.periods[0])?.id ?? null);
      })
      .catch((e) => setError(e.message));
  }, [id]);

  // Warn before leaving the page with unsaved changes.
  useEffect(() => {
    if (!dirty) return;
    const warn = (e) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  if (error && !customer) return <ErrorNote>{error}</ErrorNote>;
  if (!customer) return <Loading />;

  const periods = customer.periods;
  const index = periods.findIndex((p) => p.id === selectedId);
  const period = periods[index];
  const prev = index > 0 ? periods[index - 1] : null;

  const choosePeriod = (pid) => {
    if (pid === selectedId) return;
    if (dirty && !window.confirm('You have unsaved changes in this period. Discard them?')) return;
    setDirty(false);
    setSelectedId(pid);
  };

  const addPeriod = async () => {
    if (dirty && !window.confirm('You have unsaved changes in this period. Discard them?')) return;
    try {
      const c = await api.customers.addPeriod(customer.id);
      setCustomer(c);
      setDirty(false);
      setSelectedId(c.periods.at(-1).id);
    } catch (e) { setError(e.message); }
  };

  const deleteCustomer = async () => {
    if (!window.confirm(`Delete ${customer.name} and all of its periods and splits? This can't be undone.`)) return;
    try {
      await api.customers.remove(customer.id);
      navigate('/customers');
    } catch (e) { setError(e.message); }
  };

  const nextStart = periods.length
    ? monthLabel(addMonths(periods.at(-1).start_month, periodMonths(customer.frequency)))
    : monthLabel(customer.onboard_month);

  return (
    <section>
      <a className="back" href="#/customers">Customers</a>
      <div className="page-head">
        <div>
          <h1>{customer.name}</h1>
          <p className="muted">
            {customer.frequency} payment, onboarded {monthLabel(customer.onboard_month)}.
          </p>
          <ul className="share-list muted small">
            {customer.shares.map((s) => (
              <li key={s.id}>
                <strong>{s.name}</strong> ({shareMonths(s, customer.frequency)}): Direct {pct(s.direct_pct)},
                Support {pct(s.support_pct)}, Others {pct(s.others_pct)}
              </li>
            ))}
          </ul>
        </div>
        {!editing && <button className="secondary" onClick={() => setEditing(true)}>Edit customer</button>}
      </div>

      <ErrorNote>{error}</ErrorNote>
      {editing && (
        <EditCustomer customer={customer} onCancel={() => setEditing(false)}
          onSaved={(c) => {
            setCustomer(c);
            setEditing(false);
            // Changing the frequency replaces the periods.
            if (!c.periods.some((p) => p.id === selectedId)) { setDirty(false); setSelectedId(c.periods[0]?.id ?? null); }
          }} onDelete={deleteCustomer} />
      )}

      <div className="periods-bar">
        <h2 id="periods-label">{periodMonths(customer.frequency) > 1 ? 'Years' : 'Months'}</h2>
        <div className="period-tabs" role="tablist" aria-labelledby="periods-label">
          {periods.map((p) => (
            <button key={p.id} role="tab" aria-selected={p.id === selectedId}
              className={`period-tab ${p.revenue > 0 ? 'has-revenue' : ''}`} onClick={() => choosePeriod(p.id)}>
              <span>{periodLabel(p.start_month, customer.frequency)}</span>
              <small>{p.revenue > 0 ? money(p.revenue) : 'No revenue'}</small>
            </button>
          ))}
          <button className="period-add" onClick={addPeriod} title={`Adds ${nextStart}`}>Add {nextStart}</button>
        </div>
      </div>

      {period ? (
        <PeriodEditor
          key={period.id}
          customer={customer}
          period={period}
          prev={prev}
          employees={employees}
          onDirtyChange={setDirty}
          onSaved={(c) => {
            setCustomer(c);
            if (!c.periods.some((p) => p.id === selectedId)) setSelectedId(c.periods[Math.max(0, index - 1)]?.id ?? null);
          }}
        />
      ) : (
        <div className="empty"><p>This customer has no periods. Add one to enter revenue.</p></div>
      )}
    </section>
  );
}

function EditCustomer({ customer, onCancel, onSaved, onDelete }) {
  const [name, setName] = useState(customer.name);
  const [frequency, setFrequency] = useState(customer.frequency);
  const [shares, setShares] = useState(() => sharesFromCustomer(customer));
  const changeFrequency = (f) => {
    setFrequency(f);
    setShares(relayoutShares(shares, customer.onboard_month, f));
  };
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      onSaved(await api.customers.update(customer.id, {
        name,
        frequency,
        shares: sharesForApi(shares),
      }));
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  };

  return (
    <form className="panel" onSubmit={submit}>
      <h2>Edit customer</h2>
      <ErrorNote>{error}</ErrorNote>
      <label>
        <span>Customer name</span>
        <input value={name} onChange={(e) => setName(e.target.value)} required />
      </label>
      <FrequencyChoice value={frequency} onChange={changeFrequency} />
      <RevenueShares shares={shares} onChange={setShares} onboard={customer.onboard_month} frequency={frequency} />
      <p className="muted small">
        Changing a revenue share recalculates pay for the periods it covers.
        The payment frequency can only be changed before any revenue or split is entered.
        The onboard month can't be changed after the customer is created.
      </p>
      <div className="actions">
        <button className="primary" type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save changes'}</button>
        <button className="secondary" type="button" onClick={onCancel}>Cancel</button>
        <button className="danger-link" type="button" onClick={onDelete}>Delete customer</button>
      </div>
    </form>
  );
}
