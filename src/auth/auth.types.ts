import { Account } from '../common/request';

export interface VerifiedAccount extends Account {
  subject: string;
  claims: Record<string, unknown>;
}

export interface OidcTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
}
