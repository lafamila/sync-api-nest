import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolatedEnvironment } from './test-cli-chat-isolated.mjs';

export function androidControlEnvironment(env) {
  if(env.SYNC_ANDROID_CONTROL_DB_SLOT!=='approved') throw new Error('Main must approve the isolated Android control DB slot first');
  return {...isolatedEnvironment({...env,SYNC_CLI_CHAT_DB_SLOT:'approved'}),SYNC_INTEGRATION_TESTS:'0',
    SYNC_ISOLATED_INTEGRATION_TESTS:'1',SYNC_ACCESS_CODE_INTEGRATION_TESTS:'1',SYNC_ANDROID_CONTROL_INTEGRATION_TESTS:'1'};
}

if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    const env=androidControlEnvironment(process.env),require=createRequire(import.meta.url);
    const result=spawnSync(process.execPath,[require.resolve('jest/bin/jest'),'--runInBand','--runTestsByPath',
      'test/integration.spec.ts','test/cli-chat.integration.spec.ts','test/access-code.integration.spec.ts','test/android-control.integration.spec.ts'],
      {env,stdio:'inherit',timeout:240000});
    if(result.error) throw result.error;
    process.exitCode=result.status ?? 1;
  } catch(error) { console.error(error.message);process.exitCode=1; }
}
