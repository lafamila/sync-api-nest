import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const directory = new URL('deploy/.state/', root);
const target = new URL('nas.env', directory);
await mkdir(directory, { recursive: true, mode: 0o700 });

try {
  await readFile(target);
  console.log(`Existing NAS configuration preserved: ${fileURLToPath(target)} (values omitted)`);
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  const env = parseEnv(await readFile(new URL('.env.example', root), 'utf8'));
  Object.assign(env, {
    NODE_ENV: 'production', HOST: '0.0.0.0', PORT: '3053',
    SYNC_PUBLIC_URL: 'https://sync.lafamila.xyz',
    SYNC_ALLOWED_ORIGINS: 'https://sync.lafamila.xyz',
    DATABASE_URL: `postgresql://sync:${randomBytes(32).toString('hex')}@teddy-postgres:5432/sync`,
    REDIS_URL: 'redis://teddy-redis:6379',
    SYNC_REDIS_KEY_PREFIX: 'sync:prod',
    SYNC_AUTH_ISSUER_URL: 'https://auth.lafamila.xyz',
    SYNC_AUTH_JWKS_URL: 'https://auth.lafamila.xyz/oauth/jwks',
    SYNC_AUTH_AUDIENCE: 'service:sync',
    SYNC_OIDC_CLIENT_ID: 'sync-api',
    SYNC_OIDC_CLIENT_SECRET: '',
    SYNC_OIDC_REDIRECT_URI: 'https://sync.lafamila.xyz/api/session/oidc/callback',
    SYNC_SESSION_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    SYNC_PIN_PEPPER: randomBytes(32).toString('hex'),
    SYNC_TURN_SECRET: randomBytes(32).toString('hex'),
    SYNC_STUN_URLS: 'stun:sync.lafamila.xyz:3478',
    SYNC_TURN_URLS: 'turn:sync.lafamila.xyz:3478?transport=udp,turn:sync.lafamila.xyz:3478?transport=tcp',
    SYNC_TURN_EXTERNAL_IP: '',
    SYNC_TURN_BIND_ADDRESS: '0.0.0.0',
    SYNC_TURN_ALLOW_LOOPBACK: 'false',
    SYNC_TURN_ENABLE_TLS: 'false',
  });
  const body = Object.entries(env).map(([key, value]) => `${key}=${value}`).join('\n');
  await writeFile(target, `# Private deployment staging. Upload as NAS sync-api-nest/.env after verification.\n# DB/Redis hosts, TURN address and HTTPS route must be verified on the NAS.\n${body}\n`, { mode: 0o600 });
  await chmod(target, 0o600);
  console.log(`NAS configuration prepared: ${fileURLToPath(target)} (secrets omitted)`);
}
console.log('Public auth approval secret belongs only in deploy/.state/nas.env, not the development .env.');
