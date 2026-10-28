import http from 'node:http';
import { isIP } from 'node:net';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function createAuthLanProxy(upstreamUrl, authority) {
  const upstream = new URL(upstreamUrl);
  if (upstream.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(upstream.hostname)) {
    throw new Error('The development auth upstream must be loopback HTTP');
  }
  return http.createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://proxy.invalid');
    const publicPath = path.pathname.startsWith('/oauth/') || path.pathname.startsWith('/oidc/') || path.pathname === '/.well-known/openid-configuration' || path.pathname === '/health';
    if (request.headers.host !== authority || !publicPath) {
      response.writeHead(404).end();
      return;
    }
    const headers = { ...request.headers, host: upstream.host };
    for (const key of ['connection', 'proxy-connection', 'proxy-authorization', 'transfer-encoding', 'upgrade', 'x-forwarded-host', 'x-forwarded-proto', 'x-forwarded-for']) delete headers[key];
    const outgoing = http.request(new URL(path.pathname + path.search, upstream), {
      method: request.method,
      headers,
      timeout: 15_000,
    }, (incoming) => {
      response.writeHead(incoming.statusCode ?? 502, incoming.headers);
      incoming.on('error', () => response.destroy());
      incoming.pipe(response);
    });
    outgoing.on('timeout', () => outgoing.destroy());
    outgoing.on('error', () => {
      if (response.headersSent) response.destroy();
      else response.writeHead(502, { 'content-type': 'text/plain' }).end('Local auth is unavailable');
    });
    request.on('aborted', () => outgoing.destroy());
    request.pipe(outgoing);
  });
}

function start() {
  if (process.env.NODE_ENV === 'production') throw new Error('This proxy is for local development only');
  const endpoint = new URL(process.env.SYNC_OIDC_AUTHORIZATION_URL ?? '');
  const [first, second] = endpoint.hostname.split('.').map(Number);
  const privateAddress = first === 10 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168);
  if (endpoint.protocol !== 'http:' || isIP(endpoint.hostname) !== 4 || !privateAddress) {
    throw new Error('SYNC_OIDC_AUTHORIZATION_URL must use an explicit private LAN IPv4 address');
  }
  const server = createAuthLanProxy(process.env.SYNC_AUTH_ISSUER_URL, endpoint.host);
  server.on('error', (error) => { console.error(`LAN auth proxy failed: ${error.code}`); process.exitCode = 1; });
  server.listen(Number(endpoint.port || 80), endpoint.hostname, () => {
    console.log(`Local auth public endpoints: ${endpoint.origin} (admin routes are not exposed)`);
  });
  const stop = () => { server.close(); server.closeAllConnections(); };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { start(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
