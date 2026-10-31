import { ForbiddenException, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DatabaseService, Query } from '../database/database.service';
import { EndpointFeatures } from '../common/protocol';

interface SessionRow {
  id: string; owner_account_id: string; host_device_id: string; controller_device_id: string | null;
  controller_kind: 'browser' | 'native'; scope: 'view' | 'control'; mode_epoch: string; auth_session_id: string;
  runtime_namespace:string; signaling_instance_id:string;
  protocol_version:number; capabilities:string[]; host_endpoint_id:string|null;
  purpose:'screen'|'cli'; cli_protocol_version:number|null;
  activity_token_hash:string|null; last_activity_at:Date|null; idle_deadline:Date|null; recovery_consumed:boolean;
  authorization_grant_id:string|null; connection_deadline:Date|null; connected_at:Date|null;
  created_at: Date; expires_at: Date; ended_at: Date | null; end_reason: string | null;
}

export interface RemoteSession {
  id: string; ownerAccountId: string; hostId: string; controllerDeviceId: string | null;
  controllerId: string; controllerKind: 'browser' | 'native'; scope: 'view' | 'control'; epoch: string;
  authSessionId: string; createdAt: string; expiresAt: string; endedAt: string | null; endReason: string | null;
  runtimeNamespace:string; signalingInstanceId:string;
  protocolVersion:number; capabilities:string[]; hostEndpointId:string|null;
  purpose?:'screen'|'cli'; cliProtocolVersion?:number;
  lastActivityAt:string|null; idleDeadline:string|null;
  authorizationGrantId?:string|null; connectionDeadline?:string|null; connectedAt?:string|null;
}

export interface CreateSessionInput {
  ownerAccountId:string; hostId:string; controllerDeviceId?:string; controllerKind:'browser'|'native';
  scope:'view'|'control'; epoch:string; authSessionId:string; expiresAt:Date;
  runtimeNamespace:string; signalingInstanceId:string; protocolVersion?:number; capabilities?:string[];
  hostEndpointId?:string; activityTokenHash?:string; idleTimeoutSeconds?:number;
  authorizationGrantId?:string; connectionTimeoutSeconds?:number;
  purpose?:'screen'|'cli'; cliProtocolVersion?:number;
}

const RECOVERABLE_REASONS = ['controller_disconnected','device_disconnected','server_shutdown','server_restarted'];
const ACTIVE = `ended_at is null and expires_at > clock_timestamp()
  and (controller_kind='native' or idle_deadline > clock_timestamp())
  and (connected_at is not null or connection_deadline is null or connection_deadline > clock_timestamp())`;

@Injectable()
export class RemoteSessionRepository {
  constructor(private readonly db: DatabaseService) {}

  async create(input: CreateSessionInput, query?:Query, continuity?:SessionRow): Promise<RemoteSession> {
    if (!query) return this.db.transaction((transaction) => this.create(input,transaction,continuity));
    await this.lockAuthorization(query,input);
    const id = randomUUID();
    const result = await query<SessionRow>(
      `insert into sync_remote_sessions(id,owner_account_id,host_device_id,controller_device_id,controller_kind,scope,mode_epoch,auth_session_id,expires_at,runtime_namespace,signaling_instance_id,
       protocol_version,capabilities,host_endpoint_id,activity_token_hash,last_activity_at,idle_deadline,authorization_grant_id,connection_deadline,purpose,cli_protocol_version)
       select $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15,
         case when $5='browser' then coalesce($16::timestamptz,clock_timestamp()) end,
         case when $5='browser' then coalesce($17::timestamptz,least($9,clock_timestamp()+($18 * interval '1 second'))) end,
         $19,case when $20::integer is not null then least($9,clock_timestamp()+($20 * interval '1 second')) end,$21,$22
       where exists(select 1 from sync_auth_sessions where id=$8 and expires_at>clock_timestamp()) returning *`,
      [id,input.ownerAccountId,input.hostId,input.controllerDeviceId ?? null,input.controllerKind,input.scope,input.epoch,input.authSessionId,input.expiresAt,
       input.runtimeNamespace,input.signalingInstanceId,input.protocolVersion ?? 1,JSON.stringify(input.capabilities ?? []),
       input.hostEndpointId ?? null,input.activityTokenHash ?? null,continuity?.last_activity_at ?? null,
       continuity?.idle_deadline ?? null,input.idleTimeoutSeconds ?? 900,input.authorizationGrantId ?? null,input.connectionTimeoutSeconds ?? null,
       input.purpose ?? 'screen',input.cliProtocolVersion ?? null],
    );
    if(!result.rows[0]) throw new ForbiddenException('Local authentication session expired');
    return mapSession(result.rows[0]);
  }

