import { loadConfig, SyncConfig } from '../src/config/app-config';

export function testConfig(overrides: Partial<SyncConfig> = {}): SyncConfig {
  return {
    ...loadConfig({
      NODE_ENV:'test', DATABASE_URL:'postgresql://test:test@127.0.0.1:5432/test', REDIS_URL:'redis://127.0.0.1:6379',
      SYNC_PUBLIC_URL:'http://localhost:3053', SYNC_REDIS_KEY_PREFIX:'sync:test:unit',
      SYNC_AUTH_ISSUER_URL:'http://localhost:3032', SYNC_AUTH_JWKS_URL:'http://localhost:3032/oauth/jwks',
      SYNC_OIDC_CLIENT_ID:'sync-api', SYNC_OIDC_CLIENT_SECRET:'test-client-secret',
      SYNC_SESSION_ENCRYPTION_KEY:Buffer.alloc(32,7).toString('base64'), SYNC_PIN_PEPPER:'test-pin-pepper',
    }),
    ...overrides,
  };
}
