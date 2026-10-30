import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { dirname, resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const envPath = resolve(root, process.argv[2] ?? '.env');
const output = resolve(root, 'deploy/.state/turnserver.conf');

try {
  const env = { ...parseEnv(await readFile(envPath, 'utf8')), ...process.env };
  const secret = env.SYNC_TURN_SECRET ?? '';
  if (!/^[A-Za-z0-9_-]{32,}$/.test(secret)) throw new Error('SYNC_TURN_SECRET: 32+ random characters required');
  const address = env.SYNC_TURN_EXTERNAL_IP ?? '';
  if (!isIP(address)) throw new Error('SYNC_TURN_EXTERNAL_IP: reachable IPv4/IPv6 address required');
  const realm = env.SYNC_TURN_REALM ?? 'sync';
  if (!/^[A-Za-z0-9.-]{1,253}$/.test(realm)) throw new Error('SYNC_TURN_REALM: invalid realm');
  const port = (key, fallback) => {
    const value = Number(env[key] ?? fallback);
    if (!Number.isInteger(value) || value < 1024 || value > 65535) throw new Error(`${key}: invalid unprivileged port`);
    return value;
  };
  const listenPort = port('SYNC_TURN_PORT', 3478);
  const tlsPort = port('SYNC_TURN_TLS_PORT', 5349);
  const minPort = port('SYNC_TURN_MIN_PORT', 49160);
  const maxPort = port('SYNC_TURN_MAX_PORT', 49200);
  if (maxPort < minPort || maxPort - minPort > 1000 || (listenPort >= minPort && listenPort <= maxPort)) {
    throw new Error('SYNC_TURN_MIN_PORT/SYNC_TURN_MAX_PORT: invalid relay range');
  }
  const lines = [
    `listening-port=${listenPort}`, `external-ip=${address}`, `realm=${realm}`,
    'fingerprint', 'use-auth-secret', `static-auth-secret=${secret}`,
    `min-port=${minPort}`, `max-port=${maxPort}`, 'cli=0', 'no-multicast-peers',
    'no-tcp-relay', 'dtls=0', 'log-file=stdout', 'simple-log',
    'pidfile=/tmp/turnserver.pid', 'total-quota=20', 'user-quota=4',
  ];
  if (env.SYNC_TURN_ENABLE_TLS === 'true') {
    for (const key of ['SYNC_TURN_CERT_PATH', 'SYNC_TURN_KEY_PATH']) {
      const filename = env[key];
      if (!filename || !(await stat(resolve(root, filename))).isFile()) throw new Error(`${key}: certificate/key file required`);
    }
    lines.push(`tls-listening-port=${tlsPort}`, 'cert=/certs/fullchain.pem', 'pkey=/certs/privkey.pem');
  } else {
    if (env.SYNC_TURN_ENABLE_TLS && env.SYNC_TURN_ENABLE_TLS !== 'false') throw new Error('SYNC_TURN_ENABLE_TLS: true/false required');
    lines.push('no-tls');
  }
  if (env.SYNC_TURN_ALLOW_LOOPBACK === 'true') lines.push('allow-loopback-peers');
  if (!process.argv.includes('--check')) {
    await mkdir(dirname(output), { recursive: true, mode: 0o700 });
    await writeFile(output, `${lines.join('\n')}\n`, { mode: 0o600 });
  }
  console.log(process.argv.includes('--check') ? 'TURN settings valid' : 'TURN configuration prepared (secret omitted)');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
