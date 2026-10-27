import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { AuthSessionContext } from '../common/request';
import { RevocationBusService } from '../common/revocation-bus.service';
import { IceService } from '../ice/ice.service';
import { RedisService } from '../redis/redis.service';
import { SyncConfigService } from '../config/config.service';
import { RemoteSessionService } from '../sessions/remote-session.service';
import { TicketService } from '../signaling/ticket.service';
import { ApproveGrantDto, ConnectDeviceDto, DeviceProofDto, RegisterDeviceDto, SetModeDto } from './device.dto';
import { DeviceProofService } from './device-proof.service';
import { DeviceRepository } from './device.repository';
import { ModeService } from './mode.service';

@Injectable()
export class DeviceService {
  constructor(
    private readonly devices: DeviceRepository,
    private readonly proofs: DeviceProofService,
    private readonly modes: ModeService,
    private readonly sessions: RemoteSessionService,
    private readonly tickets: TicketService,
    private readonly ice: IceService,
    private readonly redis: RedisService,
    private readonly revocations: RevocationBusService,
    private readonly config: SyncConfigService,
  ) {}

  register(session: AuthSessionContext, input: RegisterDeviceDto) { return this.proofs.register(session.account, input); }

  async list(session: AuthSessionContext) {
    const devices = await this.devices.listOwned(session.account.id);
    return { devices: await Promise.all(devices.map(async (device) => ({
      id: device.id, name: device.name, platform: device.platform,
      online: Boolean(await this.redis.client.get(this.redis.key('presence', device.id))),
      mode: await this.modes.get(session.account.id, device.id),
    }))) };
  }

  async remove(session: AuthSessionContext, id: string, proof: DeviceProofDto): Promise<{ ok: true }> {
    await this.proofs.verify(session.account, proof);
    if(!await this.devices.findOwned(session.account.id,id)) throw new NotFoundException('Device not found');
    if (!await this.devices.revoke(session.account.id, id)) throw new NotFoundException('Device not found');
    await this.modes.clear(id);
    await this.sessions.endForDevice(id, 'device_revoked');
    this.revocations.emit({ kind:'device', id, reason:'device_revoked' });
    await this.devices.audit(session.account.id, 'device_revoked', { deviceId:id });
    return { ok:true };
  }

  async setMode(session: AuthSessionContext, id: string, input: SetModeDto) {
    const host = await this.proofs.verify(session.account, input, id);
    const result = await this.modes.set(session.account, host, input);
    await this.devices.audit(session.account.id, input.enabled ? 'mode_enabled' : 'mode_disabled', { deviceId:id, metadata:{ allowBrowser:input.allowBrowser } });
    return result;
  }

  async listGrants(session: AuthSessionContext, hostId: string) {
    if (!await this.devices.findOwned(session.account.id,hostId)) throw new NotFoundException('Device not found');
    const grants = await this.devices.listGrants(session.account.id,hostId);
    return { grants:grants.map((grant) => ({ id:grant.id,controllerDeviceId:grant.controllerDeviceId,createdAt:grant.createdAt })) };
  }

  async approveGrant(session:AuthSessionContext,hostId:string,input:ApproveGrantDto) {
    const host=await this.proofs.verify(session.account,input,hostId);
    if(input.controllerDeviceId===hostId) throw new BadRequestException('Host and controller devices must differ');
    const controller=await this.devices.findOwned(session.account.id,input.controllerDeviceId);
    if(!controller) throw new NotFoundException('Controller device not found');
    const grant=await this.devices.rememberGrant(session.account.id,hostId,controller.id,host.platform==='ios'?'view':'control');
    await this.devices.audit(session.account.id,'grant_approved',{deviceId:hostId,metadata:{controllerDeviceId:controller.id}});
    return { grant:{id:grant.id,controllerDeviceId:grant.controllerDeviceId,createdAt:grant.createdAt} };
  }

