import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../database/database.service';

interface DeviceRow {
  id: string; owner_account_id: string; name: string; platform: 'macos' | 'ios';
  public_key_der: Buffer; created_at: Date; last_seen_at: Date | null; revoked_at: Date | null;
}

export interface Device {
  id: string; ownerAccountId: string; name: string; platform: 'macos' | 'ios';
  publicKeyDer: Buffer; createdAt: string; lastSeenAt: string | null;
}

interface GrantRow {
  id: string; owner_account_id: string; host_device_id: string; controller_device_id: string;
  scope: 'view' | 'control'; created_at: Date; revoked_at: Date | null;
}

export interface DeviceGrant {
  id: string; hostDeviceId: string; controllerDeviceId: string; scope: 'view' | 'control'; createdAt: string;
}

@Injectable()
export class DeviceRepository {
  constructor(private readonly db: DatabaseService) {}

  async create(ownerAccountId: string, input: { name: string; platform: 'macos' | 'ios'; publicKeyDer: Buffer }): Promise<Device> {
    const result = await this.db.query<DeviceRow>(
      `insert into sync_devices(id,owner_account_id,name,platform,public_key_der)
       values($1,$2,$3,$4,$5) returning *`,
      [randomUUID(), ownerAccountId, input.name.trim(), input.platform, input.publicKeyDer],
    );
    return mapDevice(result.rows[0]!);
  }

  async listOwned(ownerAccountId: string): Promise<Device[]> {
    const result = await this.db.query<DeviceRow>(
      `select * from sync_devices where owner_account_id=$1 and revoked_at is null order by created_at`, [ownerAccountId],
    );
    return result.rows.map(mapDevice);
  }

  async findOwned(ownerAccountId: string, id: string): Promise<Device | undefined> {
    const result = await this.db.query<DeviceRow>(
      `select * from sync_devices where id=$1 and owner_account_id=$2 and revoked_at is null`, [id, ownerAccountId],
    );
    return result.rows[0] ? mapDevice(result.rows[0]) : undefined;
  }

  async revoke(ownerAccountId: string, id: string): Promise<boolean> {
    return this.db.transaction(async (query) => {
      const result = await query(
        `update sync_devices set revoked_at=now() where id=$1 and owner_account_id=$2 and revoked_at is null returning id`,
        [id, ownerAccountId],
      );
      if (!result.rowCount) return false;
      await query(`update sync_device_grants set revoked_at=coalesce(revoked_at,now())
                   where revoked_at is null and (host_device_id=$1 or controller_device_id=$1)`, [id]);
      return true;
    });
  }

  async touch(id: string): Promise<void> {
    await this.db.query('update sync_devices set last_seen_at=now() where id=$1 and revoked_at is null', [id]);
  }

  async findGrant(ownerAccountId: string, hostId: string, controllerId: string): Promise<DeviceGrant | undefined> {
    const result = await this.db.query<GrantRow>(
      `select * from sync_device_grants where owner_account_id=$1 and host_device_id=$2
       and controller_device_id=$3 and revoked_at is null`, [ownerAccountId, hostId, controllerId],
    );
    return result.rows[0] ? mapGrant(result.rows[0]) : undefined;
  }

  async rememberGrant(ownerAccountId: string, hostId: string, controllerId: string, scope: 'view' | 'control'): Promise<DeviceGrant> {
    const result = await this.db.query<GrantRow>(
      `insert into sync_device_grants(id,owner_account_id,host_device_id,controller_device_id,scope)
       values($1,$2,$3,$4,$5)
       on conflict(host_device_id,controller_device_id) do update set
         owner_account_id=excluded.owner_account_id, scope=excluded.scope, revoked_at=null, created_at=now()
       returning *`, [randomUUID(), ownerAccountId, hostId, controllerId, scope],
    );
    return mapGrant(result.rows[0]!);
  }

  async listGrants(ownerAccountId: string, hostId: string): Promise<DeviceGrant[]> {
    const result = await this.db.query<GrantRow>(
      `select * from sync_device_grants where owner_account_id=$1 and host_device_id=$2 and revoked_at is null order by created_at`,
      [ownerAccountId, hostId],
    );
    return result.rows.map(mapGrant);
  }

  async revokeGrant(ownerAccountId: string, hostId: string, grantId: string): Promise<DeviceGrant | undefined> {
    const result = await this.db.query<GrantRow>(
      `update sync_device_grants set revoked_at=now() where id=$1 and host_device_id=$2
       and owner_account_id=$3 and revoked_at is null returning *`, [grantId, hostId, ownerAccountId],
    );
    return result.rows[0] ? mapGrant(result.rows[0]) : undefined;
  }

  async audit(ownerAccountId: string, eventType: string, input: { deviceId?: string; sessionId?: string; metadata?: Record<string, unknown> } = {}): Promise<void> {
    await this.db.query(
      `insert into sync_access_events(id,owner_account_id,device_id,session_id,event_type,metadata)
       values($1,$2,$3,$4,$5,$6::jsonb)`,
      [randomUUID(), ownerAccountId, input.deviceId ?? null, input.sessionId ?? null, eventType, JSON.stringify(input.metadata ?? {})],
    );
  }
}

function mapDevice(row: DeviceRow): Device {
  return { id: row.id, ownerAccountId: row.owner_account_id, name: row.name, platform: row.platform,
    publicKeyDer: row.public_key_der, createdAt: row.created_at.toISOString(), lastSeenAt: row.last_seen_at?.toISOString() ?? null };
}
function mapGrant(row: GrantRow): DeviceGrant {
  return { id: row.id, hostDeviceId: row.host_device_id, controllerDeviceId: row.controller_device_id,
    scope: row.scope, createdAt: row.created_at.toISOString() };
}
