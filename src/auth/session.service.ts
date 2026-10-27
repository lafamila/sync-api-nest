import { BadRequestException, HttpException, HttpStatus, Injectable, UnauthorizedException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Request } from 'express';
import { decrypt, randomOpaque, safeEqual, sha256 } from '../common/crypto';
import { AuthSessionContext, parseCookies } from '../common/request';
import { RevocationBusService } from '../common/revocation-bus.service';
import { SyncConfigService } from '../config/config.service';
import { RedisService } from '../redis/redis.service';
import { AuthService } from './auth.service';
import { OidcCompleteDto, OidcStartDto } from './session.dto';
import { SessionRepository, StoredSession } from './session.repository';

interface LoginTransaction {
  id: string; state: string; oidcVerifier: string; platform: 'web' | 'macos' | 'ios';
  appChallenge?: string; status: 'pending' | 'processing' | 'completed' | 'failed';
  browserBindingHash?: string;
  handoffCodeHash?: string;
  handoffExpiresAt?: number;
  sessionToken?: string; csrfToken?: string; error?: string;
}

export interface CallbackResult {
  platform: 'web' | 'macos' | 'ios';
  transactionId: string;
  sessionToken?: string;
  csrfToken?: string;
  error?: string;
  handoffCode?: string;
}

@Injectable()
export class SessionService {
  private readonly refreshFlights=new Map<string,Promise<void>>();
  constructor(
    private readonly config: SyncConfigService,
    private readonly redis: RedisService,
    private readonly auth: AuthService,
    private readonly repository: SessionRepository,
    private readonly revocations: RevocationBusService,
  ) {}

  async assertStartAllowed(clientAddress: string): Promise<void> {
    const bucket = String(Math.floor(Date.now() / 60_000));
    const allowed = await this.redis.client.eval(
      `local perIp=redis.call('INCR',KEYS[1]); redis.call('EXPIRE',KEYS[1],120);
       if perIp > tonumber(ARGV[1]) then return 0 end;
       local total=redis.call('INCR',KEYS[2]); redis.call('EXPIRE',KEYS[2],120);
       if total > tonumber(ARGV[2]) then return 0 end; return 1`,
      2, this.redis.key('login-rate', bucket, sha256(clientAddress)), this.redis.key('login-rate-global', bucket),
      String(this.config.config.loginRatePerIp), String(this.config.config.loginRateGlobal),
    );
    if (Number(allowed) !== 1) throw new HttpException('Too many login attempts; try again shortly', HttpStatus.TOO_MANY_REQUESTS);
  }

  async start(input: OidcStartDto): Promise<{ authorizeUrl: string; transactionId: string; browserBinding?: { name:string; value:string } }> {
    this.auth.assertConfigured();
    if (input.platform === 'web') {
      if (input.challenge || input.returnUri) throw new BadRequestException('Web login does not accept native handoff values');
    } else if (!input.challenge || input.returnUri !== 'sync://auth') {
      throw new BadRequestException('Native login requires challenge and sync://auth returnUri');
    }
    const browserBinding=input.platform==='web' ? randomOpaque() : undefined;
    const tx: LoginTransaction = {
      id: randomOpaque(), state: randomOpaque(), oidcVerifier: randomOpaque(48), platform: input.platform,
      appChallenge: input.challenge, browserBindingHash:browserBinding?sha256(browserBinding):undefined, status: 'pending',
    };
    const ttl = this.config.config.loginTransactionTtlSeconds;
    await this.redis.client.multi()
      .set(this.txKey(tx.id), JSON.stringify(tx), 'EX', ttl)
      .set(this.stateKey(tx.state), tx.id, 'EX', ttl)
      .exec();
    const authorize = new URL(`${this.config.config.authIssuerUrl}/oauth/authorize`);
    authorize.searchParams.set('client_id', this.config.config.oidcClientId!);
    authorize.searchParams.set('redirect_uri', this.config.config.oidcRedirectUri);
    authorize.searchParams.set('response_type', 'code');
    authorize.searchParams.set('scope', 'openid profile email service.permission');
    authorize.searchParams.set('state', tx.state);
    authorize.searchParams.set('code_challenge', sha256(tx.oidcVerifier));
    authorize.searchParams.set('code_challenge_method', 'S256');
    return { authorizeUrl: authorize.toString(), transactionId: tx.id,
      browserBinding:browserBinding?{name:oidcBindingCookieName(tx.state),value:browserBinding}:undefined };
  }

