const router = require('express').Router();
const { query, tx } = require('../db'), { wrap, bad } = require('../middleware/errors');
const n = v => Number(v) || 0;

// Administradores (para los selectores)
router.get('/admins', wrap(async (req, res) =>
    res.json(await query("select id,name from users where role='admin' order by name"))));

// Resumen general + saldo de cada administrador
router.get('/summary', wrap(async (req, res) => {
    const sales = "from order_items i join orders o on o.id=i.order_id where o.status";
    const [inv] = await query('select coalesce(sum(qty*unit_cost+extra_cost),0) invested from purchases');
    const [sold] = await query(`select coalesce(sum(i.price*i.qty),0) revenue, coalesce(sum(i.cost*i.qty),0) cogs ${sales} in ('pagado','entregado')`);
    const [pend] = await query(`select coalesce(sum(i.price*i.qty),0) receivable ${sales} in ('pendiente','enviado')`);
    const [stk] = await query('select coalesce(sum(stock*cost),0) inventory from products where acquired');
    const admins = await query(`
    with pc as (
      select p.product_id, c.user_id, sum(c.amount) amount
      from purchase_contributions c join purchases p on p.id = c.purchase_id group by 1, 2),
    pt as (select product_id, sum(amount) total from pc group by 1),
    pr as (
      select i.product_id, sum(i.price*i.qty) revenue, sum(i.cost*i.qty) cogs
      from order_items i join orders o on o.id = i.order_id
      where o.status in ('pagado','entregado') and i.product_id is not null group by 1)
    select u.id, u.name,
      coalesce((select sum(amount) from purchase_contributions where user_id = u.id), 0) invested,
      coalesce(sum(pc.amount / pt.total * pr.revenue), 0) entitled,
      coalesce(sum(pc.amount / pt.total * (pr.revenue - pr.cogs)), 0) profit,
      coalesce((select sum(amount) from payouts where user_id = u.id), 0) paid
    from users u
    left join pc on pc.user_id = u.id
    left join pt on pt.product_id = pc.product_id
    left join pr on pr.product_id = pc.product_id
    where u.role = 'admin'
    group by u.id, u.name order by u.name`);
    res.json({
        invested: inv.invested, revenue: sold.revenue, cogs: sold.cogs, profit: sold.revenue - sold.cogs,
        receivable: pend.receivable, inventory: stk.inventory, cash: sold.revenue - inv.invested,
        admins: admins.map(a => ({ ...a, entitled: Math.round(a.entitled), profit: Math.round(a.profit), pending: Math.round(a.entitled - a.paid) })),
    });
}));

// Compras
router.get('/purchases', wrap(async (req, res) => res.json(await query(`
  select p.id, p.product_id, pr.name product, p.qty, p.unit_cost, p.extra_cost, p.notes, p.created_at,
    p.qty*p.unit_cost+p.extra_cost total,
    coalesce(json_agg(json_build_object('user_id', u.id, 'name', u.name, 'amount', c.amount) order by u.name) filter (where u.id is not null), '[]') contributions
  from purchases p join products pr on pr.id = p.product_id
  left join purchase_contributions c on c.purchase_id = p.id left join users u on u.id = c.user_id
  group by p.id, pr.name order by p.id desc limit 200`))));

// ---- Compras: validación y ayudas compartidas
const parsePurchase = b => {
  const q = parseInt(b.qty), uc = n(b.unit_cost), ex = n(b.extra_cost);
  if (!(q > 0) || uc < 0 || ex < 0) throw bad('Cantidad y costos inválidos');
  const parts = (Array.isArray(b.contributions) ? b.contributions : [])
    .map(c => ({ user_id: parseInt(c.user_id), amount: n(c.amount) })).filter(c => c.amount > 0);
  if (!parts.length) throw bad('Indica quién puso el dinero');
  if (new Set(parts.map(c => c.user_id)).size !== parts.length) throw bad('Un administrador aparece repetido');
  const total = q * uc + ex, sum = parts.reduce((a, c) => a + c.amount, 0);
  if (Math.abs(sum - total) > 1) throw bad(`Los aportes (${sum}) deben sumar el costo total (${total})`);
  return { q, uc, ex, notes: b.notes || '', parts };
};
const checkAdmins = async (db, parts) => {
  const a = await db("select id from users where role='admin' and id = any($1)", [parts.map(c => c.user_id)]);
  if (a.length !== parts.length) throw bad('Todos los aportantes deben ser administradores');
};
const saveParts = async (db, purchaseId, parts) => {
  for (const c of parts) await db('insert into purchase_contributions(purchase_id,user_id,amount) values($1,$2,$3)', [purchaseId, c.user_id, c.amount]);
};
const refreshCost = (db, productId) => db(
  'update products set cost = (select sum(qty*unit_cost+extra_cost)/sum(qty) from purchases where product_id=$1) where id=$1', [productId]);
