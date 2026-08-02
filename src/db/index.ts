import { Pool, type PoolConfig } from 'pg';
import { loadEnv } from '../config/env';

export const TABLES = new Set([
  'portal_settings', 'portal_issue_reports', 'announcements', 'push_subscriptions',
  'emby_accounts', 'silo_accounts', 'library_requests', 'my_books',
  'shelfmark_downloads', 'reading_progress', 'seerr_users', 'seerr_history',
  'discord_bot_memberships',
]);

export type PortalTable = string;

export type DbResult<T = any> = {
  data: T;
  error: Error | null;
  count?: number | null;
};

function quoteIdentifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(value)) throw new Error(`Invalid database identifier: ${value}`);
  return `"${value}"`;
}

function quoteLiteral(value: string): string {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function normaliseTable(table: string): string {
  if (!TABLES.has(table)) throw new Error(`Unknown Portal table: ${table}`);
  return table;
}

type Filter = { column: string; operator: string; value: unknown };
type Order = { column: string; ascending: boolean };

export class QueryBuilder implements PromiseLike<DbResult> {
  pool: Pool;
  table: string;
  operation: 'select' | 'insert' | 'upsert' | 'update' | 'delete' = 'select';
  columns: string = '*';
  filters: Filter[] = [];
  orders: Order[] = [];
  limitValue: number | null = null;
  offsetValue: number | null = null;
  payload: any = null;
  returnRows = false;
  conflictColumns: string[] = [];
  singleMode: 'single' | 'maybeSingle' | null = null;
  countMode = false;

  constructor(pool: Pool, table: string) {
    this.pool = pool;
    this.table = normaliseTable(table);
  }

  select(columns = '*', options: { count?: boolean | string } = {}) {
    this.columns = columns || '*';
    this.returnRows = true;
    if (options.count) this.countMode = Boolean(options.count);
    return this;
  }

  insert(payload: any) { this.operation = 'insert'; this.payload = payload; return this; }
  upsert(payload: any, options: { onConflict?: string } = {}) {
    this.operation = 'upsert';
    this.payload = payload;
    this.conflictColumns = String(options.onConflict || '').split(',').map((x) => x.trim()).filter(Boolean);
    return this;
  }
  update(payload: any) { this.operation = 'update'; this.payload = payload; return this; }
  delete() { this.operation = 'delete'; return this; }
  eq(column: string, value: unknown) { return this.filter(column, '=', value); }
  neq(column: string, value: unknown) { return this.filter(column, '<>', value); }
  gt(column: string, value: unknown) { return this.filter(column, '>', value); }
  gte(column: string, value: unknown) { return this.filter(column, '>=', value); }
  lt(column: string, value: unknown) { return this.filter(column, '<', value); }
  lte(column: string, value: unknown) { return this.filter(column, '<=', value); }
  ilike(column: string, value: unknown) { return this.filter(column, 'ILIKE', value); }
  is(column: string, value: unknown) {
    return this.filter(column, value === null ? 'IS NULL' : 'IS NOT NULL', value);
  }
  in(column: string, values: unknown[]) {
    this.filters.push({ column, operator: 'IN', value: Array.isArray(values) ? values : [] });
    return this;
  }
  not(column: string, operator: string, value: unknown) {
    const op = String(operator || '').toLowerCase();
    const inverse: Record<string, string | null> = {
      eq: '<>', neq: '=', gt: '<=', gte: '<', lt: '>=', lte: '>',
      like: 'NOT LIKE', ilike: 'NOT ILIKE', in: 'NOT IN',
    };
    const mapped = inverse[op] || (op === 'is' ? (value === null ? 'IS NOT NULL' : 'IS NULL') : null);
    if (!mapped) throw new Error(`Unsupported negated filter: ${operator}`);
    if (mapped === 'IS NULL' || mapped === 'IS NOT NULL') return this.filter(column, mapped, value);
    return this.filter(column, mapped, op === 'in' ? (Array.isArray(value) ? value : []) : value);
  }
  filter(column: string, operator: string, value: unknown) {
    this.filters.push({ column, operator, value });
    return this;
  }
  order(column: string, options: { ascending?: boolean } = {}) {
    this.orders.push({ column, ascending: options.ascending !== false });
    return this;
  }
  limit(value: number) { this.limitValue = Number(value); return this; }
  range(from: number, to: number) {
    this.offsetValue = Number(from);
    this.limitValue = Number(to) - Number(from) + 1;
    return this;
  }
  single() { this.singleMode = 'single'; return this; }
  maybeSingle() { this.singleMode = 'maybeSingle'; return this; }

  then<TResult1 = DbResult, TResult2 = never>(
    resolve?: ((value: DbResult) => TResult1 | PromiseLike<TResult1>) | null,
    reject?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null,
  ) {
    return this.execute().then(resolve, reject);
  }

  catch(reject: (reason: any) => any) {
    return this.execute().catch(reject);
  }

  fieldExpression(column: string): string {
    const name = quoteIdentifier(column);
    return column === 'id' || column === 'created_at' || column === 'updated_at'
      ? `r.${name}`
      : `(r.data->>${quoteLiteral(column)})`;
  }

  buildWhere(params: unknown[]): string {
    const clauses: string[] = [];
    for (const item of this.filters) {
      const field = this.fieldExpression(item.column);
      if (item.operator === 'IS NULL' || item.operator === 'IS NOT NULL') {
        clauses.push(`${field} ${item.operator}`);
      } else if (item.operator === 'IN' || item.operator === 'NOT IN') {
        const values = Array.isArray(item.value) ? item.value : [];
        if (!values.length) {
          clauses.push(item.operator === 'IN' ? 'FALSE' : 'TRUE');
          continue;
        }
        const marks = values.map((value) => {
          params.push(String(value));
          return `$${params.length}`;
        });
        clauses.push(`${field} ${item.operator} (${marks.join(',')})`);
      } else {
        params.push(item.value == null ? null : String(item.value));
        clauses.push(
          item.operator === 'ILIKE'
            ? `${field} ILIKE $${params.length}`
            : `${field} ${item.operator} $${params.length}`,
        );
      }
    }
    return clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  }

  rowExpression(alias = 'r'): string {
    const prefix = alias ? `${alias}.` : '';
    return `${prefix}data || jsonb_build_object('id', ${prefix}id, 'created_at', ${prefix}created_at, 'updated_at', ${prefix}updated_at)`;
  }

  async execute(): Promise<DbResult> {
    const params: unknown[] = [];
    const table = quoteIdentifier(this.table);
    try {
      if (this.operation === 'select') {
        const where = this.buildWhere(params);
        const order = this.orders
          .map((item) => `${this.fieldExpression(item.column)} ${item.ascending ? 'ASC' : 'DESC'}`)
          .join(', ');
        const paging = `${this.limitValue != null ? ` LIMIT ${Math.max(0, this.limitValue)}` : ''}${
          this.offsetValue != null ? ` OFFSET ${Math.max(0, this.offsetValue)}` : ''
        }`;
        const sql = `SELECT ${this.rowExpression()} AS row FROM ${table} r ${where}${order ? ` ORDER BY ${order}` : ''}${paging}`;
        const result = await this.pool.query(sql, params);
        const rows = result.rows.map((item: { row: any }) => item.row);
        const data = this.singleMode === 'single' || this.singleMode === 'maybeSingle'
          ? (rows[0] || null)
          : rows;
        return { data, error: null, count: this.countMode ? rows.length : null };
      }

      const records = Array.isArray(this.payload) ? this.payload : [this.payload || {}];
      if (this.operation === 'insert') {
        const inserted: any[] = [];
        for (const record of records) {
          const result = await this.pool.query(
            `INSERT INTO ${table} (data) VALUES ($1::jsonb) RETURNING ${this.rowExpression('')} AS row`,
            [JSON.stringify(record)],
          );
          inserted.push(result.rows[0].row);
        }
        return { data: this.returnRows ? (Array.isArray(this.payload) ? inserted : inserted[0]) : null, error: null };
      }

      if (this.operation === 'upsert') {
        const saved: any[] = [];
        for (const record of records) {
          const params2: unknown[] = [JSON.stringify(record)];
          const match = this.conflictColumns.length
            ? this.conflictColumns.map((column) => {
              params2.push(String(record[column] ?? ''));
              return `${this.fieldExpression(column)} = $${params2.length}`;
            })
            : [];
          const where = match.length ? `WHERE ${match.join(' AND ')}` : 'WHERE false';
          const found = await this.pool.query(`SELECT r.id FROM ${table} r ${where} LIMIT 1`, params2);
          if (found.rows[0]) {
            const result = await this.pool.query(
              `UPDATE ${table} r SET data = r.data || $1::jsonb, updated_at = now() WHERE r.id = $2 RETURNING ${this.rowExpression('')} AS row`,
              [JSON.stringify(record), found.rows[0].id],
            );
            saved.push(result.rows[0].row);
          } else {
            const result = await this.pool.query(
              `INSERT INTO ${table} (data) VALUES ($1::jsonb) RETURNING ${this.rowExpression()} AS row`,
              [JSON.stringify(record)],
            );
            saved.push(result.rows[0].row);
          }
        }
        return { data: this.returnRows ? (Array.isArray(this.payload) ? saved : saved[0]) : null, error: null };
      }

      const where = this.buildWhere(params);
      if (this.operation === 'update') {
        params.push(JSON.stringify(this.payload || {}));
        const result = await this.pool.query(
          `UPDATE ${table} r SET data = r.data || $${params.length}::jsonb, updated_at = now() ${where} RETURNING ${this.rowExpression()} AS row`,
          params,
        );
        return { data: this.returnRows ? result.rows.map((item: { row: any }) => item.row) : null, error: null };
      }
      if (this.operation === 'delete') {
        const result = await this.pool.query(
          `DELETE FROM ${table} r ${where} RETURNING ${this.rowExpression()} AS row`,
          params,
        );
        return { data: this.returnRows ? result.rows.map((item: { row: any }) => item.row) : null, error: null };
      }
      throw new Error(`Unsupported database operation: ${this.operation}`);
    } catch (error: any) {
      return { data: null, error };
    }
  }
}

export type PortalDatabase = {
  from: (table: string) => QueryBuilder;
  pool: Pool;
  close: () => Promise<void>;
};

export function createDatabase(connectionString?: string): PortalDatabase {
  const env = loadEnv({ requireDatabase: false });
  const url = String(connectionString || env.DATABASE_URL || process.env.DATABASE_URL || '').trim();
  if (!url) throw new Error('DATABASE_URL is required. Configure PostgreSQL before starting Portal.');

  const poolConfig: PoolConfig = {
    connectionString: url,
    max: env.DATABASE_POOL_MAX || Number(process.env.DATABASE_POOL_MAX || 10),
  };

  const sslEnabled = String(process.env.DATABASE_SSL || '').toLowerCase() === 'true' || env.DATABASE_SSL;
  if (sslEnabled) {
    const rejectUnauthorized = String(process.env.DATABASE_SSL_REJECT_UNAUTHORIZED ?? 'true').toLowerCase() !== 'false';
    poolConfig.ssl = { rejectUnauthorized };
  }

  const pool = new Pool(poolConfig);
  return {
    from: (table: string) => new QueryBuilder(pool, table),
    pool,
    close: () => pool.end(),
  };
}
