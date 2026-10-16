import { addMonths, monthLabel, parseNum, periodMonths } from '../format.js';

// Revenue shares, each filled in top to bottom:
//   1. Payment date: the month billing starts (the onboard month is not the billing date).
//   2. Billing From (= the payment date) and To: Monthly bills every month, Yearly and Three Years
//      once a year from the payment date. To defaults to 12 months on (36 for Three Years).
//   3. Payment type: One time, or Custom with Payout From and To (the payment date and 12 months by
//      default) over which each payment's employees' share is split monthly. The payout months are
//      for the share's first payment; later payments move along by as many months.
//   4. The Direct / Support / Others split.
// The first share is always "Onboarding". The customer's periods are the payments inside its shares.
let nextKey = 1;
const pctText = (fraction) => String(+(fraction * 100).toFixed(4));
// Default billing length: 12 months for Monthly and Yearly, 36 for Three Years.
const spanFor = (frequency) => (frequency === 'Monthly' ? 12 : periodMonths(frequency));

const monthsBetween = (a, b) => {
  const [y1, m1] = a.split('-').map(Number);
  const [y2, m2] = b.split('-').map(Number);
  return (y2 - y1) * 12 + (m2 - m1);
};
const shift = (m, n) => (m ? addMonths(m, n) : m);
// Move a share (its billing and payout months) by n months.
const moveShare = (s, n) => ({ ...s, from_month: shift(s.from_month, n), to_month: shift(s.to_month, n), pay_from: shift(s.pay_from, n), pay_to: shift(s.pay_to, n) });

const blankShare = (name, from, frequency, copy = {}) => ({
  key: nextKey++, name, from_month: from, to_month: addMonths(from, spanFor(frequency) - 1),
  direct: copy.direct ?? '70', support: copy.support ?? '20', others: copy.others ?? '10',
  payout_type: copy.payout_type || 'once', pay_from: from, pay_to: addMonths(from, 11),
});

export const newShares = (onboard, frequency) => [blankShare('Onboarding', onboard, frequency)];

// Shares saved before payment dates had a payment month inside them: that's their payment date.
export const sharesFromCustomer = (customer) => customer.shares.map((s) => {
  const from = s.payment_month || s.from_month;
  return {
    key: nextKey++, name: s.name, from_month: from, to_month: s.to_month || '',
    direct: pctText(s.direct_pct), support: pctText(s.support_pct), others: pctText(s.others_pct),
    payout_type: s.payout_type || 'once', pay_from: s.pay_from || from, pay_to: s.pay_to || addMonths(s.pay_from || from, 11),
  };
});

// After the frequency changes (only before anything is entered), lay the shares out again back to
// back from the first payment date (names, splits and payment types are kept).
export const relayoutShares = (shares, onboard, frequency) => {
  let from = shares[0]?.from_month || onboard;
  return shares.map((s) => {
    const next = { ...blankShare(s.name, from, frequency, s), key: s.key };
    from = addMonths(next.to_month, 1);
    return next;
  });
};

// A new customer's onboard month moved: move every share by the same number of months.
export const shiftShares = (shares, oldOnboard, newOnboard) => shares.map((s) => moveShare(s, monthsBetween(oldOnboard, newOnboard)));

// An existing customer's onboard month moved: the Onboarding share's payment date can't be before
// it, so it moves up to the onboard month (keeping its length). Other shares keep their months.
export const moveOnboarding = (shares, oldOnboard, newOnboard) => shares.map((s, i) => (
  i === 0 && s.from_month < newOnboard ? moveShare(s, monthsBetween(s.from_month, newOnboard)) : s));

export const sharesForApi = (shares) => shares.map((s) => ({
  name: s.name,
  from_month: s.from_month,
  to_month: s.to_month || null,
  direct_pct: parseNum(s.direct) / 100,
  support_pct: parseNum(s.support) / 100,
  others_pct: parseNum(s.others) / 100,
  payout_type: s.payout_type === 'custom' ? 'custom' : 'once',
  pay_from: s.payout_type === 'custom' ? s.pay_from || null : null,
  pay_to: s.payout_type === 'custom' ? s.pay_to || null : null,
}));

// 'Oct 2026 to Sep 2027', or one month.
export const shareMonths = (share) => {
  const from = share.payment_month || share.from_month;
  return !share.to_month || share.to_month === from ? monthLabel(from) : `${monthLabel(from)} to ${monthLabel(share.to_month)}`;
};

// Months from From to To, counting both.
const monthCount = (from, to) => (!from || !to || to < from ? 0 : monthsBetween(from, to) + 1);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

