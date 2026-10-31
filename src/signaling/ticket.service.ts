import { ForbiddenException, Injectable } from '@nestjs/common';
import { randomOpaque, sha256 } from '../common/crypto';
import { SyncConfigService } from '../config/config.service';
import { RedisService } from '../redis/redis.service';
import { Device } from '../devices/device.repository';
import { ActiveEndpoint, endpointFeatures } from '../common/protocol';

export type TicketPayload =
  | { role: 'device'; ownerAccountId: string; deviceId: string; platform: Device['platform']; authSessionId:string;
      protocolVersion?: number; capabilities?: string[]; cliProtocolVersion?: number }
  | { role: 'controller'; ownerAccountId: string; sessionId: string; browser: boolean; authSessionId: string };

@Injectable()
export class TicketService {
  constructor(private readonly config: SyncConfigService, private readonly redis: RedisService) {}
  async issue(payload: TicketPayload): Promise<string> {
    const ticket = randomOpaque(32);
    await this.redis.client.set(this.key(ticket), JSON.stringify(payload), 'EX', this.config.config.ticketTtlSeconds, 'NX');
    return ticket;
  }
  async peek(ticket: string): Promise<TicketPayload> {
    const raw = await this.redis.client.get(this.key(ticket));
    if (!raw) throw new ForbiddenException('Signaling ticket is invalid or expired');
    return JSON.parse(raw) as TicketPayload;
  }
  async consume(ticket: string): Promise<TicketPayload> {
    const raw = await this.redis.client.call('GETDEL', this.key(ticket)) as string | null;
    if (!raw) throw new ForbiddenException('Signaling ticket is invalid, expired, or already used');
    return JSON.parse(raw) as TicketPayload;
  }
  async activeEndpoint(deviceId: string): Promise<ActiveEndpoint | undefined> {
    const raw = await this.redis.client.get(this.redis.key('presence', deviceId));
    if (!raw) return undefined;
    try {
      const value = JSON.parse(raw) as ActiveEndpoint;
      if (typeof value.id === 'string' && Number.isInteger(value.protocolVersion) && Array.isArray(value.capabilities)) {
        return {id:value.id,...endpointFeatures(value)};
      }
    } catch { /* Legacy presence is an opaque socket identifier. */ }
    return { id: raw, protocolVersion: 1, capabilities: [] };
  }
  private key(ticket: string): string { return this.redis.key('signaling-ticket', sha256(ticket)); }
}
