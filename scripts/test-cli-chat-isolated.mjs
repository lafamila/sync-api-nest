import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function isolatedEnvironment(env) {
  if(env.SYNC_CLI_CHAT_DB_SLOT!=='approved') throw new Error('Main must approve the isolated DB slot first');
  const raw=env.SYNC_TEST_DATABASE_URL ?? env.DATABASE_URL;
  if(!raw) throw new Error('A local test database connection is required');
  const database=new URL(raw);
  if(env.SYNC_TEST_DATABASE_URL && decodeURIComponent(database.pathname.slice(1))!=='sync_test') {
    throw new Error('Refusing a non-sync_test test database');
  }
  if(!['127.0.0.1','localhost','[::1]'].includes(database.hostname)) throw new Error('Refusing a non-loopback database');
  database.pathname='/sync_test';
  const redis=new URL(env.SYNC_TEST_REDIS_URL ?? env.REDIS_URL ?? 'redis://127.0.0.1:6379');
  if(!['127.0.0.1','localhost','[::1]'].includes(redis.hostname)) throw new Error('Refusing non-loopback Redis');
  return {...env,SYNC_TEST_DATABASE_URL:database.toString(),SYNC_TEST_REDIS_URL:redis.toString(),
    SYNC_INTEGRATION_TESTS:'0',SYNC_CLI_CHAT_INTEGRATION_TESTS:'1'};
}

if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    const env=isolatedEnvironment(process.env);
    const require=createRequire(import.meta.url);
    const result=spawnSync(process.execPath,[require.resolve('jest/bin/jest'),'--runInBand','--runTestsByPath','test/cli-chat.integration.spec.ts'],
      {env,stdio:'inherit',timeout:120000});
    if(result.error) throw result.error;
    process.exitCode=result.status ?? 1;
  } catch(error) { console.error(error.message); process.exitCode=1; }
}
