import { Request } from 'express';

export interface Account {
  id: string;
  name: string;
  permission: 'member' | 'superadmin';
}

export interface AuthSessionContext {
  databaseId: string;
  token: string;
  source: 'web' | 'native';
  csrfHash: string;
  account: Account;
  platform: 'web' | 'macos' | 'ios';
}

export interface AuthenticatedRequest extends Request {
  syncSession: AuthSessionContext;
}

export function parseCookies(request: Pick<Request, 'headers'>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const part of (request.headers.cookie ?? '').split(';')) {
    const separator = part.indexOf('=');
    if (separator < 1) continue;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    try { result[key] = decodeURIComponent(value); }
    catch { result[key] = value; }
  }
  return result;
}
