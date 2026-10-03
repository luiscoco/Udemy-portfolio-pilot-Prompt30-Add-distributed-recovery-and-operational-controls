// Local single-origin reverse proxy for multi-replica testing (milestone 30). `/api` is balanced
// round-robin across ready API replicas; every other path serves the React build with SPA fallback.
// It mirrors the production gateway contract closely enough to exercise replica loss:
//  - active readiness checks remove draining/stopped replicas; if none are ready, all are tried so
//    the client still receives the API's own honest error instead of a proxy guess;
//  - a request is retried on another replica ONLY when it provably was not processed: the TCP
//    connection was refused, or a draining replica answered with the explicit not-processed header.
//    A reset after the request was sent is never retried, because the replica may have acted on it;
//  - responses (including SSE) stream without buffering, and a client disconnect aborts upstream.
// This is a development/test tool, not a production gateway.
import { createServer, request as httpRequest } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const NOT_PROCESSED = 'x-portfolio-pilot-not-processed';
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host']);
const MAX_BODY = 1024 * 1024;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };

export function createLocalProxy({ upstreams, staticDir = null, healthPath = '/api/health/ready', healthIntervalMs = 500, log = () => {} }) {
  if (!upstreams.length) throw new Error('At least one upstream is required.');
  const state = upstreams.map(url => ({ url: new URL(url), ready: false }));
  const stats = { routed: new Map(upstreams.map(u => [u, 0])), retries: 0 };
  let next = 0;
  async function probe(target) {
    const ready = await new Promise(resolve => {
      const req = httpRequest(new URL(healthPath, target.url), { method: 'GET', timeout: 2000 }, res => { res.resume(); resolve(res.statusCode === 200); });
      req.on('timeout', () => req.destroy()); req.on('error', () => resolve(false)); req.end();
    });
    if (ready !== target.ready) log({ event: 'proxy.upstream', upstream: target.url.origin, ready });
    target.ready = ready;
  }
  const probes = () => Promise.all(state.map(probe));
  const timer = setInterval(() => void probes(), healthIntervalMs);
  timer.unref();
  /** Ready replicas in round-robin order; all replicas when none is ready. */
  function candidates() {
    const ready = state.filter(s => s.ready), pool = ready.length ? ready : state;
    const start = next++ % pool.length;
    return [...pool.slice(start), ...pool.slice(0, start)];
  }
  function forward(target, req, res, body) {
    return new Promise(resolve => {
      const headers = Object.fromEntries(Object.entries(req.headers).filter(([key]) => !HOP_BY_HOP.has(key)));
      headers['x-forwarded-for'] = req.socket.remoteAddress ?? '';
      headers['x-forwarded-host'] = req.headers.host ?? '';
      headers['x-forwarded-proto'] = 'http';
      if (body.length) headers['content-length'] = String(body.length);
      const upstream = httpRequest({ protocol: target.url.protocol, hostname: target.url.hostname, port: target.url.port, method: req.method, path: req.url, headers });
      let sent = false;
      upstream.on('response', upstreamResponse => {
        if (upstreamResponse.headers[NOT_PROCESSED] === 'draining') { upstreamResponse.resume(); target.ready = false; resolve('retry'); return; }
        sent = true;
        const outgoing = Object.fromEntries(Object.entries(upstreamResponse.headers).filter(([key]) => !HOP_BY_HOP.has(key)));
        res.writeHead(upstreamResponse.statusCode ?? 502, outgoing);
        res.flushHeaders();
        upstreamResponse.pipe(res);
        upstreamResponse.on('error', () => res.destroy());
        upstreamResponse.on('end', () => resolve('done'));
        res.on('close', () => { upstreamResponse.destroy(); resolve('done'); });
      });
      upstream.on('error', error => {
        if (!sent && error.code === 'ECONNREFUSED') { target.ready = false; resolve('retry'); return; }
        // The replica may already have acted on this request: report it, never replay it.
        if (!sent && !res.headersSent) {
          res.writeHead(502, { 'content-type': 'application/json', 'cache-control': 'no-store' });
          res.end(JSON.stringify({ error: { code: 'SERVICE_UNAVAILABLE', message: 'The server connection was lost. Refresh to check whether your last change was saved before retrying.', requestId: crypto.randomUUID() } }));
        } else res.destroy();
        resolve('done');
      });
      // The client side of `res` closing (browser left, EventSource closed) aborts the upstream.
      res.on('close', () => { if (!res.writableFinished) upstream.destroy(); });
      upstream.end(body);
    });
  }
  async function readBody(req) {
    const chunks = []; let size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > MAX_BODY) throw new Error('BODY_TOO_LARGE'); chunks.push(chunk); }
    return Buffer.concat(chunks);
  }
  async function serveStatic(req, res) {
    if (!staticDir) { res.writeHead(404); res.end(); return; }
    const root = resolve(staticDir);
    const path = decodeURIComponent(new URL(req.url, 'http://local').pathname);
    let file = normalize(join(root, path));
    if (file !== root && !file.startsWith(root + sep)) { res.writeHead(400); res.end(); return; }
    let info = await stat(file).catch(() => null);
    if (!info?.isFile()) { file = join(root, 'index.html'); info = await stat(file).catch(() => null); }
    if (!info) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': file.endsWith('index.html') ? 'no-cache' : 'public, max-age=3600' });
    createReadStream(file).pipe(res);
  }
  const server = createServer(async (req, res) => {
    try {
      if (!req.url?.startsWith('/api/') && req.url !== '/api') return await serveStatic(req, res);
      const body = await readBody(req);
      for (const target of candidates()) {
        if (res.destroyed) return;
        const outcome = await forward(target, req, res, body);
        if (outcome === 'done') { stats.routed.set(target.url.origin, (stats.routed.get(target.url.origin) ?? 0) + 1); return; }
        stats.retries++;
      }
      res.writeHead(503, { 'content-type': 'application/json', 'cache-control': 'no-store', 'retry-after': '1' });
      res.end(JSON.stringify({ error: { code: 'SERVICE_UNAVAILABLE', message: 'No API server is available. Your request was not processed; try again shortly.', requestId: crypto.randomUUID() } }));
    } catch (error) {
      if (res.headersSent) { res.destroy(); return; }
      res.writeHead(error?.message === 'BODY_TOO_LARGE' ? 413 : 400); res.end();
    }
  });
  server.on('close', () => clearInterval(timer));
  return { server, probes, state, stats };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2), upstreams = [];
  let port = 5310, staticDir = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--upstream') upstreams.push(args[++i]);
    else if (args[i] === '--port') port = Number(args[++i]);
    else if (args[i] === '--static') staticDir = args[++i];
    else throw new Error(`Unknown argument ${args[i]}`);
  }
  const proxy = createLocalProxy({ upstreams, staticDir, log: entry => console.log(JSON.stringify(entry)) });
  await proxy.probes();
  proxy.server.listen(port, '127.0.0.1', () => console.log(JSON.stringify({ event: 'proxy.listening', port, upstreams })));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => proxy.server.close(() => process.exit(0)));
}
