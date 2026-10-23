class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const bad = (message, status = 400) => new HttpError(status, message);
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next); // captura errores async
const notFound = (req, res) => res.status(404).json({ error: 'Ruta no encontrada' });
const handler = (e, req, res, next) => {
  if (!e.status) console.error(e);
  res.status(e.status || 500).json({ error: e.status ? e.message : 'Error interno del servidor' });
};
module.exports = { HttpError, bad, wrap, notFound, handler };
