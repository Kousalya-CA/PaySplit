// PaySplit server: Node.js built-ins only.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, dirname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRouter, sendJson, readBody, getCookie, HttpError } from './http.js';
import { userFromToken } from './auth.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerDataRoutes } from './routes/data.js';
import { registerUserRoutes } from './routes/users.js';

const PORT = process.env.PORT || 3000;
const distDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'client', 'dist');

const router = createRouter();
registerAuthRoutes(router);
registerDataRoutes(router);
registerUserRoutes(router);

async function handleApi(req, res, pathname) {
  const found = router.match(req.method, pathname);
  if (!found) throw new HttpError(404, 'Not found.');

  const user = userFromToken(getCookie(req, 'sid'));
  if (found.route.auth && !user) throw new HttpError(401, 'Please log in again.');
  if (found.route.admin && user?.role !== 'admin') throw new HttpError(403, 'Only admins can do this.');

  let status = 200;
  const headers = {};
  const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req) : {};
  const result = await found.route.handler({
    req, body, user, params: found.params,
    setStatus: (s) => { status = s; },
    setHeader: (k, v) => { headers[k] = v; },
  });
  if (result === undefined) sendJson(res, 204, undefined, headers);
  else sendJson(res, status, result, headers);
}

// Production: serve the built React app from client/dist.
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

async function serveStatic(res, pathname) {
  let file = normalize(join(distDir, pathname));
  if (!file.startsWith(distDir)) return sendJson(res, 403, { error: 'Forbidden' });
  try {
    if (!extname(file)) file = join(distDir, 'index.html');
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found. Run "npm run build" to build the React app, or use the Vite dev server on port 5173.');
  }
}

createServer(async (req, res) => {
  const { pathname } = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (pathname.startsWith('/api/')) await handleApi(req, res, pathname);
    else await serveStatic(res, pathname);
  } catch (err) {
    if (err instanceof HttpError) {
      sendJson(res, err.status, { error: err.message, ...(err.fields ? { errors: err.fields } : {}) });
    } else {
      console.error(err);
      sendJson(res, 500, { error: 'Something went wrong on the server.' });
    }
  }
}).listen(PORT, () => console.log(`PaySplit server running at http://localhost:${PORT}`));
