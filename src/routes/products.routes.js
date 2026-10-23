const { Router } = require('express'), { query, tx } = require('../db'), { wrap, bad } = require('../middleware/errors');

const VOTES_NEEDED = 2; // votos iguales necesarios para decidir (de 3 administradores)

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
manage.get('/', wrap(async (req, res) => res.json(await query(`
  select p.*,
    (select count(*) from product_votes v where v.product_id=p.id and v.vote='aprobado') approvals,
    (select count(*) from product_votes v where v.product_id=p.id and v.vote='rechazado') rejections,
    (select v.vote from product_votes v where v.product_id=p.id and v.user_id=$1) my_vote
  from products p order by p.id desc`, [req.user.id]))));
manage.post('/', wrap(async (req, res) => {
  const [p] = await query('insert into products(name,description,category,price,cost,stock,image,source_url,active) values($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id', fields(req.body));
  res.status(201).json(p);
}));
manage.put('/:id', wrap(async (req, res) => {
  await query('update products set name=$1,description=$2,category=$3,price=$4,cost=$5,stock=$6,image=$7,source_url=$8,active=$9 where id=$10', [...fields(req.body), req.params.id]);
  res.json({ ok: true });
}));

// Voto del administrador: un voto por admin y producto; el estado se calcula con los votos
manage.patch('/:id/eval', wrap(async (req, res) => {
  const vote = req.body.vote;
  if (!['aprobado', 'rechazado'].includes(vote)) throw bad('Voto inválido');
  const result = await tx(async q => {
    const [p] = await q('select id from products where id=$1', [req.params.id]);
    if (!p) throw bad('El producto no existe', 404);
    await q(`insert into product_votes(product_id,user_id,vote) values($1,$2,$3)
             on conflict (product_id,user_id) do update set vote=excluded.vote, created_at=now()`, [p.id, req.user.id, vote]);
    const [c] = await q(`select count(*) filter (where vote='aprobado') approvals,
                                count(*) filter (where vote='rechazado') rejections
                         from product_votes where product_id=$1`, [p.id]);
    const status = c.approvals >= VOTES_NEEDED && c.approvals > c.rejections ? 'aprobado'
                 : c.rejections >= VOTES_NEEDED && c.rejections > c.approvals ? 'rechazado' : 'pendiente';
    await q('update products set eval_status=$1 where id=$2', [status, p.id]);
    return { eval_status: status, approvals: c.approvals, rejections: c.rejections, my_vote: vote };
  });
  res.json(result);
}));

manage.delete('/:id', wrap(async (req, res) => { await query('delete from products where id=$1', [req.params.id]); res.json({ ok: true }); }));
module.exports = { catalog, manage };