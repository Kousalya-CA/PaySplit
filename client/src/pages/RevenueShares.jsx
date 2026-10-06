import { addMonths, monthLabel, parseNum, periodMonths } from '../format.js';

// Revenue shares: the Direct/Support/Others split for a range of months. The first share is
// always "Onboarding" and starts in the onboard month: Monthly runs to a To month you choose
// (12 months by default); Yearly and Three Years is the one-time onboarding payment. Share types
// added after it (Renewal, ...) have From and To months for every payment type. The customer's
// periods are the payments inside its shares.
let nextKey = 1;
const pctText = (fraction) => String(+(fraction * 100).toFixed(4));

// Default months for the share at position i: back to back from the onboard month, 12 months
// each for Monthly, one payment each for Yearly and Three Years.
function monthsAt(i, onboard, frequency) {
  const span = frequency === 'Monthly' ? 12 : periodMonths(frequency);
  const from = addMonths(onboard, i * span);
  if (i === 0 && frequency !== 'Monthly') return { from_month: from, to_month: from };
  return { from_month: from, to_month: addMonths(from, span - 1) };
}

export const newShares = (onboard, frequency) => [
  { key: nextKey++, name: 'Onboarding', ...monthsAt(0, onboard, frequency), direct: '70', support: '20', others: '10' },
];

export const sharesFromCustomer = (customer) => customer.shares.map((s) => ({
  key: nextKey++, name: s.name, from_month: s.from_month, to_month: s.to_month || '',
  direct: pctText(s.direct_pct), support: pctText(s.support_pct), others: pctText(s.others_pct),
}));

// After the onboard month or frequency changes, lay the shares out again (names and % are kept).
export const relayoutShares = (shares, onboard, frequency) =>
  shares.map((s, i) => ({ ...s, ...monthsAt(i, onboard, frequency) }));

export const sharesForApi = (shares) => shares.map((s) => ({
  name: s.name,
  from_month: s.from_month,
  to_month: s.to_month || null,
  direct_pct: parseNum(s.direct) / 100,
  support_pct: parseNum(s.support) / 100,
  others_pct: parseNum(s.others) / 100,
}));

// 'Oct 2026 to Sep 2027', or 'Oct 2026 (one-time payment)' for a Yearly or Three Years
// onboarding share.
export const shareMonths = (share, frequency) => {
  if (frequency !== 'Monthly' && share.from_month === share.to_month) return `${monthLabel(share.from_month)} (one-time payment)`;
  return `${monthLabel(share.from_month)} to ${monthLabel(share.to_month)}`;
};

// How many payments a share creates: every month for Monthly, every 12 or 36 months from the
// From month for Yearly and Three Years (the same rule as the server).
const paymentCount = (share, frequency) => {
  if (!share.from_month || !share.to_month || share.to_month < share.from_month) return 0;
  const [y1, m1] = share.from_month.split('-').map(Number);
  const [y2, m2] = share.to_month.split('-').map(Number);
  return Math.floor(((y2 - y1) * 12 + (m2 - m1)) / periodMonths(frequency)) + 1;
};
const PAYMENT_WORD = { Monthly: 'monthly payment', Yearly: 'yearly payment', 'Three Years': '3-year payment' };

const ONBOARDING_NOTE = {
  Yearly: 'One-time share for the onboarding payment (12 months).',
  'Three Years': 'One-time share for the onboarding payment (36 months).',
};

export default function RevenueShares({ shares, onChange, onboard, frequency }) {
  const monthly = frequency === 'Monthly';
  const span = monthly ? 12 : periodMonths(frequency);

  const update = (key, patch) => onChange(shares.map((s) => (s.key === key ? { ...s, ...patch } : s)));
  const remove = (key) => onChange(shares.filter((s) => s.key !== key));

  // A new share starts right after the latest one (12 months, or one payment for Yearly and
  // Three Years) and copies its percentages. A latest share with no To month is given one first.
  const add = () => {
    const last = shares.reduce((a, s) => (s.from_month > a.from_month ? s : a), shares[0]);
    const lastTo = last.to_month || addMonths(last.from_month, span - 1);
    const list = last.to_month ? shares : shares.map((s) => (s.key === last.key ? { ...s, to_month: lastTo } : s));
    // Yearly / Three Years: the next payment month after the latest share.
    let from = addMonths(lastTo, 1);
    if (!monthly) {
      from = onboard;
      while (from <= lastTo) from = addMonths(from, span);
    }
    onChange([...list, {
      key: nextKey++, name: '', from_month: from, to_month: addMonths(from, span - 1),
      direct: last.direct, support: last.support, others: last.others,
    }]);
  };

  return (
    <div className="shares">
      {shares.map((s, i) => {
        const first = i === 0;
        const oneTime = first && !monthly;
        const sum = ['direct', 'support', 'others'].reduce((t, k) => t + (parseNum(s[k]) || 0), 0);
        const ok = Math.abs(sum - 100) < 0.0001;
        return (
          <fieldset key={s.key} className="split-inputs share">
            <legend>Revenue share for {first ? 'Onboarding' : s.name.trim() || 'a new share type'}</legend>
            <div className="row">
              {!first && (
                <label className="grow">
                  <span>Share type</span>
                  <input value={s.name} placeholder="For example Renewal" onChange={(e) => update(s.key, { name: e.target.value })} required />
                </label>
              )}
              {oneTime ? (
                <label>
                  <span>Payment</span>
                  <input type="month" value={s.from_month} disabled />
                </label>
              ) : (
                <>
                  <label>
                    <span>From</span>
                    <input type="month" value={s.from_month} disabled={first} required
                      onChange={(e) => update(s.key, { from_month: e.target.value })} />
                  </label>
                  <label>
                    <span>To</span>
                    <input type="month" value={s.to_month} min={s.from_month} required
                      onChange={(e) => update(s.key, { to_month: e.target.value })} />
                  </label>
                </>
              )}
            </div>
            <p className="muted small">
              {oneTime ? ONBOARDING_NOTE[frequency] : (() => {
                const n = paymentCount(s, frequency);
                return `${n} ${PAYMENT_WORD[frequency]}${n === 1 ? '' : 's'}${first ? ', starting in the onboard month' : ''}.`;
              })()}
            </p>
            <div className="row">
              {[['direct', 'Direct'], ['support', 'Support'], ['others', 'Others']].map(([k, label]) => (
                <label key={k}>
                  <span>{label}</span>
                  <span className="suffix-input">
                    <input inputMode="decimal" value={s[k]} onChange={(e) => update(s.key, { [k]: e.target.value })} />
                    <span aria-hidden="true">%</span>
                  </span>
                </label>
              ))}
            </div>
            <div className="share-foot">
              <p className={ok ? 'muted small' : 'warn-text small'}>
                {ok ? 'Adds up to 100%.' : `Adds up to ${+sum.toFixed(4)}%. It needs to be exactly 100%.`}
              </p>
              {!first && <button type="button" className="link danger" onClick={() => remove(s.key)}>Remove</button>}
            </div>
          </fieldset>
        );
      })}
      <button type="button" className="secondary" onClick={add}>Add share type</button>
    </div>
  );
}
