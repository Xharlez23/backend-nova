const cfg = require('./config'), db = require('./db'), app = require('./app');

db.init()
  .then(() => app.listen(cfg.port, () => console.log(`✅ API lista en http://localhost:${cfg.port}`)))
  .catch(e => {
    console.error(`\n❌ No se pudo conectar a la base de datos (${cfg.dbHost}): ${e.message}`);
    if (/SSL/i.test(e.message)) console.error(`   → SSL está ${cfg.ssl ? 'activado' : 'desactivado'}. Prueba DB_SSL=${!cfg.ssl} en .env.`);
    if (/password|authentication/i.test(e.message)) console.error('   → Revisa la contraseña dentro de DATABASE_URL.');
    if (/ENOTFOUND|ETIMEDOUT|ECONNREFUSED/i.test(e.message)) console.error('   → Revisa el host. Usa la cadena "Session pooler" de Supabase.');
    process.exit(1);
  });