  private async lockAuthorization(query:Query,input:Pick<CreateSessionInput,'ownerAccountId'|'authSessionId'|'controllerKind'|'hostId'|'controllerDeviceId'|'authorizationGrantId'|'scope'|'purpose'|'cliProtocolVersion'|'protocolVersion'|'hostEndpointId'>):Promise<void> {
    const cli=input.cliProtocolVersion!==undefined || input.purpose==='cli';
    if(cli && (input.cliProtocolVersion!==1 || (input.protocolVersion ?? 1)<2 || input.controllerKind!=='native' ||
      input.scope!=='control' || !input.controllerDeviceId || input.controllerDeviceId===input.hostId ||
      !input.authorizationGrantId || !input.hostEndpointId)) throw new ForbiddenException('CLI sessions require trusted native control');
    // Global order: auth session, sorted devices, grant, then remote session. Refresh locks only auth.
    const auth=await query(`select id from sync_auth_sessions where id=$1 and account_id=$2 and revoked_at is null
      and (($3='browser' and platform='web') or ($3='native' and platform<>'web')) for share`,
      [input.authSessionId,input.ownerAccountId,input.controllerKind]);
    if(!auth.rowCount) throw new ForbiddenException('Local authentication session is no longer active');
    const ids=[...new Set([input.hostId,...(input.controllerDeviceId?[input.controllerDeviceId]:[])])].sort();
    // Revocation updates devices before grants. Hold compatible read locks through INSERT/install.
    const participants=await query(`select id from sync_devices where owner_account_id=$1 and id=any($2::uuid[])
      and revoked_at is null order by id for share`,[input.ownerAccountId,ids]);
    if(participants.rowCount!==ids.length) throw new ForbiddenException('Session participant was revoked');
    if(cli && !(await query(`select 1 from sync_devices where id=$1 and platform='macos'`,[input.hostId])).rowCount) {
      throw new ForbiddenException('CLI sessions require a Mac host');
    }
    if(input.authorizationGrantId) {
      const grant=await query(`select id from sync_device_grants where id=$1 and owner_account_id=$2
        and host_device_id=$3 and controller_device_id=$4 and revoked_at is null
        and (scope='control' or $5='view') for share`,
        [input.authorizationGrantId,input.ownerAccountId,input.hostId,input.controllerDeviceId,input.scope]);
      if(!grant.rowCount) throw new ForbiddenException('Controller trust was revoked');
    }
    // Expiry may elapse while waiting for any of the locks above, even without a row update.
    const active=await query(`select 1 from sync_auth_sessions where id=$1 and expires_at>clock_timestamp()`,[input.authSessionId]);
    if(!active.rowCount) throw new ForbiddenException('Local authentication session expired');
  }

  async installController(snapshot:RemoteSession,install:(session:RemoteSession)=>boolean):Promise<RemoteSession> {
    return this.db.transaction(async(query)=>{
      await this.lockAuthorization(query,{ownerAccountId:snapshot.ownerAccountId,hostId:snapshot.hostId,
        authSessionId:snapshot.authSessionId,controllerKind:snapshot.controllerKind,
        controllerDeviceId:snapshot.controllerDeviceId ?? undefined,scope:snapshot.scope,
        authorizationGrantId:snapshot.authorizationGrantId ?? undefined,purpose:snapshot.purpose,cliProtocolVersion:snapshot.cliProtocolVersion,
        protocolVersion:snapshot.protocolVersion,hostEndpointId:snapshot.hostEndpointId ?? undefined});
      await query(`select id from sync_remote_sessions where id=$1 for update`,[snapshot.id]);
      // Time is evaluated after the row lock, so a stale discovery snapshot cannot claim a reservation.
      const result=await query<SessionRow>(`update sync_remote_sessions set connected_at=coalesce(connected_at,clock_timestamp())
        where id=$1 and owner_account_id=$2 and auth_session_id=$3 and ${ACTIVE}
        and (cli_protocol_version is null or (cli_protocol_version=$4 and purpose=$5
          and authorization_grant_id=$6 and host_endpoint_id=$7))
        and exists(select 1 from sync_auth_sessions where id=$3 and expires_at>clock_timestamp()) returning *`,
        [snapshot.id,snapshot.ownerAccountId,snapshot.authSessionId,snapshot.cliProtocolVersion ?? null,snapshot.purpose ?? 'screen',
         snapshot.authorizationGrantId ?? null,snapshot.hostEndpointId]);
      const row=result.rows[0];
      if(!row || !install(mapSession(row))) throw new ForbiddenException('Session closed during controller installation');
      return mapSession(row);
    });
  }