export default function RevenueShares({ shares, onChange, onboard, frequency }) {
  const monthly = frequency === 'Monthly';
  const span = spanFor(frequency);

  const update = (key, patch) => onChange(shares.map((s) => (s.key === key ? { ...s, ...patch } : s)));
  const remove = (key) => onChange(shares.filter((s) => s.key !== key));
  // A new payment date moves the share's billing To and payout months along with it.
  const changeDate = (s, from) => {
    if (!from) return update(s.key, { from_month: '' });
    if (!s.from_month) return update(s.key, { from_month: from, to_month: addMonths(from, span - 1), pay_from: from, pay_to: addMonths(from, 11) });
    return onChange(shares.map((x) => (x.key === s.key ? moveShare(x, monthsBetween(s.from_month, from)) : x)));
  };
  // Switching to Custom starts the payout on the payment date for 12 months.
  const changeType = (s, type) => update(s.key, { payout_type: type, ...(type === 'custom' ? { pay_from: s.from_month, pay_to: addMonths(s.from_month, 11) } : {}) });

  // A new share starts the month after the latest one ends, with the default length, and copies
  // its split and payment type.
  const add = () => {
    const last = shares.reduce((a, s) => (s.from_month > a.from_month ? s : a), shares[0]);
    onChange([...shares, blankShare('', addMonths(last.to_month || last.from_month, 1), frequency, last)]);
  };

  return (
    <div className="shares">
      {shares.map((s, i) => {
        const first = i === 0;
        const sum = ['direct', 'support', 'others'].reduce((t, k) => t + (parseNum(s[k]) || 0), 0);
        const ok = Math.abs(sum - 100) < 0.0001;
        const months = monthCount(s.from_month, s.to_month);
        const yearly = monthly ? 0 : Math.max(1, Math.floor((months - 1) / 12) + 1);
        const custom = s.payout_type === 'custom';
        const payParts = monthCount(s.pay_from, s.pay_to);
        return (
          <fieldset key={s.key} className="split-inputs share">
            <legend>Revenue share for {first ? 'Onboarding' : s.name.trim() || 'a new share type'}</legend>
            {!first && (
              <div className="row">
                <label className="grow">
                  <span>Share type</span>
                  <input value={s.name} placeholder="For example Renewal" onChange={(e) => update(s.key, { name: e.target.value })} required />
                </label>
              </div>
            )}

            <div className="row share-line">
              <label className="month-field">
                <span>1. Payment date</span>
                <input type="month" value={s.from_month} min={onboard} required onChange={(e) => changeDate(s, e.target.value)} />
              </label>
              <label className="month-field">
                <span>2. Billing from</span>
                <input type="month" value={s.from_month} disabled />
              </label>
              <label className="month-field">
                <span>Billing to</span>
                <input type="month" value={s.to_month} min={s.from_month} required onChange={(e) => update(s.key, { to_month: e.target.value })} />
              </label>
            </div>
            <p className="muted small">
              {months === 0 ? 'Choose the billing To month (on or after the payment date).'
                : monthly ? `${plural(months, 'monthly payment')}, ${monthLabel(s.from_month)} to ${monthLabel(s.to_month)}.`
                  : `${plural(yearly, 'yearly payment')}${yearly > 1 ? ` (Year 1 to Year ${yearly})` : ''}, each in ${monthLabel(s.from_month).slice(0, 3)}, from ${monthLabel(s.from_month)}.`}
              {first && s.from_month && onboard && s.from_month !== onboard && ` Onboarded ${monthLabel(onboard)}; billing starts ${monthLabel(s.from_month)}.`}
            </p>

            <div className="row share-line">
              <label>
                <span>3. Payment type</span>
                <select value={s.payout_type || 'once'} onChange={(e) => changeType(s, e.target.value)}>
                  <option value="once">One time</option>
                  <option value="custom">Custom (split over months)</option>
                </select>
              </label>
              {custom && (
                <>
                  <label className="month-field">
                    <span>Payout from</span>
                    <input type="month" value={s.pay_from} required onChange={(e) => update(s.key, { pay_from: e.target.value })} />
                  </label>
                  <label className="month-field">
                    <span>Payout to</span>
                    <input type="month" value={s.pay_to} min={s.pay_from} required onChange={(e) => update(s.key, { pay_to: e.target.value })} />
                  </label>
                </>
              )}
            </div>
            <p className="muted small">
              {!custom ? 'Each payment\'s employees\' share is paid once, in its payment month.'
                : payParts === 0 ? 'Choose the payout To month (on or after From).'
                  : `Each payment's employees' share is split into ${plural(payParts, 'monthly part')}: ${monthLabel(s.pay_from)} to ${monthLabel(s.pay_to)} for the first payment${(monthly ? months : yearly) > 1 ? ', moving along for each later payment' : ''}.`}
              {' '}Each payment can still be changed on its own page.
            </p>

            <div className="row">
              {[['direct', '4. Direct'], ['support', 'Support'], ['others', 'Others']].map(([k, label]) => (
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
