const { Pool } = require('pg');

const TABLES = new Set([
  'portal_settings', 'portal_issue_reports', 'announcements', 'push_subscriptions',
  'emby_accounts', 'silo_accounts', 'library_requests', 'my_books',
  'shelfmark_downloads', 'reading_progress',
]);

function quoteIdentifier(value) {
  if (!/^[a-z_][a-z0-9_]*$/i.test(value)) throw new Error(`Invalid database identifier: ${value}`);
  return `"${value}"`;
}

function quoteLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function normaliseTable(table) {
  if (!TABLES.has(table)) throw new Error(`Unknown Portal table: ${table}`);
  return table;
}

class QueryBuilder {
  constructor(pool, table) {
    this.pool = pool; this.table = normaliseTable(table); this.operation = 'select';
    this.columns = '*'; this.filters = []; this.orders = []; this.limitValue = null;
    this.offsetValue = null; this.payload = null; this.returnRows = false;
    this.conflictColumns = []; this.singleMode = null; this.countMode = false;
  }
  select(columns = '*', options = {}) {
    this.columns = columns || '*'; this.returnRows = true;
    if (options.count) this.countMode = options.count;
    return this;
  }
  insert(payload) { this.operation = 'insert'; this.payload = payload; return this; }
  upsert(payload, options = {}) {
    this.operation = 'upsert'; this.payload = payload;
    this.conflictColumns = String(options.onConflict || '').split(',').map(x => x.trim()).filter(Boolean);
    return this;
  }
  update(payload) { this.operation = 'update'; this.payload = payload; return this; }
  delete() { this.operation = 'delete'; return this; }
  eq(column, value) { return this.filter(column, '=', value); }
  neq(column, value) { return this.filter(column, '<>', value); }
  gt(column, value) { return this.filter(column, '>', value); }
  gte(column, value) { return this.filter(column, '>=', value); }
  lt(column, value) { return this.filter(column, '<', value); }
  lte(column, value) { return this.filter(column, '<=', value); }
  ilike(column, value) { return this.filter(column, 'ILIKE', value); }
  is(column, value) { return this.filter(column, value === null ? 'IS NULL' : 'IS NOT NULL', value); }
  in(column, values) { this.filters.push({ column, operator: 'IN', value: Array.isArray(values) ? values : [] }); return this; }
  not(column, operator, value) {
    const op = String(operator || '').toLowerCase();
    const inverse = {
      eq: '<>', neq: '=', gt: '<=', gte: '<', lt: '>=', lte: '>',
      like: 'NOT LIKE', ilike: 'NOT ILIKE', in: 'NOT IN',
    }[op] || (op === 'is' ? (value === null ? 'IS NOT NULL' : 'IS NULL') : null);
    if (!inverse) throw new Error(`Unsupported negated filter: ${operator}`);
    if (inverse === 'IS NULL' || inverse === 'IS NOT NULL') return this.filter(column, inverse, value);
    return this.filter(column, inverse, op === 'in' ? (Array.isArray(value) ? value : []) : value);
  }
  filter(column, operator, value) { this.filters.push({ column, operator, value }); return this; }
  order(column, options = {}) { this.orders.push({ column, ascending: options.ascending !== false }); return this; }
  limit(value) { this.limitValue = Number(value); return this; }
  range(from, to) { this.offsetValue = Number(from); this.limitValue = Number(to) - Number(from) + 1; return this; }
  single() { this.singleMode = 'single'; return this; }
  maybeSingle() { this.singleMode = 'maybeSingle'; return this; }
  then(resolve, reject) { return this.execute().then(resolve, reject); }
  catch(reject) { return this.execute().catch(reject); }

