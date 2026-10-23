// Conexión a PostgreSQL (Supabase), helpers de consulta/transacción e inicialización.
const fs = require('fs'), path = require('path'), bcrypt = require('bcryptjs'), { Pool, types } = require('pg'), cfg = require('./config');
types.setTypeParser(1700, parseFloat); // numeric → number
types.setTypeParser(20, parseInt);     // bigint (count) → number

const pool = new Pool({ connectionString: cfg.databaseUrl, ssl: cfg.ssl ? { rejectUnauthorized: false } : false });

const query = (text, params) => pool.query(text, params).then(r => r.rows);

// Ejecuta fn dentro de una transacción; si lanza error, hace rollback.
async function tx(fn) {
  const c = await pool.connect();
  try {
    await c.query('begin');
    const result = await fn((text, params) => c.query(text, params).then(r => r.rows));
    await c.query('commit');
    return result;
  } catch (e) { await c.query('rollback'); throw e; }
  finally { c.release(); }
}

// Crea las tablas y el administrador inicial si no existen.
async function init() {
  await pool.query(fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8'));
  const admins = await query("select 1 from users where role='admin'");
  if (!admins.length)
    await query('insert into users(name,email,password,role) values($1,$2,$3,$4)',
      ['Admin', cfg.adminEmail, bcrypt.hashSync(cfg.adminPassword, 10), 'admin']);
}
module.exports = { pool, query, tx, init };
