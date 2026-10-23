// Carga y valida la configuración. Si algo falta, explica qué hacer y se detiene.
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') }); // funciona sin importar desde dónde ejecutes npm
const env = process.env;
const fail = m => { console.error('\n❌ Configuración: ' + m + '\n'); process.exit(1); };

if (!env.DATABASE_URL) fail('Falta DATABASE_URL. Copia .env.example a .env (junto a package.json) y pega tu cadena de Supabase.');
if (/TU_CLAVE|xxxx|\[YOUR-PASSWORD\]/i.test(env.DATABASE_URL)) fail('DATABASE_URL aún tiene los valores de ejemplo. Pega tu cadena real de Supabase.');
if (!env.JWT_SECRET || env.JWT_SECRET.length < 16) fail('JWT_SECRET falta o es muy corto. Genera uno con: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"');

let host = '';
try { host = new URL(env.DATABASE_URL).hostname; }
catch { fail('DATABASE_URL no es una URL válida. Si la contraseña tiene @ # / : o ?, cámbiala por una solo con letras y números.'); }
const local = ['localhost', '127.0.0.1'].includes(host);

module.exports = {
  port: env.PORT || 3000,
  databaseUrl: env.DATABASE_URL,
  dbHost: host,
  ssl: env.DB_SSL ? env.DB_SSL === 'true' : !local,
  jwtSecret: env.JWT_SECRET,
  frontendUrl: env.FRONTEND_URL || 'http://localhost:4200',
  adminEmail: (env.ADMIN_EMAIL || 'admin@tienda.com').toLowerCase(),
  adminPassword: env.ADMIN_PASSWORD || 'Admin123!',
};
