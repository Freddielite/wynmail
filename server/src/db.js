import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let impl;

if (process.env.USE_PGLITE === '1') {
  const { PGlite } = await import('@electric-sql/pglite');
  const lite = new PGlite(process.env.PGLITE_DIR || undefined);
  impl = { query: (text, params = []) => lite.query(text, params), exec: (sql) => lite.exec(sql), session: async (fn) => fn({ exec: (sql) => lite.exec(sql), lock: async () => {}, unlock: async () => {} }), close: () => lite.close() };
} else {
  const pg = (await import('pg')).default;
  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.PGSSL === 'disable' ? false
      : process.env.PG_SSL_CA ? { ca: fs.readFileSync(process.env.PG_SSL_CA, 'utf8'), rejectUnauthorized: true }
      : { rejectUnauthorized: false },
    max: Number(process.env.PG_POOL_MAX || 5),
    // A traffic spike queues for a connection instead of hanging forever, and a runaway query is cut off.
    connectionTimeoutMillis: Number(process.env.PG_CONNECT_TIMEOUT_MS || 10000),
    idleTimeoutMillis: Number(process.env.PG_IDLE_TIMEOUT_MS || 30000),
    statement_timeout: Number(process.env.PG_STATEMENT_TIMEOUT_MS || 30000)
  });
  pool.on('error', (err) => console.error(JSON.stringify({ level: 'error', msg: 'idle pg client error', err: err.message })));
  if (process.env.NODE_ENV === 'production' && !process.env.PG_SSL_CA && process.env.PGSSL !== 'disable') {
    console.warn('[security] PG_SSL_CA is not set: the database connection is encrypted but the server certificate is not verified.');
  }
  impl = {
    query: (text, params = []) => pool.query(text, params),
    exec: (sql) => pool.query(sql),
    // One dedicated connection, so advisory locks and transactions stay on the same session.
    session: async (fn) => {
      const client = await pool.connect();
      try {
        return await fn({
          exec: (sql) => client.query(sql),
          lock: () => client.query('SELECT pg_advisory_lock(727274)'),
          unlock: () => client.query('SELECT pg_advisory_unlock(727274)')
        });
      } finally { client.release(); }
    },
    close: () => pool.end()
  };
}

export const query = impl.query;
export const one = async (text, params) => (await impl.query(text, params)).rows[0] || null;
export const many = async (text, params) => (await impl.query(text, params)).rows;

export const closeDb = () => impl.close();

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');
const splitStatements = (sql) => sql.split(/;\s*(?:\r?\n|$)/).map((x) => x.replace(/^(\s*--.*\n)+/g, '').trim()).filter(Boolean);
const migrationFiles = (dir) => fs.existsSync(MIGRATIONS_DIR)
  ? fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(`.${dir}.sql`)).sort().map((f) => ({ id: f.replace(`.${dir}.sql`, ''), file: path.join(MIGRATIONS_DIR, f) }))
  : [];

// A file whose first line is "-- no-transaction" runs one statement at a time (needed for CREATE INDEX CONCURRENTLY).
async function runFile(conn, file) {
  const sql = fs.readFileSync(file, 'utf8');
  if (/^--\s*no-transaction/.test(sql)) { for (const st of splitStatements(sql)) await conn.exec(st); return; }
  await conn.exec('BEGIN');
  try { await conn.exec(sql); await conn.exec('COMMIT'); } catch (err) { await conn.exec('ROLLBACK').catch(() => {}); throw err; }
}

const bookkeeping = `CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`;

// Applies pending migrations in order. A lock makes two servers booting together safe.
export async function migrateUp() {
  await impl.exec(bookkeeping);
  await impl.session(async (conn) => {
    await conn.lock();
    try {
      const done = new Set((await impl.query(`SELECT id FROM schema_migrations`)).rows.map((r) => r.id));
      for (const m of migrationFiles('up')) {
        if (done.has(m.id)) continue;
        await runFile(conn, m.file);
        await impl.query(`INSERT INTO schema_migrations (id) VALUES ($1)`, [m.id]);
        console.log(JSON.stringify({ level: 'info', msg: 'migration applied', id: m.id }));
      }
    } finally { await conn.unlock(); }
  });
}

// Undoes the newest `steps` migrations using their .down.sql files.
export async function migrateDown(steps = 1) {
  await impl.exec(bookkeeping);
  await impl.session(async (conn) => {
    await conn.lock();
    try {
      const applied = (await impl.query(`SELECT id FROM schema_migrations ORDER BY id DESC LIMIT $1`, [steps])).rows;
      const downs = new Map(migrationFiles('down').map((m) => [m.id, m.file]));
      for (const { id } of applied) {
        if (!downs.has(id)) throw new Error(`No down migration for ${id}`);
        await runFile(conn, downs.get(id));
        await impl.query(`DELETE FROM schema_migrations WHERE id = $1`, [id]);
        console.log(JSON.stringify({ level: 'info', msg: 'migration rolled back', id }));
      }
    } finally { await conn.unlock(); }
  });
}

export async function migrationStatus() {
  await impl.exec(bookkeeping);
  const done = new Set((await impl.query(`SELECT id FROM schema_migrations`)).rows.map((r) => r.id));
  return migrationFiles('up').map((m) => ({ id: m.id, applied: done.has(m.id) }));
}

// schema.sql is the idempotent baseline. Everything after it lives in migrations/ and can be rolled back.
export async function migrate() {
  await impl.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  await migrateUp();
}
