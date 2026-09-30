// Small HTTP helpers and a router with :id parameters.

export class HttpError extends Error {
  constructor(status, message, fields) {
    super(message);
    this.status = status;
    this.fields = fields;
  }
}

export const sendJson = (res, status, data, headers = {}) => {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(data === undefined ? '' : JSON.stringify(data));
};

export const readBody = (req) => new Promise((resolve, reject) => {
  let body = '';
  req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
  req.on('end', () => {
    try { resolve(body ? JSON.parse(body) : {}); }
    catch { reject(new HttpError(400, 'Request body is not valid JSON.')); }
  });
  req.on('error', reject);
});

export const getCookie = (req, name) =>
  (req.headers.cookie || '').split(';').map((c) => c.trim().split('='))
    .find(([k]) => k === name)?.[1];

export function createRouter() {
  const routes = [];
  const add = (method) => (pattern, handler, { auth = true, admin = false } = {}) => {
    const keys = [];
    const source = pattern.replace(/:(\w+)/g, (_, key) => { keys.push(key); return '(\\d+)'; });
    routes.push({ method, re: new RegExp(`^${source}$`), keys, handler, auth, admin });
  };
  return {
    get: add('GET'), post: add('POST'), put: add('PUT'), patch: add('PATCH'), delete: add('DELETE'),
    match(method, path) {
      for (const r of routes) {
        if (r.method !== method) continue;
        const m = path.match(r.re);
        if (m) return { route: r, params: Object.fromEntries(r.keys.map((k, i) => [k, Number(m[i + 1])])) };
      }
      return null;
    },
  };
}
