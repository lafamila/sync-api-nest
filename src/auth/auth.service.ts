import { Injectable, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { createRemoteJWKSet, jwtVerify, JWTPayload, JWTVerifyGetKey } from 'jose';
import { SyncConfigService } from '../config/config.service';
import { OidcTokenResponse, VerifiedAccount } from './auth.types';

@Injectable()
export class AuthService {
  private jwks?: JWTVerifyGetKey;
  private discoveredJwksUrl?: string;

  constructor(private readonly config: SyncConfigService) {}

  assertConfigured(): void {
    if (!this.config.authConfigured) throw new ServiceUnavailableException('Central authentication is not configured');
  }

  async verifyAccessToken(token: string): Promise<VerifiedAccount> {
    this.assertConfigured();
    const issuer = this.config.config.authIssuerUrl!;
    const result = await jwtVerify(token, await this.getJwks(), {
      issuer,
      audience: this.config.config.authAudience,
    });
    return this.validatePayload(result.payload);
  }

  validatePayload(payload: JWTPayload): VerifiedAccount {
    const subject = typeof payload.sub === 'string' && payload.sub ? payload.sub : undefined;
    if (!subject) throw new UnauthorizedException('Token subject is missing');
    const permission = this.extractPermission(payload);
    if (permission !== 'member' && permission !== 'superadmin') {
      throw new UnauthorizedException('Sync member or superadmin permission is required');
    }
    const claims = payload as Record<string, unknown>;
    const name = [claims.name, claims.preferred_username, claims.email, subject]
      .find((value): value is string => typeof value === 'string' && value.trim().length > 0)!;
    return { id: subject, subject, name, permission, claims };
  }

  async exchangeCode(code: string, verifier: string): Promise<OidcTokenResponse> {
    return this.requestToken({
      grant_type: 'authorization_code',
      client_id: this.config.config.oidcClientId!,
      client_secret: this.config.config.oidcClientSecret!,
      redirect_uri: this.config.config.oidcRedirectUri,
      code,
      code_verifier: verifier,
    });
  }

  async refresh(refreshToken: string): Promise<OidcTokenResponse> {
    return this.requestToken({
      grant_type: 'refresh_token',
      client_id: this.config.config.oidcClientId!,
      client_secret: this.config.config.oidcClientSecret!,
      refresh_token: refreshToken,
    });
  }

  async revoke(refreshToken: string): Promise<void> {
    if (!this.config.config.authIssuerUrl) return;
    await fetch(`${this.config.config.authIssuerUrl}/oauth/revoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: refreshToken }),
      signal: AbortSignal.timeout(this.config.config.authHttpTimeoutMs),
    }).catch(() => undefined);
  }

  private extractPermission(payload: JWTPayload): string | undefined {
    const claims = payload as Record<string, unknown>;
    const serviceKey = this.config.config.authServiceKey;
    const direct = permissionFromCandidate(claims[serviceKey]);
    if (direct) return direct;
    const services = claims.services;
    if (services && typeof services === 'object' && !Array.isArray(services)) {
      const nested = permissionFromCandidate((services as Record<string, unknown>)[serviceKey]);
      if (nested) return nested;
    }
    const entries = claims.servicePermissions ?? claims.service_permissions ?? claims.permissions;
    if (Array.isArray(entries)) {
      for (const entry of entries) {
        if (typeof entry === 'string') {
          const [service, permission] = entry.split(':');
          if (service === serviceKey && permission) return permission;
        } else if (entry && typeof entry === 'object') {
          const record = entry as Record<string, unknown>;
          const service = record.serviceKey ?? record.service_key ?? record.service ?? record.key;
          if (service === serviceKey) {
            const permission = permissionFromCandidate(record);
            if (permission) return permission;
          }
        }
      }
    }
    const namespaced = claims['https://lafamila.xyz/claims/service'];
    if (namespaced && typeof namespaced === 'object' && !Array.isArray(namespaced)) {
      const record = namespaced as Record<string, unknown>;
      if ((record.key ?? record.serviceKey ?? record.service_key) === serviceKey) return permissionFromCandidate(record);
    }
    return undefined;
  }

  private async requestToken(values: Record<string, string>): Promise<OidcTokenResponse> {
    this.assertConfigured();
    const response = await fetch(`${this.config.config.authIssuerUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams(values),
      signal: AbortSignal.timeout(this.config.config.authHttpTimeoutMs),
    });
    if (!response.ok) {
      const body = await response.text();
      throw new UnauthorizedException(body.slice(0, 300) || 'OIDC token request failed');
    }
    return response.json() as Promise<OidcTokenResponse>;
  }

  private async getJwks(): Promise<JWTVerifyGetKey> {
    if (this.jwks) return this.jwks;
    const url = this.config.config.authJwksUrl ?? await this.discoverJwksUrl();
    this.jwks = createRemoteJWKSet(new URL(url));
    return this.jwks;
  }

  private async discoverJwksUrl(): Promise<string> {
    if (this.discoveredJwksUrl) return this.discoveredJwksUrl;
    const response = await fetch(`${this.config.config.authIssuerUrl}/.well-known/openid-configuration`,{
      signal:AbortSignal.timeout(this.config.config.authHttpTimeoutMs),
    });
    if (!response.ok) throw new ServiceUnavailableException('Unable to load auth discovery metadata');
    const metadata = await response.json() as Record<string, unknown>;
    if (typeof metadata.jwks_uri !== 'string') throw new ServiceUnavailableException('Auth discovery is missing jwks_uri');
    this.discoveredJwksUrl = metadata.jwks_uri;
    return metadata.jwks_uri;
  }
}

function permissionFromCandidate(candidate: unknown): string | undefined {
  if (typeof candidate === 'string') return candidate;
  if (Array.isArray(candidate)) return candidate.find((value): value is string => typeof value === 'string');
  if (candidate && typeof candidate === 'object') {
    const record = candidate as Record<string, unknown>;
    for (const key of ['permission', 'role', 'access']) {
      if (typeof record[key] === 'string') return record[key] as string;
    }
    if (Array.isArray(record.permissions)) return record.permissions.find((value): value is string => typeof value === 'string');
  }
  return undefined;
}
