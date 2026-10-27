import { ForbiddenException, Injectable } from '@nestjs/common';
import { randomOpaque, sha256 } from '../common/crypto';
import { SyncConfigService } from '../config/config.service';
import { RedisService } from '../redis/redis.service';

export type TicketPayload =
  | { role: 'device'; ownerAccountId: string; deviceId: string; platform: 'macos' | 'ios'; authSessionId:string }
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
  private key(ticket: string): string { return this.redis.key('signaling-ticket', sha256(ticket)); }
}
