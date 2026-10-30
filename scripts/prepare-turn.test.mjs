import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const source = new URL('../deploy/prepare-turn.mjs', import.meta.url);
const secret = 'fixture_only_turn_secret_0123456789';
const existing = '# existing fixture configuration\n';

async function fixture(t, overrides = {}, { previous = true, cert = 'file', key = 'file' } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'prepare-turn-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'deploy'));
  await mkdir(join(root, 'certs'));
  const generator = join(root, 'deploy/prepare-turn.mjs');
  const output = join(root, 'deploy/.state/turnserver.conf');
  const envPath = join(root, 'fixture.env');
  await copyFile(source, generator);
  for (const [name, kind] of [['fullchain.pem', cert], ['privkey.pem', key]]) {
    const filename = join(root, 'certs', name);
    if (kind === 'file') await writeFile(filename, 'fake certificate fixture; not a real key\n');
    if (kind === 'directory') await mkdir(filename);
  }
  if (previous) {
    await mkdir(join(root, 'deploy/.state'));
    await writeFile(output, existing);
  }
  const env = {
    SYNC_TURN_SECRET: secret,
    SYNC_TURN_EXTERNAL_IP: '203.0.113.10',
    SYNC_TURN_CERT_PATH: 'certs/fullchain.pem',
    SYNC_TURN_KEY_PATH: 'certs/privkey.pem',
    ...overrides,
  };
  await writeFile(envPath, Object.entries(env)
    .filter(([, value]) => value !== undefined)
    .map(([name, value]) => `${name}=${value}`).join('\n') + '\n');

  return {
    output,
    run(args = []) {
      // A copied generator and empty process env isolate every read from real secrets.
      const result = spawnSync(process.execPath, [generator, envPath, ...args], {
        cwd: root,
        env: {},
        encoding: 'utf8',
        timeout: 10_000,
      });
      assert.ifError(result.error);
      assert.equal(result.signal, null);
      assert.ok(!`${result.stdout}${result.stderr}`.includes(secret), 'logs must omit the secret');
      return result;
    },
  };
}

function expectedConfig(tls, extra = []) {
  return [
    'listening-port=3478', 'external-ip=203.0.113.10', 'realm=sync',
    'fingerprint', 'use-auth-secret', `static-auth-secret=${secret}`,
    'min-port=49160', 'max-port=49200', 'cli=0', 'no-multicast-peers',
    'no-tcp-relay', 'dtls=0', 'log-file=stdout', 'simple-log',
    'pidfile=/tmp/turnserver.pid', 'total-quota=20', 'user-quota=4',
    ...(tls ? ['tls-listening-port=5349', 'cert=/certs/fullchain.pem', 'pkey=/certs/privkey.pem'] : ['no-tls']),
    ...extra,
  ].join('\n') + '\n';
}

for (const tls of [false, true]) {
  test(`${tls ? 'TLS' : 'plain'} config uses coturn 4.18 options and preserves security settings`, async (t) => {
    const f = await fixture(t, { SYNC_TURN_ENABLE_TLS: String(tls) });
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'TURN configuration prepared (secret omitted)\n');
    assert.equal(result.stderr, '');
    const config = await readFile(f.output, 'utf8');
    assert.equal(config, expectedConfig(tls));
    assert.doesNotMatch(config, /^(?:no-cli|no-dtls|no-tlsv1|no-tlsv1_1)(?:=|$)/m);
    assert.doesNotMatch(config, /^tlsv1(?:_1)?(?:=|$)/m);
  });

  for (const previous of [false, true]) {
    test(`check-only ${tls ? 'TLS' : 'plain'} config ${previous ? 'preserves existing output' : 'creates no output directory'}`, async (t) => {
      const f = await fixture(t, { SYNC_TURN_ENABLE_TLS: String(tls) }, { previous });
      const result = f.run(['--check']);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, 'TURN settings valid\n');
      assert.equal(result.stderr, '');
      if (previous) assert.equal(await readFile(f.output, 'utf8'), existing);
      else await assert.rejects(readFile(join(f.output, '..')), { code: 'ENOENT' });
    });
  }
}

test('custom NAT, ports, realm and explicit loopback setting are preserved', async (t) => {
  const f = await fixture(t, {
    SYNC_TURN_EXTERNAL_IP: '2001:db8::10',
    SYNC_TURN_REALM: 'turn.example.test',
    SYNC_TURN_PORT: '3479',
    SYNC_TURN_TLS_PORT: '5350',
    SYNC_TURN_MIN_PORT: '50000',
    SYNC_TURN_MAX_PORT: '50010',
    SYNC_TURN_ENABLE_TLS: 'true',
    SYNC_TURN_ALLOW_LOOPBACK: 'true',
  });
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await readFile(f.output, 'utf8'), expectedConfig(true, ['allow-loopback-peers'])
    .replace('listening-port=3478', 'listening-port=3479')
    .replace('external-ip=203.0.113.10', 'external-ip=2001:db8::10')
    .replace('realm=sync', 'realm=turn.example.test')
    .replace('tls-listening-port=5349', 'tls-listening-port=5350')
    .replace('min-port=49160', 'min-port=50000')
    .replace('max-port=49200', 'max-port=50010'));
});

const invalidCases = [
  ['invalid secret', { SYNC_TURN_SECRET: 'too-short' }, {}, /SYNC_TURN_SECRET/],
  ['unset certificate path', { SYNC_TURN_CERT_PATH: undefined }, {}, /SYNC_TURN_CERT_PATH/],
  ['missing certificate file', {}, { cert: 'missing' }, /ENOENT/],
  ['unset key path', { SYNC_TURN_KEY_PATH: undefined }, {}, /SYNC_TURN_KEY_PATH/],
  ['missing key file', {}, { key: 'missing' }, /ENOENT/],
  ['certificate directory', {}, { cert: 'directory' }, /SYNC_TURN_CERT_PATH/],
  ['key directory', {}, { key: 'directory' }, /SYNC_TURN_KEY_PATH/],
  ['invalid NAT address', { SYNC_TURN_EXTERNAL_IP: 'not-an-ip' }, {}, /SYNC_TURN_EXTERNAL_IP/],
  ['invalid relay range', { SYNC_TURN_MAX_PORT: '49159' }, {}, /invalid relay range/],
];

for (const [name, overrides, options, error] of invalidCases) {
  test(`${name} fails closed and preserves the existing config`, async (t) => {
    const f = await fixture(t, { SYNC_TURN_ENABLE_TLS: 'true', ...overrides }, options);
    for (const args of [[], ['--check']]) {
      const result = f.run(args);
      assert.equal(result.status, 1);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, error);
      assert.equal(await readFile(f.output, 'utf8'), existing);
    }
  });
}
