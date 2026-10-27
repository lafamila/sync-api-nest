import { ConflictException, Injectable, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { RevocationBusService } from '../common/revocation-bus.service';
import { RemoteSession, RemoteSessionRepository } from './remote-session.repository';
import { RuntimeIdentityService } from '../runtime/runtime-identity.service';

type CreateRemoteSessionInput=Omit<Parameters<RemoteSessionRepository['create']>[0],'runtimeNamespace'|'signalingInstanceId'>;

@Injectable()
export class RemoteSessionService implements OnModuleInit, OnModuleDestroy {
  private unsubscribe?: () => void;
  constructor(
    private readonly repository: RemoteSessionRepository,
    private readonly revocations: RevocationBusService,
    private readonly identity:RuntimeIdentityService,
  ) {}
  onModuleInit(): void {
    this.unsubscribe = this.revocations.subscribe((event) => {
      if (event.kind === 'auth-session') void this.endForAuthSession(event.id, event.reason);
    });
  }
  onModuleDestroy(): void { this.unsubscribe?.(); }

  async create(input:CreateRemoteSessionInput): Promise<RemoteSession> {
    try { return await this.repository.create({...input,runtimeNamespace:this.identity.namespace,signalingInstanceId:this.identity.instanceId}); }
    catch (error) {
      if (isPgUniqueViolation(error)) throw new ConflictException('Host already has an active controller');
      throw error;
    }
  }
  listOwned(ownerId: string) { return this.repository.listOwned(ownerId); }
  findOwned(ownerId: string, id: string) { return this.repository.findOwned(ownerId,id); }
  findActive(id: string) { return this.repository.findActive(id); }
  findActiveForHost(hostId: string) { return this.repository.findActiveForHost(hostId); }
  async endOwned(ownerId: string, id: string, reason: string): Promise<RemoteSession> {
    const ended = await this.end(`owner_account_id=$1 and id=$2`, [ownerId,id], reason);
    if (!ended[0]) throw new NotFoundException('Remote session not found');
    return ended[0];
  }
  async endIfActive(ownerId:string,id:string,reason:string):Promise<RemoteSession|undefined> {
    return (await this.end('owner_account_id=$1 and id=$2',[ownerId,id],reason))[0];
  }
  endForHost(hostId: string, reason: string) { return this.end('host_device_id=$1', [hostId], reason); }
  endForDevice(deviceId: string, reason: string) { return this.end('(host_device_id=$1 or controller_device_id=$1)', [deviceId], reason); }
  endForPair(hostId: string, controllerId: string, reason: string) {
    return this.end('host_device_id=$1 and controller_device_id=$2', [hostId,controllerId], reason);
  }
  endForAuthSession(authSessionId: string, reason: string) { return this.end('auth_session_id=$1', [authSessionId], reason); }
  endOrphans(namespace:string,currentInstanceId:string,reason:string) {
    return this.end('runtime_namespace=$1 and signaling_instance_id<>$2',[namespace,currentInstanceId],reason);
  }
  endForInstance(namespace:string,instanceId:string,reason:string) {
    return this.end('runtime_namespace=$1 and signaling_instance_id=$2',[namespace,instanceId],reason);
  }
  async endExpired(): Promise<RemoteSession[]> { return this.end('expires_at <= now()', [], 'expired'); }
  private async end(where: string, params: readonly unknown[], reason: string): Promise<RemoteSession[]> {
    const ended = await this.repository.endWhere(where, params, reason);
    for (const session of ended) this.revocations.emit({ kind:'session', id:session.id, reason });
    return ended;
  }
}

function isPgUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as { code?: string }).code === '23505');
}
