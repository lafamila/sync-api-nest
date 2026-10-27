import { createHash } from 'node:crypto';

export interface SyncConfig {
  nodeEnv: string;
  host: string;
  port: number;
  publicUrl: string;
  allowedOrigins: string[];
  databaseUrl: string;
  databaseSsl: boolean;
  autoMigrate: boolean;
  redisUrl: string;
  redisKeyPrefix: string;
  instanceLeaseTtlSeconds:number;
  authIssuerUrl?: string;
  authJwksUrl?: string;
  authAudience: string;
  authServiceKey: string;
  oidcClientId?: string;
  oidcClientSecret?: string;
  oidcRedirectUri: string;
  sessionEncryptionKey?: Buffer;
  sessionCookieName: string;
  csrfCookieName: string;
  sessionTtlSeconds: number;
  authRecheckSeconds: number;
  authHttpTimeoutMs: number;
  loginTransactionTtlSeconds: number;
  nativeHandoffTtlSeconds: number;
  loginRatePerIp: number;
  loginRateGlobal: number;
  deviceChallengeTtlSeconds: number;
  modeDefaultTtlSeconds: number;
  modeMaxTtlSeconds: number;
  pinFailureLimit: number;
  pinPepper?: string;
  ticketTtlSeconds: number;
  remoteSessionTtlSeconds: number;
  stunUrls: string[];
  turnUrls: string[];
  turnSecret?: string;
  turnUsernamePrefix: string;
  turnTtlSeconds: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): SyncConfig {
  const publicUrl = normalizeHttpUrl(env.SYNC_PUBLIC_URL ?? 'http://localhost:3053', 'SYNC_PUBLIC_URL');
  const databaseUrl = required(env.DATABASE_URL, 'DATABASE_URL');
  const redisUrl = required(env.REDIS_URL, 'REDIS_URL');
  const explicitOrigins = csv(env.SYNC_ALLOWED_ORIGINS).map((value) => normalizeOrigin(value, 'SYNC_ALLOWED_ORIGINS'));
  const sessionEncryptionKey = decodeEncryptionKey(env.SYNC_SESSION_ENCRYPTION_KEY);

  return {
    nodeEnv: env.NODE_ENV ?? 'development',
    host: env.HOST ?? '0.0.0.0',
    port: integer(env.PORT, 3053, 1, 65535),
    publicUrl,
    allowedOrigins: [...new Set([new URL(publicUrl).origin, ...explicitOrigins])],
    databaseUrl,
    databaseSsl: boolean(env.DATABASE_SSL, false),
    autoMigrate: boolean(env.SYNC_AUTO_MIGRATE, true),
    redisUrl,
    redisKeyPrefix: (env.SYNC_REDIS_KEY_PREFIX ?? 'sync').replace(/:+$/, ''),
    instanceLeaseTtlSeconds:integer(env.SYNC_INSTANCE_LEASE_TTL_SECONDS,15,5,60),
    authIssuerUrl: optionalHttpUrl(env.SYNC_AUTH_ISSUER_URL, 'SYNC_AUTH_ISSUER_URL'),
    authJwksUrl: optionalHttpUrl(env.SYNC_AUTH_JWKS_URL, 'SYNC_AUTH_JWKS_URL'),
    authAudience: env.SYNC_AUTH_AUDIENCE ?? 'service:sync',
    authServiceKey: 'sync',
    oidcClientId: optional(env.SYNC_OIDC_CLIENT_ID),
    oidcClientSecret: optional(env.SYNC_OIDC_CLIENT_SECRET),
    oidcRedirectUri: env.SYNC_OIDC_REDIRECT_URI ?? `${publicUrl}/api/session/oidc/callback`,
    sessionEncryptionKey,
    sessionCookieName: 'sync_session',
    csrfCookieName: 'sync_csrf',
    sessionTtlSeconds: integer(env.SYNC_SESSION_TTL_SECONDS, 2_592_000, 300, 31_536_000),
    authRecheckSeconds: integer(env.SYNC_AUTH_RECHECK_SECONDS, 20, 10, 300),
    authHttpTimeoutMs: integer(env.SYNC_AUTH_HTTP_TIMEOUT_MS, 5_000, 500, 30_000),
    loginTransactionTtlSeconds: integer(env.SYNC_LOGIN_TRANSACTION_TTL_SECONDS, 300, 60, 900),
    nativeHandoffTtlSeconds: integer(env.SYNC_NATIVE_HANDOFF_TTL_SECONDS, 60, 15, 120),
    loginRatePerIp: integer(env.SYNC_LOGIN_RATE_PER_IP, 20, 3, 300),
    loginRateGlobal: integer(env.SYNC_LOGIN_RATE_GLOBAL, 120, 10, 3000),
    deviceChallengeTtlSeconds: integer(env.SYNC_DEVICE_CHALLENGE_TTL_SECONDS, 120, 30, 600),
    modeDefaultTtlSeconds: integer(env.SYNC_MODE_DEFAULT_TTL_SECONDS, 43_200, 300, 86_400),
    modeMaxTtlSeconds: integer(env.SYNC_MODE_MAX_TTL_SECONDS, 86_400, 300, 604_800),
    pinFailureLimit: integer(env.SYNC_PIN_FAILURE_LIMIT, 5, 1, 20),
    pinPepper: optional(env.SYNC_PIN_PEPPER),
    ticketTtlSeconds: integer(env.SYNC_TICKET_TTL_SECONDS, 60, 10, 300),
    remoteSessionTtlSeconds: integer(env.SYNC_REMOTE_SESSION_TTL_SECONDS, 3_600, 60, 43_200),
    stunUrls: csv(env.SYNC_STUN_URLS ?? 'stun:stun.l.google.com:19302'),
    turnUrls: csv(env.SYNC_TURN_URLS),
    turnSecret: optional(env.SYNC_TURN_SECRET),
    turnUsernamePrefix: env.SYNC_TURN_USERNAME_PREFIX ?? 'sync',
    turnTtlSeconds: integer(env.SYNC_TURN_TTL_SECONDS, 600, 60, 3_600),
  };
}

