import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../database/database.service';

interface SessionRow {
  id: string; owner_account_id: string; host_device_id: string; controller_device_id: string | null;
  controller_kind: 'browser' | 'native'; scope: 'view' | 'control'; mode_epoch: string; auth_session_id: string;
  runtime_namespace:string; signaling_instance_id:string;
  created_at: Date; expires_at: Date; ended_at: Date | null; end_reason: string | null;
}

export interface RemoteSession {
  id: string; ownerAccountId: string; hostId: string; controllerDeviceId: string | null;
  controllerId: string; controllerKind: 'browser' | 'native'; scope: 'view' | 'control'; epoch: string;
  authSessionId: string; createdAt: string; expiresAt: string; endedAt: string | null; endReason: string | null;
  runtimeNamespace:string; signalingInstanceId:string;
}

@Injectable()
export class RemoteSessionRepository {
  constructor(private readonly db: DatabaseService) {}

  async create(input: { ownerAccountId: string; hostId: string; controllerDeviceId?: string; controllerKind: 'browser' | 'native';
    scope: 'view' | 'control'; epoch: string; authSessionId: string; expiresAt: Date;
    runtimeNamespace:string; signalingInstanceId:string }): Promise<RemoteSession> {
    const id = randomUUID();
    const result = await this.db.query<SessionRow>(
      `insert into sync_remote_sessions(id,owner_account_id,host_device_id,controller_device_id,controller_kind,scope,mode_epoch,auth_session_id,expires_at,runtime_namespace,signaling_instance_id)
       values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning *`,
      [id,input.ownerAccountId,input.hostId,input.controllerDeviceId ?? null,input.controllerKind,input.scope,input.epoch,input.authSessionId,input.expiresAt,
       input.runtimeNamespace,input.signalingInstanceId],
    );
    return mapSession(result.rows[0]!);
  }

  async listOwned(ownerAccountId: string): Promise<RemoteSession[]> {
    const result = await this.db.query<SessionRow>(
      `select * from sync_remote_sessions where owner_account_id=$1 order by created_at desc limit 200`, [ownerAccountId]);
    return result.rows.map(mapSession);
  }
  async findOwned(ownerAccountId: string, id: string): Promise<RemoteSession | undefined> {
    const result = await this.db.query<SessionRow>('select * from sync_remote_sessions where id=$1 and owner_account_id=$2', [id,ownerAccountId]);
    return result.rows[0] ? mapSession(result.rows[0]) : undefined;
  }
  async findActive(id: string): Promise<RemoteSession | undefined> {
    const result = await this.db.query<SessionRow>(
      `select * from sync_remote_sessions where id=$1 and ended_at is null and expires_at > now()`, [id]);
    return result.rows[0] ? mapSession(result.rows[0]) : undefined;
  }
  async findActiveForHost(hostId: string): Promise<RemoteSession[]> {
    const result = await this.db.query<SessionRow>(
      `select * from sync_remote_sessions where host_device_id=$1 and ended_at is null and expires_at > now()`, [hostId]);
    return result.rows.map(mapSession);
  }
  async endWhere(where: string, params: readonly unknown[], reason: string): Promise<RemoteSession[]> {
    const result = await this.db.query<SessionRow>(
      `update sync_remote_sessions set ended_at=now(), end_reason=$${params.length + 1}
       where ended_at is null and (${where}) returning *`, [...params,reason]);
    return result.rows.map(mapSession);
  }
}

function mapSession(row: SessionRow): RemoteSession {
  return { id:row.id, ownerAccountId:row.owner_account_id, hostId:row.host_device_id,
    controllerDeviceId:row.controller_device_id, controllerId:row.controller_device_id ?? 'browser', controllerKind:row.controller_kind,
    scope:row.scope, epoch:row.mode_epoch, authSessionId:row.auth_session_id, createdAt:row.created_at.toISOString(),
    expiresAt:row.expires_at.toISOString(), endedAt:row.ended_at?.toISOString() ?? null, endReason:row.end_reason,
    runtimeNamespace:row.runtime_namespace,signalingInstanceId:row.signaling_instance_id };
}
