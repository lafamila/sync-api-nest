import { BadRequestException, ForbiddenException, HttpException, HttpStatus, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { randomInt, randomUUID } from 'node:crypto';
import { hmac256, sha256 } from '../common/crypto';
import { Account } from '../common/request';
import { SyncConfigService } from '../config/config.service';
import { RedisService } from '../redis/redis.service';
import { RemoteSessionService } from '../sessions/remote-session.service';
import { Device } from './device.repository';

export interface AccessMode { epoch: string; expiresAt: string; allowBrowser: boolean }
interface StoredMode extends AccessMode { hostId: string; ownerAccountId: string; codeHash: string }

@Injectable()
export class ModeService {
  constructor(
    private readonly config: SyncConfigService,
    private readonly redis: RedisService,
    private readonly sessions: RemoteSessionService,
  ) {}

  async set(account: Account, host: Device, input: { enabled: boolean; allowBrowser: boolean; ttlSeconds?: number }): Promise<{ mode: AccessMode | null; code?: string }> {
    this.assertConfigured();
    if (input.allowBrowser && host.platform !== 'macos') throw new BadRequestException('Browser access is available only for macOS hosts');
    if (!input.enabled) {
      await this.redis.client.del(this.modeKey(host.id));
      await this.sessions.endForHost(host.id, 'mode_disabled');
      return { mode: null };
    }
    const ttl = input.ttlSeconds ?? this.config.config.modeDefaultTtlSeconds;
    if (ttl > this.config.config.modeMaxTtlSeconds) throw new BadRequestException('Mode ttlSeconds exceeds policy');
    const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
    const epoch = randomUUID();
    const stored: StoredMode = {
      hostId: host.id, ownerAccountId: account.id, epoch, allowBrowser: input.allowBrowser,
      expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
      codeHash: this.codeHash(host.id, epoch, code),
    };
    await this.redis.client.set(this.modeKey(host.id), JSON.stringify(stored), 'EX', ttl);
    await this.sessions.endForHost(host.id, 'mode_reissued');
    return { mode: publicMode(stored), code };
  }

  async get(ownerAccountId: string, hostId: string): Promise<AccessMode | null> {
    const stored = await this.getStored(hostId);
    return stored?.ownerAccountId === ownerAccountId ? publicMode(stored) : null;
  }

  async require(ownerAccountId: string, hostId: string): Promise<StoredMode> {
    const mode = await this.getStored(hostId);
    if (!mode || mode.ownerAccountId !== ownerAccountId) throw new ForbiddenException('Remote mode is not active');
    return mode;
  }

  async verifyPin(account: Account, hostId: string, code: string, ip: string): Promise<StoredMode> {
    this.assertConfigured();
    const mode = await this.require(account.id, hostId);
    const accountFailures = this.redis.key('pin-fail', sha256(account.id), hostId, mode.epoch);
    const ipFailures = this.redis.key('pin-ip', sha256(ip || 'unknown'), hostId, mode.epoch);
    const ttl = Math.max(1, Math.ceil((Date.parse(mode.expiresAt) - Date.now()) / 1000));
    const result = await this.redis.client.eval(
      `local raw=redis.call('GET',KEYS[1]); if not raw then return {'NO_MODE'} end; local obj=cjson.decode(raw);
       if obj.epoch ~= ARGV[1] or obj.codeHash ~= ARGV[2] then
         local a=redis.call('INCR',KEYS[2]); local i=redis.call('INCR',KEYS[3]); redis.call('EXPIRE',KEYS[2],ARGV[4]); redis.call('EXPIRE',KEYS[3],ARGV[4]);
         if a >= tonumber(ARGV[3]) or i >= tonumber(ARGV[3]) * 4 then redis.call('DEL',KEYS[1]); return {'LOCKED'} end;
         return {'INVALID',tostring(a)};
       end; redis.call('DEL',KEYS[2]); redis.call('DEL',KEYS[3]); return {'OK',raw}`, 3,
      this.modeKey(hostId), accountFailures, ipFailures, mode.epoch, this.codeHash(hostId, mode.epoch, code),
      String(this.config.config.pinFailureLimit), String(ttl),
    ) as string[];
    if (result[0] === 'OK') return JSON.parse(result[1]!) as StoredMode;
    if (result[0] === 'LOCKED') {
      await this.sessions.endForHost(hostId, 'pin_locked');
      throw new HttpException('PIN is locked; re-enable remote mode to issue a new code', HttpStatus.TOO_MANY_REQUESTS);
    }
    throw new ForbiddenException('Remote mode or PIN is invalid');
  }

  async clear(hostId: string): Promise<void> { await this.redis.client.del(this.modeKey(hostId)); }
  private async getStored(hostId: string): Promise<StoredMode | undefined> {
    const raw = await this.redis.client.get(this.modeKey(hostId));
    if (!raw) return undefined;
    const mode = JSON.parse(raw) as StoredMode;
    if (Date.parse(mode.expiresAt) <= Date.now()) { await this.redis.client.del(this.modeKey(hostId)); return undefined; }
    return mode;
  }
  private codeHash(hostId: string, epoch: string, code: string): string {
    return hmac256(this.config.config.pinPepper!, `${hostId}:${epoch}:${code}`);
  }
  private assertConfigured(): void {
    if (!this.config.modeConfigured) throw new ServiceUnavailableException('Remote mode PIN security is not configured');
  }
  private modeKey(hostId: string): string { return this.redis.key('mode', hostId); }
}

function publicMode(mode: StoredMode): AccessMode { return { epoch: mode.epoch, expiresAt: mode.expiresAt, allowBrowser: mode.allowBrowser }; }