  async callback(input: { code?: string; state?: string; error?: string; errorDescription?: string; browserBinding?:string }): Promise<CallbackResult> {
    if (!input.state) throw new BadRequestException('OIDC state is required');
    const transactionId = await this.redis.client.get(this.stateKey(input.state));
    if (!transactionId) throw new UnauthorizedException('OIDC transaction is invalid or expired');
    const previewRaw=await this.redis.client.get(this.txKey(transactionId));
    if(!previewRaw) throw new UnauthorizedException('OIDC transaction is invalid or expired');
    const preview=JSON.parse(previewRaw) as LoginTransaction;
    if(preview.state!==input.state || preview.status!=='pending') throw new UnauthorizedException('OIDC transaction was already consumed');
    if(preview.platform==='web' && (!preview.browserBindingHash || !input.browserBinding ||
      !safeEqual(preview.browserBindingHash,sha256(input.browserBinding)))) {
      throw new UnauthorizedException('OIDC browser binding is invalid');
    }
    const raw = await this.redis.client.eval(
      `local raw=redis.call('GET',KEYS[1]); if not raw then return nil end; local obj=cjson.decode(raw);
       if obj.state ~= ARGV[1] or obj.status ~= 'pending' then return nil end; obj.status='processing';
       redis.call('SET',KEYS[1],cjson.encode(obj),'KEEPTTL'); return raw`,
      1, this.txKey(transactionId), input.state,
    ) as string | null;
    if (!raw) throw new UnauthorizedException('OIDC transaction was already consumed');
    const tx = JSON.parse(raw) as LoginTransaction;
    await this.redis.client.del(this.stateKey(input.state));
    if (input.error || !input.code) {
      tx.status = 'failed'; tx.error = input.errorDescription ?? input.error ?? 'Authorization code is missing';
      await this.saveTransaction(tx);
      return { platform: tx.platform, transactionId: tx.id, error: tx.error };
    }
    try {
      const token = await this.auth.exchangeCode(input.code, tx.oidcVerifier);
      if (!token.access_token || !token.refresh_token || !Number.isFinite(token.expires_in)) {
        throw new UnauthorizedException('OIDC token response is incomplete');
      }
      const account = await this.auth.verifyAccessToken(token.access_token);
      const sessionToken = randomOpaque(48);
      const csrfToken = randomOpaque();
      await this.repository.create({
        token: sessionToken, csrfToken, account, platform: tx.platform,
        accessToken: token.access_token, refreshToken: token.refresh_token,
        accessTokenExpiresAt: new Date(Date.now() + token.expires_in! * 1000),
      });
      tx.status = 'completed'; tx.sessionToken = sessionToken; tx.csrfToken = csrfToken;
      if (tx.platform === 'web') {
        await this.redis.client.del(this.txKey(tx.id));
        return { platform: tx.platform, transactionId: tx.id, sessionToken, csrfToken };
      }
      const handoffCode = randomOpaque();
      tx.handoffCodeHash = sha256(handoffCode);
      tx.handoffExpiresAt = Date.now() + this.config.config.nativeHandoffTtlSeconds * 1000;
      await this.saveTransaction(tx);
      return { platform: tx.platform, transactionId: tx.id, handoffCode };
    } catch (error) {
      tx.status = 'failed'; tx.error = error instanceof Error ? error.message : 'Login failed';
      await this.saveTransaction(tx);
      return { platform: tx.platform, transactionId: tx.id, error: tx.error };
    }
  }

  async complete(input: OidcCompleteDto): Promise<{ sessionId: string; account: { id: string; name: string; permission: string } }> {
    if (!input.handoffCode) throw new UnauthorizedException('Native callback code is required');
    const challenge = sha256(input.verifier);
    const raw = await this.redis.client.eval(
      `local raw=redis.call('GET',KEYS[1]); if not raw then return nil end; local obj=cjson.decode(raw);
       if obj.status ~= 'completed' or obj.platform == 'web' or obj.appChallenge ~= ARGV[1]
         or obj.handoffCodeHash ~= ARGV[2] or not obj.handoffExpiresAt or obj.handoffExpiresAt < tonumber(ARGV[3]) then return nil end;
       redis.call('DEL',KEYS[1]); return raw`,
      1, this.txKey(input.transactionId), challenge, sha256(input.handoffCode), String(Date.now()),
    ) as string | null;
    if (!raw) throw new UnauthorizedException('Native login callback authorization is invalid, expired, or already used');
    const tx = JSON.parse(raw) as LoginTransaction;
    const session = await this.requireToken(tx.sessionToken!, 'native');
    return { sessionId: tx.sessionToken!, account: session.account };
  }

