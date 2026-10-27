import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Account, AuthSessionContext } from '../common/request';
import { encrypt, sha256 } from '../common/crypto';
import { SyncConfigService } from '../config/config.service';
import { DatabaseService } from '../database/database.service';

interface SessionRow {
  id: string; token_hash: string; csrf_hash: string; account_id: string; account_name: string;
  permission: 'member' | 'superadmin'; platform: 'web' | 'macos' | 'ios';
  access_token_encrypted: string; refresh_token_encrypted: string; access_token_expires_at: Date;
  created_at: Date; last_seen_at: Date; expires_at: Date; revoked_at: Date | null;
  auth_checked_at: Date;
}

export interface StoredSession extends AuthSessionContext {
  accessTokenEncrypted: string;
  refreshTokenEncrypted: string;
  accessTokenExpiresAt: Date;
  expiresAt: Date;
  authCheckedAt: Date;
}

export interface RefreshedTokens { accessToken:string; refreshToken:string; accessTokenExpiresAt:Date; account:Account }

@Injectable()
export class SessionRepository {
  constructor(private readonly db: DatabaseService, private readonly config: SyncConfigService) {}

  async create(input: {
    token: string; csrfToken: string; account: Account; platform: 'web' | 'macos' | 'ios';
    accessToken: string; refreshToken: string; accessTokenExpiresAt: Date;
  }): Promise<string> {
    const id = randomUUID();
    const key = this.config.config.sessionEncryptionKey!;
    await this.db.query(
      `insert into sync_auth_sessions
       (id, token_hash, csrf_hash, account_id, account_name, permission, platform,
        access_token_encrypted, refresh_token_encrypted, access_token_expires_at, expires_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now() + ($11 * interval '1 second'))`,
      [id, sha256(input.token), sha256(input.csrfToken), input.account.id, input.account.name, input.account.permission,
       input.platform, encrypt(input.accessToken, key), encrypt(input.refreshToken, key), input.accessTokenExpiresAt,
       this.config.config.sessionTtlSeconds],
    );
    return id;
  }

  async findByToken(token: string, source: 'web' | 'native'): Promise<StoredSession | undefined> {
    const result = await this.db.query<SessionRow>(
      `select * from sync_auth_sessions
       where token_hash=$1 and revoked_at is null and expires_at > now()
       and (($2='web' and platform='web') or ($2='native' and platform in ('macos','ios')))`, [sha256(token), source],
    );
    const row = result.rows[0];
    return row ? mapSession(row, token, source) : undefined;
  }

  async findById(id:string):Promise<StoredSession|undefined> {
    const result=await this.db.query<SessionRow>(
      `select * from sync_auth_sessions where id=$1 and revoked_at is null and expires_at > now()`,[id]);
    return result.rows[0] ? mapSession(result.rows[0],'','native') : undefined;
  }

  async touch(id: string): Promise<void> {
    await this.db.query('update sync_auth_sessions set last_seen_at=now() where id=$1 and revoked_at is null', [id]);
  }

  async updateTokens(id: string, accessToken: string, refreshToken: string, accessTokenExpiresAt: Date, account: Account): Promise<void> {
    const key = this.config.config.sessionEncryptionKey!;
    await this.db.query(
      `update sync_auth_sessions set access_token_encrypted=$2, refresh_token_encrypted=$3,
       access_token_expires_at=$4, account_name=$5, permission=$6, last_seen_at=now(), auth_checked_at=now()
       where id=$1 and revoked_at is null`,
      [id, encrypt(accessToken, key), encrypt(refreshToken, key), accessTokenExpiresAt, account.name, account.permission],
    );
  }

  async refreshLocked(id:string,freshnessMs:number,refresh:(session:StoredSession)=>Promise<RefreshedTokens>):Promise<StoredSession> {
    return this.db.transaction(async(query)=>{
      const selected=await query<SessionRow>(
        `select * from sync_auth_sessions where id=$1 and revoked_at is null and expires_at > now() for update`,[id]);
      const row=selected.rows[0];
      if(!row) throw new Error('Sync session is no longer available');
      let session=mapSession(row,'','native');
      const fresh=Date.now()-session.authCheckedAt.getTime()<freshnessMs && session.accessTokenExpiresAt.getTime()-Date.now()>=30_000;
      if(fresh) return session;
      const next=await refresh(session);
      const key=this.config.config.sessionEncryptionKey!;
      const updated=await query<SessionRow>(
        `update sync_auth_sessions set access_token_encrypted=$2,refresh_token_encrypted=$3,
         access_token_expires_at=$4,account_name=$5,permission=$6,last_seen_at=now(),auth_checked_at=now()
         where id=$1 and revoked_at is null returning *`,
        [id,encrypt(next.accessToken,key),encrypt(next.refreshToken,key),next.accessTokenExpiresAt,next.account.name,next.account.permission]);
      session=mapSession(updated.rows[0]!,'','native');
      return session;
    });
  }

  async revoke(id: string): Promise<void> {
    await this.db.query('update sync_auth_sessions set revoked_at=coalesce(revoked_at, now()) where id=$1', [id]);
  }
}

function mapSession(row: SessionRow, token: string, source: 'web' | 'native'): StoredSession {
  return {
    databaseId: row.id,
    token,
    source,
    csrfHash: row.csrf_hash,
    account: { id: row.account_id, name: row.account_name, permission: row.permission },
    platform: row.platform,
    accessTokenEncrypted: row.access_token_encrypted,
    refreshTokenEncrypted: row.refresh_token_encrypted,
    accessTokenExpiresAt: row.access_token_expires_at,
    expiresAt: row.expires_at,
    authCheckedAt: row.auth_checked_at,
  };
}