function required(value: string | undefined, name: string): string {
  const clean = optional(value);
  if (!clean) throw new Error(`${name} is required`);
  return clean;
}

function optional(value: string | undefined): string | undefined {
  const clean = value?.trim();
  return clean ? clean : undefined;
}

function integer(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`Expected an integer between ${min} and ${max}, received ${value}`);
  }
  return parsed;
}

function boolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`Expected true or false, received ${value}`);
}

function csv(value: string | undefined): string[] {
  return value?.split(',').map((entry) => entry.trim()).filter(Boolean) ?? [];
}

function normalizeHttpUrl(value: string, name: string): string {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`${name} must use http or https`);
  return url.toString().replace(/\/$/, '');
}

function optionalHttpUrl(value: string | undefined, name: string): string | undefined {
  const clean = optional(value);
  return clean ? normalizeHttpUrl(clean, name) : undefined;
}

function normalizeOrigin(value: string, name: string): string {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.pathname !== '/' || url.search || url.hash) {
    throw new Error(`${name} entries must be origins`);
  }
  return url.origin;
}

function decodeEncryptionKey(value: string | undefined): Buffer | undefined {
  const clean = optional(value);
  if (!clean) return undefined;
  const decoded = Buffer.from(clean, 'base64');
  if (decoded.length !== 32 || decoded.toString('base64').replace(/=+$/, '') !== clean.replace(/=+$/, '')) {
    throw new Error('SYNC_SESSION_ENCRYPTION_KEY must be a base64-encoded 32-byte key');
  }
  return decoded;
}

export function configFingerprint(config: SyncConfig): string {
  return createHash('sha256').update(`${config.publicUrl}:${config.authAudience}`).digest('hex').slice(0, 12);
}