  async requireRequest(request: Request): Promise<AuthSessionContext> {
    const native = request.headers['x-sync-session'];
    if (typeof native === 'string' && native.trim()) return this.requireToken(native.trim(), 'native');
    const cookie = parseCookies(request)[this.config.config.sessionCookieName];
    if (!cookie) throw new UnauthorizedException('Sync session is required');
    return this.requireToken(cookie, 'web');
  }

  async logout(session: AuthSessionContext): Promise<void> {
    const stored = await this.repository.findByToken(session.token, session.source);
    if (!stored) return;
    await this.repository.revoke(stored.databaseId);
    this.revocations.emit({ kind: 'auth-session', id: stored.databaseId, reason: 'logout' });
    const key = this.config.config.sessionEncryptionKey;
    if (key) await this.auth.revoke(decrypt(stored.refreshTokenEncrypted, key));
  }

  async revalidateById(databaseId:string):Promise<void> {
    const existing=this.refreshFlights.get(databaseId);
    if(existing) return existing;
    const flight=this.revalidate(databaseId).finally(()=>this.refreshFlights.delete(databaseId));
    this.refreshFlights.set(databaseId,flight);
    return flight;
  }

  private async requireToken(token: string, source: 'web' | 'native'): Promise<StoredSession> {
    let session = await this.repository.findByToken(token, source);
    if (!session) throw new UnauthorizedException('Sync session is invalid or expired');
    if (session.accessTokenExpiresAt.getTime() - Date.now() < 30_000 ||
        Date.now() - session.authCheckedAt.getTime() >= this.config.config.authRecheckSeconds * 1000) {
      await this.revalidateById(session.databaseId);
      session=await this.repository.findByToken(token,source);
      if(!session) throw new UnauthorizedException('Sync session is no longer available');
    }
    await this.repository.touch(session.databaseId);
    return session;
  }

  private async revalidate(databaseId:string): Promise<void> {
    const key = this.config.config.sessionEncryptionKey!;
    try {
      const current=await this.repository.findById(databaseId);
      if(!current) throw new UnauthorizedException('Sync session is no longer available');
      if(Date.now()-current.authCheckedAt.getTime()<this.config.config.authRecheckSeconds*1000 &&
         current.accessTokenExpiresAt.getTime()-Date.now()>=30_000) return;
      await this.repository.refreshLocked(databaseId,this.config.config.authRecheckSeconds*1000,async(session)=>{
        const response=await this.auth.refresh(decrypt(session.refreshTokenEncrypted,key));
        if(!response.access_token || !response.refresh_token || !Number.isFinite(response.expires_in)) throw new Error('Refresh response is incomplete');
        const account=await this.auth.verifyAccessToken(response.access_token);
        if(account.id!==session.account.id) throw new UnauthorizedException('Refreshed token subject changed');
        return { accessToken:response.access_token,refreshToken:response.refresh_token,
          accessTokenExpiresAt:new Date(Date.now()+response.expires_in!*1000),account };
      });
    } catch (error) {
      await this.repository.revoke(databaseId);
      this.revocations.emit({ kind: 'auth-session', id: databaseId, reason: 'auth_refresh_failed' });
      throw error;
    }
  }

  private async saveTransaction(tx: LoginTransaction): Promise<void> {
    const ttl = await this.redis.client.ttl(this.txKey(tx.id));
    if (ttl > 0) await this.redis.client.set(this.txKey(tx.id), JSON.stringify(tx), 'EX', ttl);
  }
  private txKey(id: string): string { return this.redis.key('oidc', 'tx', id); }
  private stateKey(state: string): string { return this.redis.key('oidc', 'state', state); }
}

export function oidcBindingCookieName(state:string):string { return `sync_oidc_${sha256(state).slice(0,32)}`; }
