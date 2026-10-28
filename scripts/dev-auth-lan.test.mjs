import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { createAuthLanProxy } from './dev-auth-lan.mjs';

const authority = '192.168.0.10:3032';

async function fixture(t) {
  let forwarded = 0;
  const upstream = http.createServer((request, response) => {
    forwarded += 1;
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      response.writeHead(200, { 'set-cookie': 'test_binding=test; HttpOnly; SameSite=Strict' });
      response.end(JSON.stringify({ method: request.method, path: request.url, body }));
    });
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const proxy = createAuthLanProxy(`http://127.0.0.1:${upstream.address().port}`, authority);
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  t.after(async () => {
    for (const server of [proxy, upstream]) {
      const closed = once(server, 'close');
      server.close(); server.closeAllConnections();
      await closed;
    }
  });
  return { url: `http://127.0.0.1:${proxy.address().port}`, forwarded: () => forwarded };
}

function request(url, { host = authority, method = 'GET', body } = {}) {
  return new Promise((resolve, reject) => {
    const outgoing = http.request(url, { method, headers: { host } }, (incoming) => {
      let data = '';
      incoming.on('data', (chunk) => { data += chunk; });
      incoming.on('end', () => resolve({ status: incoming.statusCode, body: data, cookies: incoming.headers['set-cookie'] }));
    });
    outgoing.on('error', reject);
    outgoing.end(body);
  });
}

test('forwards hosted OAuth requests and binding cookies without changing their payload', async (t) => {
  const f = await fixture(t);
  const result = await request(`${f.url}/oauth/login`, { method: 'POST', body: 'login_transaction=test-only' });
  assert.equal(result.status, 200);
  assert.deepEqual(JSON.parse(result.body), { method: 'POST', path: '/oauth/login', body: 'login_transaction=test-only' });
  assert.match(result.cookies[0], /HttpOnly/);
});

test('does not expose admin or service management routes on the LAN proxy', async (t) => {
  const f = await fixture(t);
  for (const path of ['/admin', '/service', '/api/admin/accounts']) {
    assert.equal((await request(f.url + path)).status, 404);
  }
  assert.equal(f.forwarded(), 0);
});

test('rejects requests addressed to an unconfigured host', async (t) => {
  const f = await fixture(t);
  assert.equal((await request(f.url + '/oauth/authorize', { host: 'untrusted.invalid' })).status, 404);
  assert.equal(f.forwarded(), 0);
});

test('rejects a non-loopback development auth upstream', () => {
  assert.throws(() => createAuthLanProxy('http://192.168.0.20:3032', authority));
});
