import { addMonths, monthLabel, parseNum, periodMonths } from '../format.js';

// Revenue shares: the Direct/Support/Others split for a range of months. The first share is
// always "Onboarding" and starts in the onboard month: Monthly runs to a To month you choose
// (12 months by default); Yearly and Three Years covers the first 12 or 36 months and is paid once,
// in a payment month you choose. Share types added after it (Renewal, ...) have From and To months.
// The customer's periods are the payments inside its shares: every month for Monthly, one payment
// per share (From to To) for Yearly and Three Years.
let nextKey = 1;
const pctText = (fraction) => String(+(fraction * 100).toFixed(4));
// Default length of a share: 12 months for Monthly and Yearly, 36 for Three Years.
const spanFor = (frequency) => (frequency === 'Monthly' ? 12 : periodMonths(frequency));

// Default months for the share at position i: back to back from the onboard month.
function monthsAt(i, onboard, frequency) {
  const span = spanFor(frequency);
  const from = addMonths(onboard, i * span);
  return { from_month: from, to_month: addMonths(from, span - 1), payment_month: from };
}

export const newShares = (onboard, frequency) => [
  { key: nextKey++, name: 'Onboarding', ...monthsAt(0, onboard, frequency), direct: '70', support: '20', others: '10' },
];

export const sharesFromCustomer = (customer) => customer.shares.map((s) => ({
  key: nextKey++, name: s.name, from_month: s.from_month, to_month: s.to_month || '',
  payment_month: s.payment_month || s.from_month,
  direct: pctText(s.direct_pct), support: pctText(s.support_pct), others: pctText(s.others_pct),
}));

// After the onboard month or frequency changes, lay the shares out again (names and % are kept).
export const relayoutShares = (shares, onboard, frequency) =>
  shares.map((s, i) => ({ ...s, ...monthsAt(i, onboard, frequency) }));

export const sharesForApi = (shares) => shares.map((s) => ({
  name: s.name,
  from_month: s.from_month,
  to_month: s.to_month || null,
  payment_month: s.payment_month || null,
  direct_pct: parseNum(s.direct) / 100,
  support_pct: parseNum(s.support) / 100,
  others_pct: parseNum(s.others) / 100,
}));

// 'Oct 2026 to Sep 2027', 'Sep 2026' when a share is a single month, plus ', paid Dec 2026'
// when a Yearly / Three Years onboarding share is paid in a later month.
export const shareMonths = (share) => {
  const months = !share.to_month || share.to_month === share.from_month
    ? monthLabel(share.from_month)
    : `${monthLabel(share.from_month)} to ${monthLabel(share.to_month)}`;
  return share.payment_month && share.payment_month !== share.from_month
    ? `${months}, paid ${monthLabel(share.payment_month)}` : months;
};

// Months from From to To, counting both.
const monthCount = (share) => {
  if (!share.from_month || !share.to_month || share.to_month < share.from_month) return 0;
  const [y1, m1] = share.from_month.split('-').map(Number);
  const [y2, m2] = share.to_month.split('-').map(Number);
  return (y2 - y1) * 12 + (m2 - m1) + 1;
};
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

export default function RevenueShares({ shares, onChange, onboard, frequency }) {
  const monthly = frequency === 'Monthly';
  const span = spanFor(frequency);

  const update = (key, patch) => onChange(shares.map((s) => (s.key === key ? { ...s, ...patch } : s)));
  const remove = (key) => onChange(shares.filter((s) => s.key !== key));

  // A new share starts the month after the latest one ends, runs 12 months (36 for Three Years)
  // and copies its percentages.
  const add = () => {
    const last = shares.reduce((a, s) => (s.from_month > a.from_month ? s : a), shares[0]);
    const from = addMonths(last.to_month || last.from_month, 1);
    onChange([...shares, {
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
              <label className="month-field">
                <span>From</span>
                <input type="month" value={s.from_month} disabled={first} required
                  onChange={(e) => update(s.key, { from_month: e.target.value })} />
              </label>
              <label className="month-field">
                <span>To</span>
                <input type="month" value={s.to_month} min={s.from_month} disabled={oneTime} required
                  onChange={(e) => update(s.key, { to_month: e.target.value })} />
              </label>
              {oneTime && (
                <label className="month-field">
                  <span>Payment month</span>
                  <input type="month" value={s.payment_month} min={s.from_month} max={s.to_month} required
                    onChange={(e) => update(s.key, { payment_month: e.target.value })} />
                </label>
              )}
            </div>
            <p className="muted small">
              {oneTime
                ? `One-time payment for the first ${span} months, paid in ${s.payment_month ? monthLabel(s.payment_month) : 'the payment month'}.`
                : monthly
                  ? `${plural(monthCount(s), 'monthly payment')}${first ? ', starting in the onboard month' : ''}.`
                  : `One payment covering ${plural(monthCount(s), 'month')}.`}
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