  async bindHostEndpoint(snapshot:RemoteSession,endpointId:string,isCurrent:()=>boolean):Promise<RemoteSession|undefined> {
    return this.db.transaction(async(query)=>{
      if(snapshot.cliProtocolVersion!==undefined || snapshot.purpose==='cli') {
        await this.lockAuthorization(query,{ownerAccountId:snapshot.ownerAccountId,hostId:snapshot.hostId,
          authSessionId:snapshot.authSessionId,controllerKind:snapshot.controllerKind,
          controllerDeviceId:snapshot.controllerDeviceId ?? undefined,scope:snapshot.scope,
          authorizationGrantId:snapshot.authorizationGrantId ?? undefined,purpose:snapshot.purpose,
          cliProtocolVersion:snapshot.cliProtocolVersion,protocolVersion:snapshot.protocolVersion,
          hostEndpointId:snapshot.hostEndpointId ?? undefined});
      }
      await query(`select id from sync_remote_sessions where id=$1 for update`,[snapshot.id]);
      // Adopt legacy/null bindings on resume; a superseded registration must never reclaim a newer endpoint.
      if(!isCurrent()) return undefined;
      const result=await query<SessionRow>(`update sync_remote_sessions set host_endpoint_id=$2
        where id=$1 and owner_account_id=$3 and host_device_id=$4 and ${ACTIVE}
        and (cli_protocol_version is null or (host_endpoint_id=$2 and cli_protocol_version=$5
          and purpose=$6 and authorization_grant_id=$7)) returning *`,
        [snapshot.id,endpointId,snapshot.ownerAccountId,snapshot.hostId,snapshot.cliProtocolVersion ?? null,
         snapshot.purpose ?? 'screen',snapshot.authorizationGrantId ?? null]);
      return result.rows[0] ? mapSession(result.rows[0]) : undefined;
    });
  }

  async listOwned(ownerAccountId: string): Promise<RemoteSession[]> {
    const result = await this.db.query<SessionRow>(
      `select * from sync_remote_sessions where owner_account_id=$1 and ${ACTIVE}
       order by created_at desc limit 200`, [ownerAccountId]);
    return result.rows.map(mapSession);
  }
  async findOwned(ownerAccountId: string, id: string): Promise<RemoteSession | undefined> {
    const result = await this.db.query<SessionRow>('select * from sync_remote_sessions where id=$1 and owner_account_id=$2', [id,ownerAccountId]);
    return result.rows[0] ? mapSession(result.rows[0]) : undefined;
  }
  async findActive(id: string): Promise<RemoteSession | undefined> {
    const result = await this.db.query<SessionRow>(
      `select * from sync_remote_sessions where id=$1 and ${ACTIVE}`, [id]);
    return result.rows[0] ? mapSession(result.rows[0]) : undefined;
  }
  async findActiveForHost(hostId: string): Promise<RemoteSession[]> {
    const result = await this.db.query<SessionRow>(
      `select * from sync_remote_sessions where host_device_id=$1 and ${ACTIVE}`, [hostId]);
    return result.rows.map(mapSession);
  }
  async endWhere(where: string, params: readonly unknown[], reason: string): Promise<RemoteSession[]> {
    return this.db.transaction(async (query) => {
      if (!RECOVERABLE_REASONS.includes(reason)) {
        await query(`update sync_remote_sessions set recovery_consumed=true,activity_token_hash=null
          where (${where}) and not recovery_consumed`, params);
      }
      const result = await query<SessionRow>(
        `update sync_remote_sessions set ended_at=clock_timestamp(), end_reason=$${params.length + 1}
         where ended_at is null and (${where}) returning *`, [...params,reason]);
      return result.rows.map(mapSession);
    });
  }

  async activity(ownerId:string, authId:string, id:string, tokenHash:string, idleSeconds:number):Promise<RemoteSession|undefined> {
    return this.db.transaction(async (query) => {
      await query(`select id from sync_remote_sessions where id=$1 and owner_account_id=$2
        and auth_session_id=$3 and activity_token_hash=$4 for update`,[id,ownerId,authId,tokenHash]);
      const result = await query<SessionRow>(
        `update sync_remote_sessions set last_activity_at=clock_timestamp(),
         idle_deadline=least(expires_at,clock_timestamp()+($5 * interval '1 second'))
         where id=$1 and owner_account_id=$2 and auth_session_id=$3 and activity_token_hash=$4
         and controller_kind='browser' and not recovery_consumed and ${ACTIVE} returning *`,
        [id,ownerId,authId,tokenHash,idleSeconds]);
      return result.rows[0] ? mapSession(result.rows[0]) : undefined;
    });
  }

