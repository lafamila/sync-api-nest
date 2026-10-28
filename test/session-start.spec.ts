import { RevocationBusService } from '../src/common/revocation-bus.service';
import { AuthService } from '../src/auth/auth.service';
import { SessionService } from '../src/auth/session.service';
import { SessionRepository } from '../src/auth/session.repository';
import { SyncConfigService } from '../src/config/config.service';
import { SyncConfig } from '../src/config/app-config';
import { RedisService } from '../src/redis/redis.service';
import { testConfig } from './helpers';

function service(overrides: Partial<SyncConfig> = {}) {
  const config = new SyncConfigService(testConfig(overrides));
  const batch = { set: jest.fn().mockReturnThis(), exec: jest.fn().mockResolvedValue([]) };
  const redis = { key: (...parts: string[]) => parts.join(':'), client: { multi: () => batch } } as unknown as RedisService;
  return { config, sessions: new SessionService(config, redis, new AuthService(config), {} as SessionRepository, {} as RevocationBusService) };
}

describe('OIDC browser endpoint configuration', () => {
  it('defaults to the configured issuer', async () => {
    const { sessions } = service();
    const result = await sessions.start({ platform: 'web' });
    expect(new URL(result.authorizeUrl).origin).toBe('http://localhost:3032');
  });

  it('supports an explicit LAN browser endpoint without changing token issuer or PKCE', async () => {
    const { sessions, config } = service({
      oidcAuthorizationUrl: 'http://192.168.0.10:3032/oauth/authorize',
      oidcRedirectUri: 'http://192.168.0.10:3053/api/session/oidc/callback',
    });
    const result = await sessions.start({ platform: 'web' });
    const url = new URL(result.authorizeUrl);
    expect(url.origin).toBe('http://192.168.0.10:3032');
    expect(url.pathname).toBe('/oauth/authorize');
    expect(url.searchParams.get('redirect_uri')).toBe('http://192.168.0.10:3053/api/session/oidc/callback');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(config.config.authIssuerUrl).toBe('http://localhost:3032');
    expect(config.config.authJwksUrl).toBe('http://localhost:3032/oauth/jwks');
    expect(result.browserBinding).toBeDefined();
  });
});
