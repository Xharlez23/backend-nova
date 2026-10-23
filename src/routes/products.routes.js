const { Router } = require('express'), { query } = require('../db'), { wrap, bad } = require('../middleware/errors');

// Valida y ordena los campos del producto
const fields = b => {
  if (!b.name || !String(b.name).trim()) throw bad('Falta el nombre');
  return [String(b.name).trim(), b.description || '', b.category || '',
    Math.max(0, Number(b.price) || 0), Math.max(0, Number(b.cost) || 0), Math.max(0, parseInt(b.stock) || 0),
    b.image || null, b.source_url || '', b.active !== false];
};

// Público: sin costo ni datos internos
const catalog = Router();
catalog.get('/', wrap(async (req, res) =>
  res.json(await query('select id,name,description,category,price,stock,image from products where active order by id desc'))));

// Admin (ya protegido en app.js)
const manage = Router();
manage.get('/', wrap(async (req, res) => res.json(await query('select * from products order by id desc'))));
manage.post('/', wrap(async (req, res) => {
  const [p] = await query('insert into products(name,description,category,price,cost,stock,image,source_url,active) values($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id', fields(req.body));
  res.status(201).json(p);
}));
manage.put('/:id', wrap(async (req, res) => {
  await query('update products set name=$1,description=$2,category=$3,price=$4,cost=$5,stock=$6,image=$7,source_url=$8,active=$9 where id=$10', [...fields(req.body), req.params.id]);
  res.json({ ok: true });
}));
manage.patch('/:id/eval', wrap(async (req, res) => {
  if (!['pendiente', 'aprobado', 'rechazado'].includes(req.body.eval_status)) throw bad('Estado inválido');
  await query('update products set eval_status=$1 where id=$2', [req.body.eval_status, req.params.id]);
  res.json({ ok: true });
}));
manage.delete('/:id', wrap(async (req, res) => { await query('delete from products where id=$1', [req.params.id]); res.json({ ok: true }); }));
module.exports = { catalog, manage };
