import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { AuthSessionContext } from '../common/request';
import { RevocationBusService } from '../common/revocation-bus.service';
import { IceService } from '../ice/ice.service';
import { RedisService } from '../redis/redis.service';
import { SyncConfigService } from '../config/config.service';
import { RemoteSessionService } from '../sessions/remote-session.service';
import { TicketService } from '../signaling/ticket.service';
import { ApproveGrantDto, BrowserRecoveryDto, CapabilityUpdateDto, ConnectDeviceDto, DeviceProofDto, RegisterDeviceDto, SetModeDto } from './device.dto';
import { DeviceProofService } from './device-proof.service';
import { DeviceRepository } from './device.repository';
import { ModeService } from './mode.service';
import { EndpointFeatures, endpointFeatures, negotiate, requireBoundedHost, requireCliProtocol, requireWebProtocol } from '../common/protocol';
import { randomOpaque, sha256 } from '../common/crypto';
import { WireBrowserActivityState } from '../generated/sync-wire';

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

  async updateCapabilities(session: AuthSessionContext, id: string, input: CapabilityUpdateDto) {
    await this.proofs.verify(session.account,input,id);
    const device=await this.devices.updateCapabilities(session.account.id,id,input);
    if (!device) throw new NotFoundException('Device not found');
    const endpoint=await this.tickets.activeEndpoint(id);
    return { device:{...presentDevice(device,endpoint),online:Boolean(endpoint),
      mode:await this.modes.get(session.account.id,id)} };
  }

  async list(session: AuthSessionContext) {
    const devices = await this.devices.listOwned(session.account.id);
    return { devices: await Promise.all(devices.map(async (device) => {
      const endpoint=await this.tickets.activeEndpoint(device.id);
      return {...presentDevice(device,endpoint),online:Boolean(endpoint),mode:await this.modes.get(session.account.id,device.id)};
    })) };
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
    const grant=await this.devices.rememberGrant(session.account.id,hostId,controller.id,isMobile(host.platform)?'view':'control');
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
    const purpose=input.purpose ?? 'screen';
    if(purpose==='cli' && (session.source!=='native' || input.scope!=='control')) {
      throw new ForbiddenException('CLI sessions require trusted native control');
    }
    if(session.source==='web') requireWebProtocol(input.protocolVersion);
    if(input.rememberDevice) throw new BadRequestException('rememberDevice cannot create trust; approve the controller from the host device');
    const host = await this.devices.findOwned(session.account.id,hostId);
    if (!host) {
      if(purpose==='cli') throw new ForbiddenException('CLI host is not authorized');
      throw new NotFoundException('Host device not found');
    }
    if(purpose==='cli' && host.platform!=='macos') throw new ForbiddenException('CLI sessions require a Mac host');
    if (isMobile(host.platform) && input.scope !== 'view') throw new ForbiddenException('Mobile hosts support view-only sessions');
    let mode = await this.modes.require(session.account.id,hostId);
    let controllerDeviceId: string | undefined;
    let authorizationGrantId:string|undefined;
    if (session.source === 'web') {
      if(isMobile(host.platform)) throw new ForbiddenException('Temporary PIN access is desktop-only');
      if (!mode.allowBrowser) throw new ForbiddenException('Browser access is disabled for this mode');
      if (input.controllerDeviceId || input.challengeId || input.signature || input.rememberDevice) {
        throw new BadRequestException('Browser connections cannot use native device trust');
      }
      if (!input.code) throw new ForbiddenException('Current six-digit PIN is required');
      mode = await this.modes.verifyPin(session.account,hostId,input.code,ip);
    } else {
      if (!input.controllerDeviceId || !input.challengeId || !input.signature) {
        if(purpose==='cli') throw new ForbiddenException('CLI sessions require native device proof');
        throw new BadRequestException('Native connection requires device proof');
      }
      controllerDeviceId = input.controllerDeviceId;
      if (controllerDeviceId === hostId) {
        if(purpose==='cli') throw new ForbiddenException('CLI controller must differ from the host');
        throw new BadRequestException('Host and controller devices must differ');
      }
      try {
        await this.proofs.verify(session.account, {
          deviceId:controllerDeviceId, challengeId:input.challengeId, signature:input.signature,
        });
      } catch(error) {
        if(purpose==='cli' && error instanceof NotFoundException) throw new ForbiddenException('CLI controller is not authorized');
        throw error;
      }
      const grant = await this.devices.findGrant(session.account.id,hostId,controllerDeviceId);
      const grantAllows = grant && (grant.scope === 'control' || input.scope === 'view');
      const requiresPin = !grantAllows;
      if(grantAllows) authorizationGrantId=grant.id;
      if(purpose==='cli' && (!grant || grant.scope!=='control')) throw new ForbiddenException('CLI sessions require a control grant');
      if (requiresPin) {
        if(isMobile(host.platform) || !mode.allowBrowser) {
          throw new ForbiddenException('Untrusted temporary connections are disabled for this host');
        }
        if (!input.code) throw new ForbiddenException('Current six-digit PIN is required');
        mode = await this.modes.verifyPin(session.account,hostId,input.code,ip);
      }
    }
    const endpoint=await this.tickets.activeEndpoint(hostId);
    if (!endpoint) throw new ForbiddenException('Host device is offline');
    const features=negotiate(endpoint,endpointFeatures(input));
    const cliEligible=session.source==='native' && host.platform==='macos' && input.scope==='control' && Boolean(authorizationGrantId);
    if(!cliEligible) delete features.cliProtocolVersion;
    if(purpose==='cli') requireCliProtocol(features,endpoint,this.config.config.requireBoundedHosts);
    else requireBoundedHost(endpoint,this.config.config.requireBoundedHosts);
    if(purpose==='cli') features.capabilities=[];
    const activityToken=session.source==='web'?randomOpaque(32):undefined;
    const expiresAt = new Date(Math.min(Date.parse(mode.expiresAt), Date.now() + this.config.config.remoteSessionTtlSeconds * 1000));
    const remote = await this.sessions.create({ ownerAccountId:session.account.id,hostId,controllerDeviceId,
      controllerKind:session.source === 'web' ? 'browser' : 'native',scope:input.scope,epoch:mode.epoch,
      authSessionId:session.databaseId,expiresAt,...features,purpose,hostEndpointId:endpoint.id,
      authorizationGrantId,connectionTimeoutSeconds:this.config.config.ticketTtlSeconds,
      activityTokenHash:activityToken?sha256(activityToken):undefined,idleTimeoutSeconds:this.config.config.webIdleTimeoutSeconds });
    try {
      const currentMode=await this.modes.require(session.account.id,hostId);
      const currentEndpoint=await this.tickets.activeEndpoint(hostId);
      if(currentMode.epoch!==mode.epoch || currentEndpoint?.id!==endpoint.id) {
        throw new ForbiddenException('Remote mode changed during connection authorization');
      }
      const ticket = await this.tickets.issue({ role:'controller', ownerAccountId:session.account.id,
        sessionId:remote.id,browser:session.source === 'web',authSessionId:session.databaseId });
      await this.devices.audit(session.account.id,'session_created',{ deviceId:hostId,sessionId:remote.id,metadata:{ scope:input.scope,controllerKind:remote.controllerKind } });
      return { session:presentSession(remote),ticket,iceServers:this.ice.forAccount(session.account),
        ...(activityToken?{webAccess:{activityToken,...presentActivity(remote)}}:{}) };
    } catch(error) {
      await this.sessions.endIfActive(session.account.id,remote.id,'connect_failed');
      throw error;
    }
  }

  async webActivity(session:AuthSessionContext,id:string,activityToken:string) {
    if(session.source!=='web') throw new ForbiddenException('Browser session is required');
    const remote=await this.sessions.findActive(id);
    if(!remote || remote.authSessionId!==session.databaseId || remote.ownerAccountId!==session.account.id) {
      throw new ForbiddenException('Browser access is invalid or expired');
    }
    const mode=await this.modes.require(session.account.id,remote.hostId);
    if(mode.epoch!==remote.epoch || !mode.allowBrowser) throw new ForbiddenException('Browser mode is no longer active');
    const updated=await this.sessions.activity(session.account.id,session.databaseId,id,sha256(activityToken),this.config.config.webIdleTimeoutSeconds);
    if(!updated) throw new ForbiddenException('Browser access is invalid or expired');
    return presentActivity(updated);
  }

  async recover(session:AuthSessionContext,id:string,input:BrowserRecoveryDto) {
    if(session.source!=='web') throw new ForbiddenException('Browser session is required');
    requireWebProtocol(input.protocolVersion);
    const previous=await this.sessions.findOwned(session.account.id,id);
    if(!previous || previous.authSessionId!==session.databaseId || previous.controllerKind!=='browser') {
      throw new ForbiddenException('Browser recovery is invalid or expired');
    }
    const host=await this.devices.findOwned(session.account.id,previous.hostId);
    if(!host || isMobile(host.platform)) throw new ForbiddenException('Desktop host is required');
    const mode=await this.modes.require(session.account.id,previous.hostId);
    if(mode.epoch!==previous.epoch || !mode.allowBrowser) throw new ForbiddenException('Browser mode is no longer active');
    const endpoint=await this.tickets.activeEndpoint(previous.hostId);
    if(!endpoint) throw new ForbiddenException('Host device is offline');
    requireBoundedHost(endpoint,this.config.config.requireBoundedHosts);
    const activityToken=randomOpaque(32);
    const remote=await this.sessions.recover({ownerId:session.account.id,authId:session.databaseId,id,
      tokenHash:sha256(input.activityToken),newTokenHash:sha256(activityToken),hostEndpointId:endpoint.id,
      features:negotiate(endpoint,endpointFeatures(input)),connectionTimeoutSeconds:this.config.config.ticketTtlSeconds});
    try {
      const currentMode=await this.modes.require(session.account.id,remote.hostId);
      if(currentMode.epoch!==remote.epoch || (await this.tickets.activeEndpoint(remote.hostId))?.id!==endpoint.id) {
        throw new ForbiddenException('Host changed during recovery');
      }
      const ticket=await this.tickets.issue({role:'controller',ownerAccountId:session.account.id,
        sessionId:remote.id,browser:true,authSessionId:session.databaseId});
      return {session:presentSession(remote),ticket,iceServers:this.ice.forAccount(session.account),
        webAccess:{activityToken,...presentActivity(remote)}};
    } catch(error) {
      await this.sessions.endIfActive(session.account.id,remote.id,'recovery_failed');
      throw error;
    }
  }
}

export function presentSession(session: import('../sessions/remote-session.repository').RemoteSession) {
  return { id:session.id,hostId:session.hostId,controllerId:session.controllerId,scope:session.scope,epoch:session.epoch,expiresAt:session.expiresAt,
    protocolVersion:session.protocolVersion,capabilities:session.capabilities,purpose:session.purpose ?? 'screen',
    ...(session.cliProtocolVersion===undefined?{}:{cliProtocolVersion:session.cliProtocolVersion}) };
}

export function presentDevice(device:import('./device.repository').Device,endpoint?:EndpointFeatures) {
  return {id:device.id,name:device.name,platform:device.platform,protocolVersion:device.protocolVersion,
    capabilities:device.capabilities,...(device.clientVersion?{clientVersion:device.clientVersion}:{}),
    ...(endpoint?.cliProtocolVersion===undefined?{}:{cliProtocolVersion:endpoint.cliProtocolVersion})};
}

function isMobile(platform:string) { return platform==='ios' || platform==='android'; }
function presentActivity(session:import('../sessions/remote-session.repository').RemoteSession):WireBrowserActivityState {
  return {serverNow:new Date().toISOString(),lastActivityAt:session.lastActivityAt!,idleDeadline:session.idleDeadline!};
}
