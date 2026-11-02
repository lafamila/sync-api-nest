import { NATIVE_PLATFORMS, SESSION_PLATFORMS } from '../generated/sync-wire';

export const SCHEMA_SQL = `
create table if not exists sync_schema_migrations (
  version integer primary key,
  applied_at timestamptz not null default now()
);

create table if not exists sync_auth_sessions (
  id uuid primary key,
  token_hash text not null unique,
  csrf_hash text not null,
  account_id text not null,
  account_name text not null,
  permission text not null check (permission in ('member', 'superadmin')),
  platform text not null check (platform in ('web', 'macos', 'ios')),
  access_token_encrypted text not null,
  refresh_token_encrypted text not null,
  access_token_expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  auth_checked_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz
);
create index if not exists sync_auth_sessions_account_idx on sync_auth_sessions(account_id) where revoked_at is null;

create table if not exists sync_devices (
  id uuid primary key,
  owner_account_id text not null,
  name text not null,
  platform text not null check (platform in ('macos', 'ios')),
  public_key_der bytea not null,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz,
  revoked_at timestamptz
);
create index if not exists sync_devices_owner_idx on sync_devices(owner_account_id) where revoked_at is null;

create table if not exists sync_device_grants (
  id uuid primary key,
  owner_account_id text not null,
  host_device_id uuid not null references sync_devices(id),
  controller_device_id uuid not null references sync_devices(id),
  scope text not null check (scope in ('view', 'control')),
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  unique(host_device_id, controller_device_id)
);
create index if not exists sync_device_grants_host_idx on sync_device_grants(host_device_id) where revoked_at is null;

create table if not exists sync_remote_sessions (
  id uuid primary key,
  owner_account_id text not null,
  host_device_id uuid not null references sync_devices(id),
  controller_device_id uuid references sync_devices(id),
  controller_kind text not null check (controller_kind in ('browser', 'native')),
  scope text not null check (scope in ('view', 'control')),
  mode_epoch uuid not null,
  runtime_namespace text not null default 'legacy',
  signaling_instance_id uuid not null default '00000000-0000-0000-0000-000000000000',
  auth_session_id uuid not null references sync_auth_sessions(id),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  ended_at timestamptz,
  end_reason text
);
create unique index if not exists sync_one_controller_per_host_idx
  on sync_remote_sessions(host_device_id) where ended_at is null;
create index if not exists sync_remote_sessions_owner_idx on sync_remote_sessions(owner_account_id, created_at desc);

create table if not exists sync_access_events (
  id uuid primary key,
  owner_account_id text not null,
  device_id uuid,
  session_id uuid,
  event_type text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists sync_access_events_owner_idx on sync_access_events(owner_account_id, created_at desc);

alter table sync_auth_sessions add column if not exists auth_checked_at timestamptz not null default now();
alter table sync_remote_sessions add column if not exists runtime_namespace text not null default 'legacy';
alter table sync_remote_sessions add column if not exists signaling_instance_id uuid not null default '00000000-0000-0000-0000-000000000000';

insert into sync_schema_migrations(version) values (1) on conflict do nothing;

do $$ begin
  if not exists(select 1 from sync_schema_migrations where version=2) then
    alter table sync_auth_sessions drop constraint sync_auth_sessions_platform_check;
    alter table sync_auth_sessions add constraint sync_auth_sessions_platform_check
      check (platform in (${SESSION_PLATFORMS.map((v) => `'${v}'`).join(',')}));
    alter table sync_devices drop constraint sync_devices_platform_check;
    alter table sync_devices add constraint sync_devices_platform_check
      check (platform in (${NATIVE_PLATFORMS.map((v) => `'${v}'`).join(',')}));
    alter table sync_devices add column protocol_version integer not null default 1 check(protocol_version >= 1);
    alter table sync_devices add column client_version text;
    alter table sync_devices add column capabilities jsonb not null default '[]'::jsonb;
    alter table sync_remote_sessions add column protocol_version integer not null default 1;
    alter table sync_remote_sessions add column capabilities jsonb not null default '[]'::jsonb;
    alter table sync_remote_sessions add column host_endpoint_id text;
    alter table sync_remote_sessions add column activity_token_hash text;
    alter table sync_remote_sessions add column last_activity_at timestamptz;
    alter table sync_remote_sessions add column idle_deadline timestamptz;
    alter table sync_remote_sessions add column recovery_consumed boolean not null default false;
    insert into sync_schema_migrations(version) values(2);
  end if;
end $$;

do $$ begin
  if not exists(select 1 from sync_schema_migrations where version=3) then
    alter table sync_remote_sessions add column authorization_grant_id uuid references sync_device_grants(id);
    alter table sync_remote_sessions add column connection_deadline timestamptz;
    alter table sync_remote_sessions add column connected_at timestamptz;
    create index sync_remote_sessions_unconnected_idx on sync_remote_sessions(connection_deadline)
      where ended_at is null and connected_at is null and connection_deadline is not null;
    insert into sync_schema_migrations(version) values(3);
  end if;
end $$;

do $$ begin
  if not exists(select 1 from sync_schema_migrations where version=4) then
    alter table sync_remote_sessions add column purpose text not null default 'screen'
      check(purpose in ('screen','cli'));
    alter table sync_remote_sessions add column cli_protocol_version integer
      check(cli_protocol_version is null or cli_protocol_version=1);
    alter table sync_remote_sessions add constraint sync_cli_session_consistency check(
      (purpose<>'cli' or cli_protocol_version is not null) and
      (cli_protocol_version is null or (protocol_version>=2 and controller_kind='native' and scope='control'
        and controller_device_id is not null and authorization_grant_id is not null and host_endpoint_id is not null)));
    insert into sync_schema_migrations(version) values(4);
  end if;
end $$;

do $$ begin
  if not exists(select 1 from sync_schema_migrations where version=5) then
    alter table sync_remote_sessions add column cli_chat_protocol_version integer;
    alter table sync_remote_sessions add constraint sync_cli_chat_session_consistency check(
      cli_chat_protocol_version is null or (cli_chat_protocol_version=1 and cli_protocol_version is not null
        and cli_protocol_version=1 and protocol_version>=2 and controller_kind='native' and scope='control'
        and controller_device_id is not null and controller_device_id<>host_device_id
        and authorization_grant_id is not null and host_endpoint_id is not null));
    insert into sync_schema_migrations(version) values(5);
  end if;
end $$;
`;
