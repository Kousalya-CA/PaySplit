import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { monthLabel, periodLabel, pct, money, periodMonths } from '../format.js';
import { navigate } from '../useHashRoute.js';
import { Loading, ErrorNote } from '../components/common.jsx';
import { FrequencyChoice } from './CustomersPage.jsx';
import RevenueShares, { sharesFromCustomer, relayoutShares, moveOnboarding, sharesForApi, shareMonths } from './RevenueShares.jsx';
import PeriodEditor from './PeriodEditor.jsx';
import TeamProgress from './TeamProgress.jsx';

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

  const deleteCustomer = async () => {
    if (!window.confirm(`Delete ${customer.name} and all of its periods and splits? This can't be undone.`)) return;
    try {
      await api.customers.remove(customer.id);
      navigate('/customers');
    } catch (e) { setError(e.message); }
  };

  // Periods grouped by the revenue share that covers them. Periods outside every share (only
  // possible for old data with revenue) get their own group.
  const groups = customer.shares.map((s) => ({
    key: s.id, name: s.name, months: shareMonths(s),
    periods: periods.filter((p) => p.share?.id === s.id),
  }));
  const loose = periods.filter((p) => !p.share);
  if (loose.length) groups.push({ key: 'none', name: 'No revenue share', months: 'Not covered by any share', periods: loose });
  const activeGroup = groups.find((g) => g.periods.some((p) => p.id === selectedId));
  const unit = periodMonths(customer.frequency) > 1 ? 'Years' : 'Months';

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
                <strong>{s.name}</strong> ({shareMonths(s)}): Direct {pct(s.direct_pct)},
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
            // Changing the shares or frequency can add and remove periods.
            if (!c.periods.some((p) => p.id === selectedId)) { setDirty(false); setSelectedId(c.periods[0]?.id ?? null); }
          }} onDelete={deleteCustomer} />
      )}

      <div className="periods-bar">
        <h2 id="shares-label">Share types</h2>
        <div className="period-tabs" role="tablist" aria-labelledby="shares-label">
          {groups.map((g) => {
            const revenue = g.periods.reduce((s, p) => s + p.revenue, 0);
            return (
              <button key={g.key} role="tab" aria-selected={g === activeGroup} disabled={!g.periods.length}
                className={`period-tab ${revenue > 0 ? 'has-revenue' : ''}`} onClick={() => g.periods[0] && choosePeriod(g.periods[0].id)}>
                <span>{g.name}</span>
                <small>{g.months}</small>
                <small>{revenue > 0 ? money(revenue) : 'No revenue'}</small>
              </button>
            );
          })}
        </div>

        {activeGroup && activeGroup.periods.length > 1 && (
          <>
            <h3 id="periods-label">{activeGroup.name}: {unit.toLowerCase()}</h3>
            <div className="period-tabs" role="tablist" aria-labelledby="periods-label">
              {activeGroup.periods.map((p) => (
                <button key={p.id} role="tab" aria-selected={p.id === selectedId}
                  className={`period-tab ${p.revenue > 0 ? 'has-revenue' : ''}`} onClick={() => choosePeriod(p.id)}>
                  <span>{periodLabel(p)}</span>
                  <small>{p.revenue > 0 ? money(p.revenue) : 'No revenue'}</small>
                </button>
              ))}
            </div>
          </>
        )}
      </div>

      {period ? (
        <PeriodEditor
          key={period.id}
          customer={customer}
          period={period}
          prev={prev}
          employees={employees}
          onDirtyChange={setDirty}
          onSaved={setCustomer}
        />
      ) : (
        <div className="empty"><p>This customer has no periods. Add a revenue share in Edit customer to create them.</p></div>
      )}

      <TeamProgress customer={customer} />
    </section>
  );
}

function EditCustomer({ customer, onCancel, onSaved, onDelete }) {
  const [name, setName] = useState(customer.name);
  const [onboard, setOnboard] = useState(customer.onboard_month);
  const [frequency, setFrequency] = useState(customer.frequency);
  const [azdoClient, setAzdoClient] = useState(customer.azdo_client || '');
  const [shares, setShares] = useState(() => sharesFromCustomer(customer));
  const changeFrequency = (f) => {
    setFrequency(f);
    setShares(relayoutShares(shares, onboard, f));
  };
  const changeOnboard = (month) => {
    setOnboard(month);
    if (month) setShares(moveOnboarding(shares, onboard || month, month, frequency));
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
        onboard_month: onboard,
        frequency,
        azdo_client: azdoClient,
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
      <div className="row">
        <label className="grow">
          <span>Customer name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} required />
        </label>
        <label>
          <span>Onboard month</span>
          <input type="month" value={onboard} onChange={(e) => changeOnboard(e.target.value)} required />
        </label>
      </div>
      <label>
        <span>Client name in Azure DevOps</span>
        <input value={azdoClient} onChange={(e) => setAzdoClient(e.target.value)} placeholder={name || 'Same as the customer name'} maxLength={200} />
        <small className="muted">How the Client field spells this customer on the sprint board. Leave empty to use the customer name; separate several spellings with commas.</small>
      </label>
      <FrequencyChoice value={frequency} onChange={changeFrequency} />
      {onboard && <RevenueShares shares={shares} onChange={setShares} onboard={onboard} frequency={frequency} />}
      <p className="muted small">
        Changing a revenue share recalculates pay for the periods it covers. Its payments appear
        under Share types; payments no share covers any more are removed (unless revenue or a split
        has been entered). Changing the onboard month moves the Onboarding share with it.
        The payment frequency can only be changed before any revenue or split is entered.
      </p>
      <div className="actions">
        <button className="primary" type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save changes'}</button>
        <button className="secondary" type="button" onClick={onCancel}>Cancel</button>
        <button className="danger-link" type="button" onClick={onDelete}>Delete customer</button>
      </div>
    </form>
  );
}