  async revokeGrant(session: AuthSessionContext, hostId: string, grantId: string, proof: DeviceProofDto) {
    await this.proofs.verify(session.account,proof,hostId);
    const grant = await this.devices.revokeGrant(session.account.id,hostId,grantId);
    if (!grant) throw new NotFoundException('Grant not found');
    await this.sessions.endForPair(hostId,grant.controllerDeviceId,'grant_revoked');
    return { ok:true };
  }

  async connect(session: AuthSessionContext, hostId: string, input: ConnectDeviceDto, ip: string) {
    if(input.rememberDevice) throw new BadRequestException('rememberDevice cannot create trust; approve the controller from the host device');
    const host = await this.devices.findOwned(session.account.id,hostId);
    if (!host) throw new NotFoundException('Host device not found');
    if (host.platform === 'ios' && input.scope !== 'view') throw new ForbiddenException('iOS hosts support view-only sessions');
    let mode = await this.modes.require(session.account.id,hostId);
    let controllerDeviceId: string | undefined;
    if (session.source === 'web') {
      if (!mode.allowBrowser) throw new ForbiddenException('Browser access is disabled for this mode');
      if (input.controllerDeviceId || input.challengeId || input.signature || input.rememberDevice) {
        throw new BadRequestException('Browser connections cannot use native device trust');
      }
      if (!input.code) throw new ForbiddenException('Current six-digit PIN is required');
      mode = await this.modes.verifyPin(session.account,hostId,input.code,ip);
    } else {
      if (!input.controllerDeviceId || !input.challengeId || !input.signature) throw new BadRequestException('Native connection requires device proof');
      controllerDeviceId = input.controllerDeviceId;
      if (controllerDeviceId === hostId) throw new BadRequestException('Host and controller devices must differ');
      await this.proofs.verify(session.account, {
        deviceId:controllerDeviceId, challengeId:input.challengeId, signature:input.signature,
      });
      const grant = await this.devices.findGrant(session.account.id,hostId,controllerDeviceId);
      const grantAllows = grant && (grant.scope === 'control' || input.scope === 'view');
      const requiresPin = !grantAllows;
      if (requiresPin) {
        if(host.platform!=='macos' || !mode.allowBrowser) {
          throw new ForbiddenException('Untrusted temporary connections are disabled for this host');
        }
        if (!input.code) throw new ForbiddenException('Current six-digit PIN is required');
        mode = await this.modes.verifyPin(session.account,hostId,input.code,ip);
      }
    }
    if (!await this.redis.client.get(this.redis.key('presence',hostId))) throw new ForbiddenException('Host device is offline');
    const expiresAt = new Date(Math.min(Date.parse(mode.expiresAt), Date.now() + this.config.config.remoteSessionTtlSeconds * 1000));
    const remote = await this.sessions.create({ ownerAccountId:session.account.id,hostId,controllerDeviceId,
      controllerKind:session.source === 'web' ? 'browser' : 'native',scope:input.scope,epoch:mode.epoch,
      authSessionId:session.databaseId,expiresAt });
    const currentMode=await this.modes.require(session.account.id,hostId);
    if(currentMode.epoch!==mode.epoch) {
      await this.sessions.endOwned(session.account.id,remote.id,'mode_changed_during_connect');
      throw new ForbiddenException('Remote mode changed during connection authorization');
    }
    const ticket = await this.tickets.issue({ role:'controller', ownerAccountId:session.account.id,
      sessionId:remote.id,browser:session.source === 'web',authSessionId:session.databaseId });
    await this.devices.audit(session.account.id,'session_created',{ deviceId:hostId,sessionId:remote.id,metadata:{ scope:input.scope,controllerKind:remote.controllerKind } });
    return { session:presentSession(remote),ticket,iceServers:this.ice.forAccount(session.account) };
  }
}

export function presentSession(session: import('../sessions/remote-session.repository').RemoteSession) {
  return { id:session.id,hostId:session.hostId,controllerId:session.controllerId,scope:session.scope,epoch:session.epoch,expiresAt:session.expiresAt };
}
