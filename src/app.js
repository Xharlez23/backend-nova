const express = require('express'), cors = require('cors'), cfg = require('./config');
const { requireAuth, requireAdmin } = require('./middleware/auth'), { notFound, handler } = require('./middleware/errors');
const products = require('./routes/products.routes'), orders = require('./routes/orders.routes');

const app = express();
const origins = cfg.frontendUrl.split(',').map(s => s.trim().replace(/\/+$/, ''));
app.use(cors({ origin: origins }), express.json({ limit: '6mb' }));

// Público / cliente
app.use('/api/auth', require('./routes/auth.routes'));
app.use('/api/products', products.catalog);
app.use('/api/orders', orders.customer);

// Administrador: autenticación + rol aplicados una sola vez
app.use('/api/admin', requireAuth, requireAdmin);
app.use('/api/admin/products', products.manage);
app.use('/api/admin/orders', orders.manage);
app.use('/api/admin', require('./routes/reports.routes'));

app.use(notFound, handler);
module.exports = app;
