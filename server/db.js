import crypto from 'node:crypto';
import pg from 'pg';
import bcrypt from 'bcryptjs';
import { seed } from '../src/lib/seed.js';

// Neon's default string carries channel_binding=require, which the pg driver does not need; drop it to avoid connection errors.
const url = (process.env.DATABASE_URL || '').trim().replace(/([?&])channel_binding=[^&]*&?/, '$1').replace(/[?&]$/, '');
if (!url) { console.error('DATABASE_URL is not set. Add your Neon connection string.'); process.exit(1); }

const local = /@(localhost|127\.0\.0\.1)/.test(url);
export const pool = new pg.Pool({
  connectionString: url,
  ssl: local ? false : { rejectUnauthorized: true },
  max: 8,
  idleTimeoutMillis: 20000,
  connectionTimeoutMillis: 20000
});
// Neon closes idle connections; never let that crash the process.
pool.on('error', e => console.error('pg pool error:', e.message));

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id text PRIMARY KEY, name text NOT NULL, title text NOT NULL DEFAULT '', role text NOT NULL CHECK (role IN ('admin','sales','warehouse')),
  email text NOT NULL, password_hash text NOT NULL, active boolean NOT NULL DEFAULT true,
  token_version int NOT NULL DEFAULT 0, seq bigserial
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower ON users (lower(email));
ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change boolean NOT NULL DEFAULT false;
CREATE TABLE IF NOT EXISTS company (k text PRIMARY KEY, data jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS counters (name text PRIMARY KEY, val int NOT NULL);
CREATE TABLE IF NOT EXISTS products  (id text PRIMARY KEY, data jsonb NOT NULL, seq bigserial);
CREATE TABLE IF NOT EXISTS customers (id text PRIMARY KEY, data jsonb NOT NULL, seq bigserial);
CREATE TABLE IF NOT EXISTS leads     (id text PRIMARY KEY, data jsonb NOT NULL, seq bigserial);
CREATE TABLE IF NOT EXISTS orders    (id text PRIMARY KEY, data jsonb NOT NULL, seq bigserial);
CREATE TABLE IF NOT EXISTS payments  (id text PRIMARY KEY, data jsonb NOT NULL, seq bigserial);
CREATE TABLE IF NOT EXISTS logs      (id text PRIMARY KEY, data jsonb NOT NULL, seq bigserial);
`;

const TABLES = ['products', 'customers', 'leads', 'orders', 'payments', 'logs'];

export async function tx(fn) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SELECT pg_advisory_xact_lock(7001)'); // serialise writes: stock and credit checks stay correct
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (e) {
    try { await c.query('ROLLBACK'); } catch (_) { /* connection already gone */ }
    throw e;
  } finally { c.release(); }
}

export async function put(c, table, obj) {
  await c.query(`INSERT INTO ${table} (id, data) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data`, [obj.id, obj]);
}
export async function nextId(c, prefix) {
  const r = await c.query('UPDATE counters SET val = val + 1 WHERE name = $1 RETURNING val - 1 AS n', [prefix]);
  return `${prefix}-${r.rows[0].n}`;
}
export async function addLog(c, user, action) {
  const id = await nextId(c, 'LOG');
  await put(c, 'logs', { id, ts: new Date().toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' }), user, action });
  await c.query(`DELETE FROM logs WHERE seq < (SELECT COALESCE(MAX(seq),0) - 2000 FROM logs)`);
}

const pubUser = u => ({ id: u.id, name: u.name, title: u.title, role: u.role, email: u.email, active: u.active });

// Whole-business snapshot in the exact shape the React views expect.
export async function loadState(c, me) {
  const isAdmin = me.role === 'admin';
  const q = (t, dir) => c.query(`SELECT data FROM ${t} ORDER BY seq ${dir}`).then(r => r.rows.map(x => x.data));
  const [products, customers, leads, orders, payments, users, comp, logs] = await Promise.all([
    q('products', 'DESC'), q('customers', 'ASC'), q('leads', 'DESC'), q('orders', 'DESC'), q('payments', 'DESC'),
    c.query('SELECT id,name,title,role,email,active FROM users ORDER BY seq ASC').then(r => r.rows),
    c.query(`SELECT data FROM company WHERE k='company'`).then(r => r.rows[0] ? r.rows[0].data : {}),
    isAdmin ? c.query('SELECT data FROM logs ORDER BY seq DESC LIMIT 300').then(r => r.rows.map(x => x.data)) : Promise.resolve([])
  ]);
  return {
    products, customers, leads, orders, payments, logs, company: comp, session: me.id, mustChange: !!me.must_change,
    users: users.map(u => (isAdmin ? pubUser(u) : { id: u.id, name: u.name, title: u.title, role: u.role, active: u.active }))
  };
}

const fingerprint = (email, password) => crypto.createHmac('sha256', process.env.JWT_SECRET || '').update(email.toLowerCase() + '\n' + password).digest('hex');

export async function initDb() {
  await pool.query(SCHEMA);
  const email = (process.env.ADMIN_EMAIL || '').trim();
  const password = (process.env.ADMIN_PASSWORD || '').trim();
  await tx(async c => {
    const have = await c.query('SELECT count(*)::int AS n FROM users');
    if (have.rows[0].n > 0) {
      // The ADMIN_EMAIL / ADMIN_PASSWORD values in the host settings are the source of truth for the main admin (U-1):
      // whenever they are changed, the admin login is updated to match. Password changes made inside the app
      // are kept until those two values change again. RESET_ADMIN=true forces an update on one start.
      if (email && password.length >= 8) {
        const fp = fingerprint(email, password);
        const seen = await c.query(`SELECT data FROM company WHERE k='admin_env'`);
        const force = String(process.env.RESET_ADMIN).toLowerCase() === 'true';
        if (force || !seen.rows[0] || seen.rows[0].data.fp !== fp) {
          const r = await c.query(`UPDATE users SET email=$1, password_hash=$2, active=true, token_version=token_version+1 WHERE id='U-1'`, [email, await bcrypt.hash(password, 12)]);
          await c.query(`INSERT INTO company (k,data) VALUES ('admin_env',$1) ON CONFLICT (k) DO UPDATE SET data=EXCLUDED.data`, [{ fp }]);
          console.log(r.rowCount ? 'Admin login updated from environment settings.' : 'No admin U-1 found to update.');
        }
      }
      return;
    }
    if (!email || password.length < 8) {
      throw new Error('First start: set ADMIN_EMAIL and ADMIN_PASSWORD (8+ characters) so the first admin account can be created.');
    }
    const s = seed();
    await c.query(`INSERT INTO users (id,name,title,role,email,password_hash) VALUES ('U-1',$1,'Managing Director','admin',$2,$3)`,
      [process.env.ADMIN_NAME || 'Administrator', email, await bcrypt.hash(password, 12)]);
    const co = { ...s.company };
    await c.query(`INSERT INTO company (k,data) VALUES ('company',$1)`, [co]);
    await c.query(`INSERT INTO company (k,data) VALUES ('admin_env',$1)`, [{ fp: fingerprint(email, password) }]);
    const counters = { ORD: 1001, PAY: 1, P: 101, C: 201, L: 301, U: 2, LOG: 1 };
    const demo = String(process.env.SEED_DEMO).toLowerCase() === 'true';
    if (demo) {
      Object.assign(counters, s.seq);
      for (const p of s.products.slice().reverse()) await put(c, 'products', p);
      for (const x of s.customers) await put(c, 'customers', x);
      for (const l of s.leads.slice().reverse()) await put(c, 'leads', { ...l, assignedTo: 'U-1' });
      for (const o of s.orders.slice().reverse()) await put(c, 'orders', { ...o, salesperson: 'U-1' });
      for (const p of s.payments.slice().reverse()) await put(c, 'payments', p);
    }
    for (const [name, val] of Object.entries(counters)) await c.query('INSERT INTO counters (name,val) VALUES ($1,$2)', [name, val]);
    await addLog(c, 'System', demo ? 'Database created with demo data' : 'Database created');
  });
}
export { TABLES };