  async recover(input:{ownerId:string;authId:string;id:string;tokenHash:string;newTokenHash:string;
    runtimeNamespace:string;signalingInstanceId:string;hostEndpointId:string;features:EndpointFeatures;connectionTimeoutSeconds?:number}):Promise<RemoteSession> {
    return this.db.transaction(async (query) => {
      const preview=await query<SessionRow>(`select * from sync_remote_sessions where id=$1 and owner_account_id=$2
        and auth_session_id=$3 and controller_kind='browser'`,[input.id,input.ownerId,input.authId]);
      const authority=preview.rows[0];
      if(!authority) throw new ForbiddenException('Browser recovery is invalid or expired');
      await this.lockAuthorization(query,{ownerAccountId:input.ownerId,authSessionId:input.authId,controllerKind:'browser',
        hostId:authority.host_device_id,scope:authority.scope});
      const selected = await query<SessionRow>(`select * from sync_remote_sessions where id=$1 and owner_account_id=$2
        and auth_session_id=$3 for update`,[input.id,input.ownerId,input.authId]);
      const old = selected.rows[0];
      // Evaluate time after acquiring the lock, never at transaction start.
      const eligible = await query(`select 1 from sync_remote_sessions where id=$1 and controller_kind='browser'
        and activity_token_hash=$2 and not recovery_consumed and idle_deadline>clock_timestamp()
        and expires_at>clock_timestamp() and (connected_at is not null or connection_deadline is null or connection_deadline>clock_timestamp())
        and (ended_at is null or end_reason=any($3::text[]))`,
        [input.id,input.tokenHash,RECOVERABLE_REASONS]);
      if (!old || !eligible.rowCount || old.protocol_version > input.features.protocolVersion ||
        old.capabilities.some((capability) => !input.features.capabilities.includes(capability))) {
        throw new ForbiddenException('Browser recovery is invalid, expired, or already consumed');
      }
      await query(`update sync_remote_sessions set recovery_consumed=true,activity_token_hash=null,
        ended_at=coalesce(ended_at,clock_timestamp()),end_reason=coalesce(end_reason,'recovered') where id=$1`,[input.id]);
      return this.create({ownerAccountId:old.owner_account_id,hostId:old.host_device_id,controllerKind:'browser',
        scope:old.scope,epoch:old.mode_epoch,authSessionId:old.auth_session_id,expiresAt:old.expires_at,
        protocolVersion:old.protocol_version,capabilities:old.capabilities,hostEndpointId:input.hostEndpointId,
        runtimeNamespace:input.runtimeNamespace,signalingInstanceId:input.signalingInstanceId,
        activityTokenHash:input.newTokenHash,connectionTimeoutSeconds:input.connectionTimeoutSeconds},query,old);
    });
  }
}

function mapSession(row: SessionRow): RemoteSession {
  return { id:row.id, ownerAccountId:row.owner_account_id, hostId:row.host_device_id,
    controllerDeviceId:row.controller_device_id, controllerId:row.controller_device_id ?? 'browser', controllerKind:row.controller_kind,
    scope:row.scope, epoch:row.mode_epoch, authSessionId:row.auth_session_id, createdAt:row.created_at.toISOString(),
    expiresAt:row.expires_at.toISOString(), endedAt:row.ended_at?.toISOString() ?? null, endReason:row.end_reason,
    runtimeNamespace:row.runtime_namespace,signalingInstanceId:row.signaling_instance_id,
    protocolVersion:row.protocol_version ?? 1,capabilities:row.capabilities ?? [],hostEndpointId:row.host_endpoint_id ?? null,
    purpose:row.purpose ?? 'screen',...(row.cli_protocol_version==null?{}:{cliProtocolVersion:row.cli_protocol_version}),
    lastActivityAt:row.last_activity_at?.toISOString() ?? null,idleDeadline:row.idle_deadline?.toISOString() ?? null,
    authorizationGrantId:row.authorization_grant_id ?? null,connectionDeadline:row.connection_deadline?.toISOString() ?? null,
    connectedAt:row.connected_at?.toISOString() ?? null };
}
