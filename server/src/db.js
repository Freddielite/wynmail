import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let impl;

if (process.env.USE_PGLITE === '1') {
  const { PGlite } = await import('@electric-sql/pglite');
  const lite = new PGlite(process.env.PGLITE_DIR || undefined);
  impl = { query: (text, params = []) => lite.query(text, params), exec: (sql) => lite.exec(sql) };
} else {
  const pg = (await import('pg')).default;
  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.PGSSL === 'disable' ? false
      : process.env.PG_SSL_CA ? { ca: fs.readFileSync(process.env.PG_SSL_CA, 'utf8'), rejectUnauthorized: true }
      : { rejectUnauthorized: false },
    max: Number(process.env.PG_POOL_MAX || 5)
  });
  impl = { query: (text, params = []) => pool.query(text, params), exec: (sql) => pool.query(sql) };
}

export const query = impl.query;
export const one = async (text, params) => (await impl.query(text, params)).rows[0] || null;
export const many = async (text, params) => (await impl.query(text, params)).rows;

export async function migrate() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await impl.exec(sql);
}
