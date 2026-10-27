import { randomBytes } from 'node:crypto';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const target = new URL('.env', root);
const example = await readFile(new URL('.env.example', root), 'utf8');
let content;
try {
  content = await readFile(target, 'utf8');
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  content = example;
}
const env = parseEnv(content);
if (env.NODE_ENV === 'production') throw new Error('Local setup cannot modify a production environment');
for (const [key, value] of Object.entries(parseEnv(example))) {
  if (!(key in env)) content = `${content.trimEnd()}\n${key}=${value}\n`;
}
for (const [key, encoding] of [
  ['SYNC_SESSION_ENCRYPTION_KEY', 'base64'],
  ['SYNC_PIN_PEPPER', 'hex'],
  ['SYNC_TURN_SECRET', 'hex'],
]) {
  if (env[key]) continue;
  const value = randomBytes(32).toString(encoding);
  const line = new RegExp(`^${key}=.*$`, 'm');
  content = line.test(content) ? content.replace(line, `${key}=${value}`) : `${content.trimEnd()}\n${key}=${value}\n`;
}
await writeFile(target, content, { mode: 0o600 });
await chmod(target, 0o600);
console.log(`Local configuration ready: ${fileURLToPath(target)} (secrets omitted)`);
console.log(parseEnv(content).SYNC_OIDC_CLIENT_SECRET
  ? 'Central auth client credentials are present (value omitted).'
  : 'Complete SYNC_OIDC_CLIENT_SECRET after approving docs/onboarding/sync-service-onboarding-create.json in Teddy Auth.');
