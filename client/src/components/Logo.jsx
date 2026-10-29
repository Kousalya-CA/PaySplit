// The Growthfactor mark: three rising bars, the tallest in saffron, on peacock blue.
export function LogoMark({ size = 26 }) {
  return (
    <svg className="logo-mark" width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <rect width="32" height="32" rx="8" fill="#0B4F6C" stroke="#FFFFFF" strokeOpacity=".35" />
      <rect x="7" y="18" width="5" height="8" rx="1.5" fill="#FFFFFF" fillOpacity=".7" />
      <rect x="13.5" y="13" width="5" height="13" rx="1.5" fill="#FFFFFF" />
      <rect x="20" y="7" width="5" height="19" rx="1.5" fill="#F7B32B" />
    </svg>
  );
}

export default function Logo({ className = 'logo', href }) {
  const inner = <><LogoMark />Growthfactor</>;
  return href ? <a className={className} href={href}>{inner}</a> : <div className={className}>{inner}</div>;
}
