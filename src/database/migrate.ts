import { SyncConfigService } from '../config/config.service';
import { DatabaseService } from './database.service';

async function main(): Promise<void> {
  const database = new DatabaseService(new SyncConfigService());
  try { await database.migrate(); }
  finally { await database.onApplicationShutdown(); }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
