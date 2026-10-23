const jwt = require('jsonwebtoken'), cfg = require('../config'), { bad } = require('./errors');
const sign = u => jwt.sign({ id: u.id, role: u.role }, cfg.jwtSecret, { expiresIn: '8h' });
const requireAuth = (req, res, next) => {
  try { req.user = jwt.verify((req.headers.authorization || '').replace('Bearer ', ''), cfg.jwtSecret); next(); }
  catch { next(bad('No autenticado', 401)); }
};
const requireAdmin = (req, res, next) => req.user.role === 'admin' ? next() : next(bad('Solo administrador', 403));
module.exports = { sign, requireAuth, requireAdmin };
