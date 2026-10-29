import { useEffect, useState } from 'react';
import { api } from '../api.js';

// Small round avatars next to people's names: their profile photo (from My profile) or, without one,
// their initials on a colour picked from their name. Photos are loaded as images (cached by the
// browser); the list of who has one is fetched once per page load and refreshed after a change.
let photos = null; // { byId: Map(id -> v), byEmail: Map(email -> { id, v }) }
let pending = null;
const listeners = new Set();

function loadPhotos() {
  if (!pending) {
    pending = api.photos().then((list) => {
      photos = {
        byId: new Map(list.map((p) => [p.id, p.v])),
        byEmail: new Map(list.filter((p) => p.email).map((p) => [p.email.toLowerCase(), { id: p.id, v: p.v }])),
      };
      listeners.forEach((fn) => fn(photos));
    }).catch(() => { pending = null; });
  }
  return pending;
}
// Call after someone changes their photo, so every avatar on the page updates.
export function refreshPhotos() { pending = null; return loadPhotos(); }

function usePhotos() {
  const [state, setState] = useState(photos);
  useEffect(() => {
    listeners.add(setState);
    if (!photos) loadPhotos();
    return () => { listeners.delete(setState); };
  }, []);
  return state;
}

const COLORS = ['#0b4f6c', '#3a0ca3', '#e0156f', '#1f9d74', '#c26a00', '#5b2a9e', '#0b6e99', '#9a031e'];
const colorFor = (name) => COLORS[[...String(name || '?')].reduce((n, ch) => n + ch.charCodeAt(0), 0) % COLORS.length];
const initials = (name) => String(name || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?';

// Find the person by employee id or by email (Azure DevOps assignees and logins).
export default function Avatar({ id, email, name, size = 22 }) {
  const p = usePhotos();
  const hit = id != null ? (p?.byId.has(id) ? { id, v: p.byId.get(id) } : null) : email ? p?.byEmail.get(String(email).toLowerCase()) : null;
  const style = { width: size, height: size, fontSize: Math.max(9, Math.round(size * 0.42)) };
  if (hit) return <img className="pic" src={`/api/photos/${hit.id}?v=${hit.v}`} alt="" style={style} loading="lazy" />;
  return <span className="pic pic-initials" aria-hidden="true" style={{ ...style, background: colorFor(name) }}>{initials(name)}</span>;
}

// A name with its avatar in front.
export function WithAvatar({ id, email, name, size, children }) {
  return (
    <span className="with-pic">
      <Avatar id={id} email={email} name={name} size={size} />
      <span>{children ?? name}</span>
    </span>
  );
}
