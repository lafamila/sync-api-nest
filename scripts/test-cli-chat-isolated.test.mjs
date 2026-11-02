import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isolatedEnvironment } from './test-cli-chat-isolated.mjs';

const fixture={SYNC_CLI_CHAT_DB_SLOT:'approved',DATABASE_URL:'postgresql://fixture:fixture@127.0.0.1:5432/sync_dev',REDIS_URL:'redis://127.0.0.1:6379'};
test('isolated runner requires explicit approval and refuses non-test or nonlocal targets',()=>{
  assert.throws(()=>isolatedEnvironment({...fixture,SYNC_CLI_CHAT_DB_SLOT:undefined}),/approve/);
  assert.throws(()=>isolatedEnvironment({...fixture,SYNC_TEST_DATABASE_URL:fixture.DATABASE_URL}),/non-sync_test/);
  assert.throws(()=>isolatedEnvironment({...fixture,DATABASE_URL:'postgresql://fixture:fixture@production.invalid/sync_dev'}),/non-loopback/);
  assert.throws(()=>isolatedEnvironment({...fixture,REDIS_URL:'redis://production.invalid'}),/non-loopback/);
});
test('isolated runner overrides only the database name, disables unsafe suites and preserves credentials without printing them',()=>{
  const result=isolatedEnvironment({...fixture,SYNC_INTEGRATION_TESTS:'1'});
  assert.equal(new URL(result.SYNC_TEST_DATABASE_URL).pathname,'/sync_test');
  assert.equal(new URL(result.SYNC_TEST_DATABASE_URL).password,'fixture');
  assert.equal(result.DATABASE_URL,fixture.DATABASE_URL);
  assert.equal(result.SYNC_INTEGRATION_TESTS,'0');
  assert.equal(result.SYNC_CLI_CHAT_INTEGRATION_TESTS,'1');
});
