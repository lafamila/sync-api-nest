import { Injectable, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { SyncConfigService } from '../config/config.service';
import { SCHEMA_SQL } from './schema';

export type Query = <T extends QueryResultRow = QueryResultRow>(sql: string, params?: readonly unknown[]) => Promise<QueryResult<T>>;

@Injectable()
export class DatabaseService implements OnModuleInit, OnApplicationShutdown {
  private readonly pool: Pool;

  constructor(private readonly config: SyncConfigService) {
    this.pool = new Pool({
      connectionString: config.config.databaseUrl,
      ssl: config.config.databaseSsl ? { rejectUnauthorized: false } : undefined,
      max: 10,
    });
  }

  async onModuleInit(): Promise<void> {
    if (this.config.config.autoMigrate) await this.migrate();
    else await this.ping();
  }

  query<T extends QueryResultRow = QueryResultRow>(sql: string, params: readonly unknown[] = []): Promise<QueryResult<T>> {
    return this.pool.query<T>(sql, [...params]);
  }

  async transaction<T>(work: (query: Query) => Promise<T>): Promise<T> {
    const client: PoolClient = await this.pool.connect();
    const query: Query = (sql, params = []) => client.query(sql, [...params]);
    try {
      await client.query('begin');
      const result = await work(query);
      await client.query('commit');
      return result;
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }

  async migrate(): Promise<void> { await this.pool.query(SCHEMA_SQL); }
  async ping(): Promise<void> { await this.pool.query('select 1'); }
  async onApplicationShutdown(): Promise<void> { await this.pool.end(); }
}
