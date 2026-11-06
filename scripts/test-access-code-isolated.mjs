import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { isolatedEnvironment } from './test-cli-chat-isolated.mjs';

try {
  const env={...isolatedEnvironment(process.env),SYNC_ACCESS_CODE_INTEGRATION_TESTS:'1'};
  const require=createRequire(import.meta.url);
  const result=spawnSync(process.execPath,[require.resolve('jest/bin/jest'),'--runInBand','--runTestsByPath',
    'test/access-code.integration.spec.ts','test/cli-chat.integration.spec.ts'],{env,stdio:'inherit',timeout:180000});
  if(result.error) throw result.error;
  process.exitCode=result.status ?? 1;
} catch(error) { console.error(error.message);process.exitCode=1; }
