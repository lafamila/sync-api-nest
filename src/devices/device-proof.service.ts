import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { createPublicKey, randomUUID, verify } from 'node:crypto';
import { randomOpaque } from '../common/crypto';
import { Account } from '../common/request';
import { SyncConfigService } from '../config/config.service';
import { RedisService } from '../redis/redis.service';
import { DeviceProofDto, RegisterDeviceDto } from './device.dto';
import { Device, DeviceRepository } from './device.repository';
import { deviceProof, registrationProof } from '../generated/sync-wire';

interface Challenge { id: string; nonce: string; accountId: string; deviceId?: string; expiresAt: string }

@Injectable()
export class DeviceProofService {
  constructor(
    private readonly config: SyncConfigService,
    private readonly redis: RedisService,
    private readonly devices: DeviceRepository,
  ) {}

  async challenge(account: Account, deviceId?: string): Promise<{ id: string; nonce: string; expiresAt: string }> {
    if (deviceId && !await this.devices.findOwned(account.id, deviceId)) throw new NotFoundException('Device not found');
    const id = randomOpaque();
    const challenge: Challenge = {
      id, nonce: randomOpaque(), accountId: account.id, deviceId,
      expiresAt: new Date(Date.now() + this.config.config.deviceChallengeTtlSeconds * 1000).toISOString(),
    };
    await this.redis.client.set(this.challengeKey(id), JSON.stringify(challenge), 'EX', this.config.config.deviceChallengeTtlSeconds);
    return { id, nonce: challenge.nonce, expiresAt: challenge.expiresAt };
  }

  async register(account: Account, input: RegisterDeviceDto): Promise<Device> {
    const challenge = await this.consumeChallenge(account.id, input.challengeId, undefined);
    const publicKeyDer = decodePublicKey(input.publicKey);
    if (!verifySignature(publicKeyDer, registrationProof(challenge.id,challenge.nonce), input.signature)) {
      throw new ForbiddenException('Device registration signature is invalid');
    }
    return this.devices.create(account.id, { name: input.name, platform: input.platform, publicKeyDer,
      protocolVersion: input.protocolVersion, clientVersion: input.clientVersion, capabilities: input.capabilities });
  }

  async verify(account: Account, proof: DeviceProofDto, expectedDeviceId?: string): Promise<Device> {
    if (expectedDeviceId && proof.deviceId !== expectedDeviceId) throw new ForbiddenException('Proof device does not match target device');
    const device = await this.devices.findOwned(account.id, proof.deviceId);
    if (!device) throw new NotFoundException('Device not found');
    const challenge = await this.consumeChallenge(account.id, proof.challengeId, device.id);
    if (!verifySignature(device.publicKeyDer, deviceProof(device.id,challenge.id,challenge.nonce), proof.signature)) {
      throw new ForbiddenException('Device proof signature is invalid');
    }
    return device;
  }

  private async consumeChallenge(accountId: string, id: string, deviceId: string | undefined): Promise<Challenge> {
    const raw = await this.redis.client.call('GETDEL', this.challengeKey(id)) as string | null;
    if (!raw) throw new ForbiddenException('Device challenge is invalid, expired, or already used');
    const challenge = JSON.parse(raw) as Challenge;
    if (challenge.accountId !== accountId || challenge.deviceId !== deviceId) throw new ForbiddenException('Device challenge binding is invalid');
    return challenge;
  }
  private challengeKey(id: string): string { return this.redis.key('device-challenge', id); }
}

function decodePublicKey(encoded: string): Buffer {
  const der = Buffer.from(encoded, 'base64');
  try {
    const key = createPublicKey({ key: der, format: 'der', type: 'spki' });
    const details = key.asymmetricKeyDetails;
    if (key.asymmetricKeyType !== 'ec' || details?.namedCurve !== 'prime256v1') throw new Error('wrong curve');
    if (!Buffer.from(key.export({ format: 'der', type: 'spki' })).equals(der)) throw new Error('non-canonical key');
  } catch {
    throw new BadRequestException('publicKey must be a P-256 SPKI DER key encoded as base64');
  }
  return der;
}

function verifySignature(publicKeyDer: Buffer, message: string, signature: string): boolean {
  try {
    const key = createPublicKey({ key: publicKeyDer, format: 'der', type: 'spki' });
    return verify('sha256', Buffer.from(message, 'utf8'), key, Buffer.from(signature, 'base64'));
  } catch { return false; }
}