  fieldExpression(column) {
    const name = quoteIdentifier(column);
    return column === 'id' || column === 'created_at' || column === 'updated_at'
      ? `r.${name}` : `(r.data->>${quoteLiteral(column)})`;
  }
  buildWhere(params) {
    const clauses = [];
    for (const item of this.filters) {
      const field = this.fieldExpression(item.column);
      if (item.operator === 'IS NULL' || item.operator === 'IS NOT NULL') clauses.push(`${field} ${item.operator}`);
      else if (item.operator === 'IN' || item.operator === 'NOT IN') {
        const values = Array.isArray(item.value) ? item.value : [];
        if (!values.length) {
          clauses.push(item.operator === 'IN' ? 'FALSE' : 'TRUE');
          continue;
        }
        const marks = values.map(value => { params.push(String(value)); return `${params.length}`; });
        clauses.push(`${field} ${item.operator} (${marks.join(',')})`);
      } else {
        params.push(item.value == null ? null : String(item.value));
        clauses.push(item.operator === 'ILIKE' ? `${field} ILIKE $${params.length}` : `${field} ${item.operator} $${params.length}`);
      }
    }
    return clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  }
  rowExpression(alias = 'r') {
    const prefix = alias ? `${alias}.` : '';
    return `${prefix}data || jsonb_build_object('id', ${prefix}id, 'created_at', ${prefix}created_at, 'updated_at', ${prefix}updated_at)`;
  }
  async execute() {
    const params = []; const table = quoteIdentifier(this.table);
    try {
      if (this.operation === 'select') {
        const where = this.buildWhere(params);
        const order = this.orders.map(item => `${this.fieldExpression(item.column)} ${item.ascending ? 'ASC' : 'DESC'}`).join(', ');
        const paging = `${this.limitValue != null ? ` LIMIT ${Math.max(0, this.limitValue)}` : ''}${this.offsetValue != null ? ` OFFSET ${Math.max(0, this.offsetValue)}` : ''}`;
        const sql = `SELECT ${this.rowExpression()} AS row FROM ${table} r ${where}${order ? ` ORDER BY ${order}` : ''}${paging}`;
        const result = await this.pool.query(sql, params);
        const rows = result.rows.map(item => item.row);
        const data = this.singleMode === 'single' ? (rows[0] || null) : this.singleMode === 'maybeSingle' ? (rows[0] || null) : rows;
        return { data, error: null, count: this.countMode ? rows.length : null };
      }
      const records = Array.isArray(this.payload) ? this.payload : [this.payload || {}];
      if (this.operation === 'insert') {
        const inserted = [];
        for (const record of records) {
          const result = await this.pool.query(`INSERT INTO ${table} (data) VALUES ($1::jsonb) RETURNING ${this.rowExpression('')} AS row`, [JSON.stringify(record)]);
          inserted.push(result.rows[0].row);
        }
        return { data: this.returnRows ? (Array.isArray(this.payload) ? inserted : inserted[0]) : null, error: null };
      }
      if (this.operation === 'upsert') {
        const saved = [];
        for (const record of records) {
          const params2 = [JSON.stringify(record)];
          const match = this.conflictColumns.length ? this.conflictColumns.map(column => { params2.push(String(record[column] ?? '')); return `${this.fieldExpression(column)} = $${params2.length}`; }) : [];
          const where = match.length ? `WHERE ${match.join(' AND ')}` : 'WHERE false';
          const found = await this.pool.query(`SELECT r.id FROM ${table} r ${where} LIMIT 1`, params2);
          if (found.rows[0]) {
            const result = await this.pool.query(`UPDATE ${table} r SET data = r.data || $1::jsonb, updated_at = now() WHERE r.id = $${params2.length + 1} RETURNING ${this.rowExpression('')} AS row`, [JSON.stringify(record), found.rows[0].id]);
            saved.push(result.rows[0].row);
          } else {
            const result = await this.pool.query(`INSERT INTO ${table} (data) VALUES ($1::jsonb) RETURNING ${this.rowExpression()} AS row`, [JSON.stringify(record)]);
            saved.push(result.rows[0].row);
          }
        }
        return { data: this.returnRows ? (Array.isArray(this.payload) ? saved : saved[0]) : null, error: null };
      }
      const where = this.buildWhere(params);
      if (this.operation === 'update') {
        params.push(JSON.stringify(this.payload || {}));
        const result = await this.pool.query(`UPDATE ${table} r SET data = r.data || $${params.length}::jsonb, updated_at = now() ${where} RETURNING ${this.rowExpression()} AS row`, params);
        return { data: this.returnRows ? result.rows.map(item => item.row) : null, error: null };
      }
      if (this.operation === 'delete') {
        const result = await this.pool.query(`DELETE FROM ${table} r ${where} RETURNING ${this.rowExpression()} AS row`, params);
        return { data: this.returnRows ? result.rows.map(item => item.row) : null, error: null };
      }
      throw new Error(`Unsupported database operation: ${this.operation}`);
    } catch (error) { return { data: null, error }; }
  }
}

function createDatabase() {
  const url = String(process.env.DATABASE_URL || '').trim();
  if (!url) throw new Error('DATABASE_URL is required. Configure PostgreSQL before starting Portal.');
  const pool = new Pool({ connectionString: url, max: Number(process.env.DATABASE_POOL_MAX || 10), ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined });
  return { from: table => new QueryBuilder(pool, table), pool, close: () => pool.end() };
}

module.exports = { createDatabase };