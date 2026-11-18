import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { androidControlEnvironment } from './test-android-control-isolated.mjs';

const fixture={SYNC_ANDROID_CONTROL_DB_SLOT:'approved',DATABASE_URL:'postgresql://fixture:fixture@127.0.0.1:5432/sync_dev',REDIS_URL:'redis://127.0.0.1:6379'};
test('full isolated runner requires approval, refuses remote/non-test targets and disables legacy public runner',()=>{
  assert.throws(()=>androidControlEnvironment({...fixture,SYNC_ANDROID_CONTROL_DB_SLOT:undefined}),/approve/);
  assert.throws(()=>androidControlEnvironment({...fixture,SYNC_TEST_DATABASE_URL:fixture.DATABASE_URL}),/non-sync_test/);
  assert.throws(()=>androidControlEnvironment({...fixture,DATABASE_URL:'postgresql://fixture@production.invalid/sync_test'}),/non-loopback/);
  assert.throws(()=>androidControlEnvironment({...fixture,REDIS_URL:'redis://production.invalid'}),/non-loopback/);
  const env=androidControlEnvironment({...fixture,SYNC_INTEGRATION_TESTS:'1'});
  assert.equal(new URL(env.SYNC_TEST_DATABASE_URL).pathname,'/sync_test');
  assert.equal(env.SYNC_INTEGRATION_TESTS,'0');assert.equal(env.SYNC_ISOLATED_INTEGRATION_TESTS,'1');
  for(const flag of ['SYNC_CLI_CHAT_INTEGRATION_TESTS','SYNC_ACCESS_CODE_INTEGRATION_TESTS','SYNC_ANDROID_CONTROL_INTEGRATION_TESTS']) assert.equal(env[flag],'1');
});
test('full integration suite contains no public truncation and forces fresh schema on both pools',async()=>{
  const source=await readFile(new URL('../test/integration.spec.ts',import.meta.url),'utf8');
  assert.doesNotMatch(source,/truncate\s/i);
  assert.match(source,/search_path=pg_catalog/);assert.match(source,/search_path=\$\{schema\}/);
  assert.match(source,/create schema \$\{schema\}/);assert.match(source,/drop schema \$\{schema\} cascade/);
});
