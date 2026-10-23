const { Router } = require('express'), { query, tx } = require('../db'), { wrap, bad } = require('../middleware/errors'), { requireAuth } = require('../middleware/auth');
const STATUSES = ['pendiente', 'pagado', 'enviado', 'entregado', 'cancelado'];

const withItems = async orders => {
  if (!orders.length) return orders;
  const items = await query('select order_id,name,price,qty from order_items where order_id=any($1)', [orders.map(o => o.id)]);
  for (const o of orders) o.items = items.filter(i => i.order_id === o.id);
  return orders;
};

// Cliente
const customer = Router();
customer.use(requireAuth);
customer.post('/', wrap(async (req, res) => {
  const { items, customer: name, phone, city, address, notes } = req.body;
  if (!Array.isArray(items) || !items.length || !name || !phone || !city || !address) throw bad('Datos incompletos');
  const orderId = await tx(async q => {
    const [o] = await q('insert into orders(user_id,customer,phone,city,address,notes) values($1,$2,$3,$4,$5,$6) returning id',
      [req.user.id, name, phone, city, address, notes || '']);
    let total = 0;
    for (const it of items) {
      const qty = parseInt(it.qty);
      const [p] = await q('select * from products where id=$1 and active for update', [it.productId]);
      if (!p || !(qty > 0) || p.stock < qty) throw bad('Stock insuficiente: ' + (p ? p.name : 'producto'));
      await q('update products set stock=stock-$1 where id=$2', [qty, p.id]);
      await q('insert into order_items(order_id,product_id,name,price,cost,qty) values($1,$2,$3,$4,$5,$6)', [o.id, p.id, p.name, p.price, p.cost, qty]);
      total += Number(p.price) * qty;
    }
    await q('update orders set total=$1 where id=$2', [total, o.id]);
    return o.id;
  });
  res.status(201).json({ orderId });
}));
customer.get('/mine', wrap(async (req, res) =>
  res.json(await withItems(await query('select id,total,status,created_at from orders where user_id=$1 order by id desc', [req.user.id])))));

// Admin
const manage = Router();
manage.get('/', wrap(async (req, res) => res.json(await withItems(await query('select * from orders order by id desc limit 200')))));
manage.patch('/:id', wrap(async (req, res) => {
  const s = req.body.status;
  if (!STATUSES.includes(s)) throw bad('Estado inválido');
  await tx(async q => {
    const [o] = await q('select status from orders where id=$1 for update', [req.params.id]);
    if (!o) throw bad('El pedido no existe', 404);
    if (o.status === 'cancelado') throw bad('Un pedido cancelado no se puede reabrir');
    if (s === 'cancelado') // devuelve el stock
      await q('update products p set stock=p.stock+i.qty from order_items i where i.product_id=p.id and i.order_id=$1', [req.params.id]);
    await q('update orders set status=$1 where id=$2', [s, req.params.id]);
  });
  res.json({ ok: true });
}));
module.exports = { customer, manage };
