import { Pool } from 'pg';
import { loadConfig } from '../config/app-config';
import { SCHEMA_SQL } from './schema';

async function main(): Promise<void> {
  const config = loadConfig();
  const pool = new Pool({ connectionString: config.databaseUrl, ssl: config.databaseSsl ? { rejectUnauthorized: false } : undefined });
  try { await pool.query(SCHEMA_SQL); }
  finally { await pool.end(); }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
