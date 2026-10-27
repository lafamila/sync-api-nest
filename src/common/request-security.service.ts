import { ForbiddenException, Injectable } from '@nestjs/common';
import { Request } from 'express';
import { safeEqual, sha256 } from './crypto';
import { AuthSessionContext, parseCookies } from './request';
import { SyncConfigService } from '../config/config.service';

@Injectable()
export class RequestSecurityService {
  constructor(private readonly config: SyncConfigService) {}

  assertPublicWebOrigin(request: Request): void {
    const origin = this.origin(request);
    if (!origin && request.headers['sec-fetch-site'] === 'same-origin') return;
    if (!origin || !this.config.config.allowedOrigins.includes(origin)) {
      throw new ForbiddenException('Origin is not allowed');
    }
  }

  assertNativeSession(session: AuthSessionContext): void {
    if (session.source !== 'native') throw new ForbiddenException('Native session is required');
  }

  assertMutation(request: Request, session: AuthSessionContext): void {
    if (session.source === 'native') return;
    this.assertPublicWebOrigin(request);
    const header = request.headers['x-csrf-token'];
    const cookie = parseCookies(request)[this.config.config.csrfCookieName];
    if (typeof header !== 'string' || !cookie || !safeEqual(header, cookie) || !safeEqual(sha256(header), session.csrfHash)) {
      throw new ForbiddenException('Valid CSRF token is required');
    }
  }

  isAllowedOrigin(origin: string | undefined): boolean {
    if (!origin) return false;
    try { return this.config.config.allowedOrigins.includes(new URL(origin).origin); }
    catch { return false; }
  }

  private origin(request: Request): string | undefined {
    const value = request.headers.origin;
    if (typeof value !== 'string') return undefined;
    try { return new URL(value).origin; }
    catch { return undefined; }
  }
}
