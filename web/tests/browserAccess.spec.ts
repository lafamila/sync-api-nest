import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { BrowserAccess } from "../src/browserAccess";
import { decodeWire, validateWire, SYNC_SCHEMA_HASH } from "../src/generated/sync-wire";
import type { ConnectResponse, PublicConfig } from "../src/types";

const golden = JSON.parse(readFileSync(new URL("./fixtures/sync-golden.json",import.meta.url),"utf8"));
const config = decodeWire<PublicConfig>("WirePublicConfig",golden.valid.find((f: {name: string})=>f.name === "public-config").value);
const response = (): ConnectResponse => structuredClone(golden.valid.find((f: {name: string})=>f.name === "browser-connect").value);
const now = Date.parse(response().webAccess!.serverNow);

test("web consumes the shared schema hash, all DTO fixtures, UTF8 keys and optional defaults", () => {
  expect(golden.schemaHash).toBe(SYNC_SCHEMA_HASH);
  for (const kind of ["valid","invalid"]) for (const fixture of golden[kind]) expect(validateWire(fixture.model,fixture.value),fixture.name).toBe(kind === "valid");
  const legacy = decodeWire<PublicConfig>("WirePublicConfig",{});
  expect(legacy.protocolVersion).toBe(1);
  expect(legacy.capabilities).toEqual([]);
  expect(legacy.features).toEqual({displaySelection:false,browserIdle:false,browserRecovery:false});
});

test("server clock offset owns expiry and late activity can never revive access", () => {
  const clock = now-600000;
  const lease = new BrowserAccess(config,response(),clock);
  const remaining = Date.parse(response().webAccess!.idleDeadline)-now;
  expect(lease.expired(clock+remaining-1)).toBe(false);
  expect(lease.expired(clock+remaining)).toBe(true);
  expect(lease.recordActivity(clock+remaining)).toBeNull();
  expect(lease.finishActivity({serverNow:new Date(now+remaining).toISOString(),lastActivityAt:new Date(now+remaining).toISOString(),idleDeadline:new Date(now+remaining+900000).toISOString()},clock+remaining)).toBe(false);
  expect(lease.takeRecoveryToken(clock+remaining)).toBeNull();
});

test("only actual reported activity extends a lease; cadence and pending requests are bounded", () => {
  const lease = new BrowserAccess(config,response(),now);
  expect(lease.recordActivity(now+1)).toBe(response().webAccess!.activityToken);
  expect(lease.recordActivity(now+6000)).toBeNull();
  expect(lease.finishActivity(undefined,now+6000)).toBe(true);
  expect(lease.recordActivity(now+6001)).toBe(response().webAccess!.activityToken);
  const later = {serverNow:new Date(now+6001).toISOString(),lastActivityAt:new Date(now+6001).toISOString(),idleDeadline:new Date(now+906001).toISOString()};
  expect(lease.finishActivity(later,now+6001)).toBe(true);
  expect(lease.expired(now+906000)).toBe(false);
  expect(lease.expired(now+906001)).toBe(true);
});

test("one-use recovery rotates authority without resetting idle or absolute deadlines", () => {
  const initial=response();
  const lease=new BrowserAccess(config,initial,now);
  expect(lease.takeRecoveryToken(now+1)).toBe(initial.webAccess!.activityToken);
  expect(lease.takeRecoveryToken(now+2)).toBeNull();
  const recovered=response();
  recovered.webAccess={...recovered.webAccess!,activityToken:"public-test-rotated-authority-only",serverNow:new Date(now+1000).toISOString(),idleDeadline:new Date(now+3600000).toISOString()};
  lease.recovered(recovered,now+1000);
  expect(lease.takeRecoveryToken(now+1001)).toBe("public-test-rotated-authority-only");
  expect(lease.expired(Date.parse(initial.webAccess!.idleDeadline))).toBe(true);
  lease.clear();
  expect(lease.finishActivity(undefined,now+2)).toBe(false);
  expect(lease.takeRecoveryToken(now+2)).toBeNull();
});

test("explicit legacy response uses a local-only 15-minute lease that recovery does not reset", () => {
  const legacy=decodeWire<PublicConfig>("WirePublicConfig",{product:"Sync"});
  const result=response(); delete result.webAccess;
  const lease=new BrowserAccess(legacy,result,now);
  expect(lease.serverEnforced).toBe(false);
  expect(lease.recordActivity(now+1000)).toBeNull();
  lease.recovered(result,now+2000);
  expect(lease.expired(now+900999)).toBe(false);
  expect(lease.expired(now+901000)).toBe(true);
  expect(lease.takeRecoveryToken(now+2001)).toBeNull();
});

test("invalid recovered expiry cannot turn deadline comparisons into a NaN bypass", () => {
  const lease=new BrowserAccess(config,response(),now);
  const result=response();result.session.expiresAt='invalid';
  expect(()=>lease.recovered(result,now+1)).toThrow('Invalid recovered session expiry');
  expect(lease.expired(Date.parse(response().webAccess!.idleDeadline))).toBe(true);
});

test("monotonic absolute expiry cannot be extended by wall rollback, activity or recovery", () => {
  let tick=1000;
  const initial=response();
  initial.session.expiresAt=new Date(now+30000).toISOString();
  const lease=new BrowserAccess(config,initial,now,()=>tick);
  tick+=20000;
  const recovered=structuredClone(initial);
  recovered.session.expiresAt=new Date(now+3600000).toISOString();
  recovered.webAccess!.serverNow=new Date(now+20000).toISOString();
  lease.recovered(recovered,now-3600000);
  tick+=10001;
  expect(lease.expired(now-3600000)).toBe(true);
  expect(lease.recordActivity(now-3600000)).toBeNull();
  expect(lease.takeRecoveryToken(now-3600000)).toBeNull();
});

test("monotonic idle deadline also remains terminal after a suspended wall clock rolls back", () => {
  let tick=0;
  const initial=response();
  const lease=new BrowserAccess(config,initial,now,()=>tick);
  tick=Date.parse(initial.webAccess!.idleDeadline)-now+1;
  expect(lease.expired(now-3600000)).toBe(true);
  expect(lease.finishActivity({serverNow:new Date(now).toISOString(),lastActivityAt:new Date(now).toISOString(),idleDeadline:new Date(now+900000).toISOString()},now-3600000)).toBe(false);
});
