import { NotFoundException } from '@nestjs/common';
import { RevocationBusService } from '../src/common/revocation-bus.service';
import { RemoteSessionController } from '../src/sessions/remote-session.controller';
import { RemoteSession } from '../src/sessions/remote-session.repository';
import { RemoteSessionService } from '../src/sessions/remote-session.service';

const endedSession: RemoteSession = {
  id: 'session-1', ownerAccountId: 'owner-1', hostId: 'host-1', controllerDeviceId: null,
  controllerId: 'browser', controllerKind: 'browser', scope: 'control', epoch: 'epoch-1',
  authSessionId: 'auth-1', createdAt: '2026-10-28T01:29:00.000Z', expiresAt: '2030-01-01T00:00:00.000Z',
  endedAt: '2026-10-28T01:30:31.500Z', endReason: 'controller_disconnected',
  runtimeNamespace: 'sync:test', signalingInstanceId: 'instance-1',
  protocolVersion:1,capabilities:[],hostEndpointId:null,lastActivityAt:null,idleDeadline:null,
};

function fixture(session: RemoteSession | undefined = endedSession) {
  const repository = {
    endWhere: jest.fn().mockResolvedValue([]),
    findOwned: jest.fn(async (ownerId: string, id: string) =>
      session?.ownerAccountId === ownerId && session.id === id ? session : undefined),
  };
  const revocations = new RevocationBusService();
  const emit = jest.spyOn(revocations, 'emit');
  const service = new RemoteSessionService(repository as never, revocations, {} as never);
  const proofs = { verify: jest.fn().mockResolvedValue(undefined) };
  const security = { assertMutation: jest.fn() };
  const controller = new RemoteSessionController(service, proofs as never, security as never);
  const request = (authSessionId = 'auth-1', source = 'web') => ({
    syncSession: { account: { id: 'owner-1' }, databaseId: authSessionId, source },
  }) as never;
  return { repository, emit, service, proofs, controller, request };
}

describe('Remote session termination', () => {
  it('accepts an already-ended owned session without changing its original end reason', async () => {
    const { service, repository, emit } = fixture();
    await expect(service.endOwned('owner-1', 'session-1', 'revoked')).resolves.toEqual(endedSession);
    expect(repository.findOwned).toHaveBeenCalledWith('owner-1', 'session-1');
    expect(emit).not.toHaveBeenCalled();
  });

  it('publishes the first end once and does not need to reload it', async () => {
    const { service, repository, emit } = fixture();
    repository.endWhere.mockResolvedValue([endedSession]);
    await expect(service.endOwned('owner-1', 'session-1', 'revoked')).resolves.toEqual(endedSession);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(repository.findOwned).not.toHaveBeenCalled();
  });

  it('still rejects missing and cross-owner sessions', async () => {
    const { service } = fixture();
    await expect(service.endOwned('owner-1', 'missing', 'revoked')).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.endOwned('other-owner', 'session-1', 'revoked')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('lets web Disconnect succeed after socket cleanup has already ended its own session', async () => {
    const { controller, request } = fixture();
    await expect(controller.end(request(), 'session-1', {})).resolves.toEqual({ ok: true });
  });

  it('does not let another browser auth session end an already-ended session', async () => {
    const { controller, request, repository } = fixture();
    await expect(controller.end(request('other-auth'), 'session-1', {})).rejects.toBeInstanceOf(NotFoundException);
    expect(repository.endWhere).not.toHaveBeenCalled();
  });

  it('still requires native participant proof for an already-ended session', async () => {
    const { controller, request, proofs, repository } = fixture();
    await expect(controller.end(request('native-auth', 'native'), 'session-1', {})).rejects.toBeInstanceOf(NotFoundException);
    await expect(controller.end(request('native-auth', 'native'), 'session-1', {
      deviceId: 'unrelated-device', challengeId: 'challenge', signature: 'signature',
    })).rejects.toBeInstanceOf(NotFoundException);
    expect(repository.endWhere).not.toHaveBeenCalled();
    await expect(controller.end(request('native-auth', 'native'), 'session-1', {
      deviceId: 'host-1', challengeId: 'challenge', signature: 'signature',
    })).resolves.toEqual({ ok: true });
    expect(proofs.verify).toHaveBeenCalledTimes(1);
  });
});
