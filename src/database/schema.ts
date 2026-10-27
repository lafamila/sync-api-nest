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
`;