const stockError = e => e.code === '23514' ? bad('No se puede: ya se vendieron unidades de esta compra') : e;

router.post('/purchases', wrap(async (req, res) => {
  const { q, uc, ex, notes, parts } = parsePurchase(req.body);
  const id = await tx(async db => {
    const [p] = await db('select id, eval_status from products where id=$1 for update', [req.body.product_id]);
    if (!p) throw bad('El producto no existe', 404);
    if (p.eval_status !== 'aprobado') throw bad('Solo se pueden comprar productos aprobados');
    await checkAdmins(db, parts);
    const [row] = await db('insert into purchases(product_id,qty,unit_cost,extra_cost,notes,created_by) values($1,$2,$3,$4,$5,$6) returning id',
      [p.id, q, uc, ex, notes, req.user.id]);
    await saveParts(db, row.id, parts);
    // en la primera compra el producto queda en inventario, sin publicar
    await db('update products set active = case when acquired then active else false end, acquired = true, stock = stock + $1 where id = $2', [q, p.id]);
    await refreshCost(db, p.id);
    return row.id;
  });
  res.status(201).json({ id });
}));

router.put('/purchases/:id', wrap(async (req, res) => {
  const { q, uc, ex, notes, parts } = parsePurchase(req.body);
  await tx(async db => {
    const [old] = await db('select id, product_id, qty from purchases where id=$1 for update', [req.params.id]);
    if (!old) throw bad('La compra no existe', 404);
    await checkAdmins(db, parts);
    await db('update purchases set qty=$1, unit_cost=$2, extra_cost=$3, notes=$4 where id=$5', [q, uc, ex, notes, old.id]);
    await db('delete from purchase_contributions where purchase_id=$1', [old.id]);
    await saveParts(db, old.id, parts);
    try { await db('update products set stock = stock + $1 where id=$2', [q - old.qty, old.product_id]); } catch (e) { throw stockError(e); }
    await refreshCost(db, old.product_id);
  });
  res.json({ ok: true });
}));

router.delete('/purchases/:id', wrap(async (req, res) => {
  await tx(async db => {
    const [old] = await db('select id, product_id, qty from purchases where id=$1 for update', [req.params.id]);
    if (!old) throw bad('La compra no existe', 404);
    try { await db('update products set stock = stock - $1 where id=$2', [old.qty, old.product_id]); } catch (e) { throw stockError(e); }
    await db('delete from purchases where id=$1', [old.id]);
    const [left] = await db('select count(*) n from purchases where product_id=$1', [old.product_id]);
    if (left.n === 0) await db('update products set acquired=false, active=false, cost=0 where id=$1', [old.product_id]);
    else await refreshCost(db, old.product_id);
  });
  res.json({ ok: true });
}));

// Devoluciones a los administradores
router.get('/payouts', wrap(async (req, res) => res.json(await query(
    'select p.id, p.user_id, u.name, p.amount, p.note, p.created_at from payouts p join users u on u.id = p.user_id order by p.id desc limit 200'))));
const parsePayout = async b => {
  const amount = n(b.amount), uid = parseInt(b.user_id);
  if (!(amount > 0)) throw bad('El monto debe ser mayor a cero');
  const [u] = await query("select id from users where id=$1 and role='admin'", [uid]);
  if (!u) throw bad('Administrador no válido');
  return { amount, uid, note: b.note || '' };
};
router.post('/payouts', wrap(async (req, res) => {
  const { amount, uid, note } = await parsePayout(req.body);
  await query('insert into payouts(user_id,amount,note) values($1,$2,$3)', [uid, amount, note]);
  res.status(201).json({ ok: true });
}));
router.put('/payouts/:id', wrap(async (req, res) => {
  const { amount, uid, note } = await parsePayout(req.body);
  const r = await query('update payouts set user_id=$1, amount=$2, note=$3 where id=$4 returning id', [uid, amount, note, req.params.id]);
  if (!r.length) throw bad('La devolución no existe', 404);
  res.json({ ok: true });
}));
router.delete('/payouts/:id', wrap(async (req, res) => { await query('delete from payouts where id=$1', [req.params.id]); res.json({ ok: true }); }));
module.exports = router;