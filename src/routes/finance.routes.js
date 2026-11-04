const router = require('express').Router();
const { query, tx } = require('../db'), { wrap, bad } = require('../middleware/errors');
const n = v => Number(v) || 0;

router.get('/admins', wrap(async (req, res) =>
  res.json(await query("select id,name from users where role='admin' order by name"))));

// ---- Resumen y saldo de cada administrador
router.get('/summary', wrap(async (req, res) => {
  const sales = "from order_items i join orders o on o.id=i.order_id where o.status";
  const [inv] = await query('select coalesce(sum(amount),0) invested from purchase_contributions');
  const [sold] = await query(`select coalesce(sum(i.price*i.qty),0) revenue, coalesce(sum(i.cost*i.qty),0) cogs ${sales} in ('pagado','entregado')`);
  const [pend] = await query(`select coalesce(sum(i.price*i.qty),0) receivable ${sales} in ('pendiente','enviado')`);
  const [stk] = await query("select coalesce(sum(stock*cost),0) inventory from products where eval_status = 'inventario' and acquired");
  const admins = await query(`
    with ps as (   -- participación de cada admin en cada compra
      select c.purchase_id, c.user_id, c.amount / t.total share
      from purchase_contributions c
      join (select purchase_id, sum(amount) total from purchase_contributions group by 1) t on t.purchase_id = c.purchase_id),
    cap as (       -- capital que puso cada admin en cada producto
      select i.product_id, ps.user_id, sum(i.line_total * ps.share) amount
      from purchase_items i join ps on ps.purchase_id = i.purchase_id group by 1, 2),
    pt as (select product_id, sum(amount) total from cap group by 1),
    pr as (
      select i.product_id, sum(i.price*i.qty) revenue, sum(i.cost*i.qty) cogs
      from order_items i join orders o on o.id = i.order_id
      where o.status in ('pagado','entregado') and i.product_id is not null group by 1)
    select u.id, u.name,
      coalesce((select sum(amount) from purchase_contributions where user_id = u.id), 0) invested,
      coalesce(sum(cap.amount / nullif(pt.total, 0) * pr.revenue), 0) entitled,
      coalesce(sum(cap.amount / nullif(pt.total, 0) * (pr.revenue - pr.cogs)), 0) profit,
      coalesce((select sum(amount) from payouts where user_id = u.id), 0) paid
    from users u
    left join cap on cap.user_id = u.id
    left join pt on pt.product_id = cap.product_id
    left join pr on pr.product_id = cap.product_id
    where u.role = 'admin'
    group by u.id, u.name order by u.name`);
  res.json({
    invested: inv.invested, revenue: sold.revenue, cogs: sold.cogs, profit: sold.revenue - sold.cogs,
    receivable: pend.receivable, inventory: stk.inventory, cash: sold.revenue - inv.invested,
    admins: admins.map(a => ({ ...a, entitled: Math.round(a.entitled), profit: Math.round(a.profit), pending: Math.round(a.entitled - a.paid) })),
  });
}));

// ---- Compras (lotes con varios productos)
router.get('/purchases', wrap(async (req, res) => res.json(await query(`
  select p.id, p.notes, p.extra_cost, p.created_at,
    (select coalesce(sum(line_total), 0) from purchase_items where purchase_id = p.id) total,
    (select coalesce(json_agg(json_build_object('product_id', i.product_id, 'product', pr.name, 'qty', i.qty, 'unit_cost', i.unit_cost, 'line_total', i.line_total) order by i.id), '[]')
       from purchase_items i join products pr on pr.id = i.product_id where i.purchase_id = p.id) items,
    (select coalesce(json_agg(json_build_object('user_id', u.id, 'name', u.name, 'amount', c.amount) order by u.name), '[]')
       from purchase_contributions c join users u on u.id = c.user_id where c.purchase_id = p.id) contributions
  from purchases p order by p.id desc limit 200`))));

const parsePurchase = b => {
  const items = (Array.isArray(b.items) ? b.items : [])
    .map(i => ({ product_id: parseInt(i.product_id), qty: parseInt(i.qty), unit_cost: n(i.unit_cost) }));
  if (!items.length) throw bad('Agrega al menos un producto');
  if (items.some(i => !i.product_id || !(i.qty > 0) || i.unit_cost < 0)) throw bad('Revisa las unidades y los costos de cada producto');
  if (new Set(items.map(i => i.product_id)).size !== items.length) throw bad('Un producto aparece repetido: suma sus unidades en una sola línea');
  const extra = n(b.extra_cost);
  if (extra < 0) throw bad('El costo extra no puede ser negativo');
  const base = items.reduce((a, i) => a + i.qty * i.unit_cost, 0);
  let allocated = 0; // el costo extra se reparte según el valor de cada línea
  items.forEach((it, k) => {
    const share = k === items.length - 1 ? extra - allocated : Math.round(base ? extra * it.qty * it.unit_cost / base : extra / items.length);
    it.line_total = it.qty * it.unit_cost + share; allocated += share;
  });
  const parts = (Array.isArray(b.contributions) ? b.contributions : [])
    .map(c => ({ user_id: parseInt(c.user_id), amount: n(c.amount) })).filter(c => c.amount > 0);
  if (!parts.length) throw bad('Indica quién puso el dinero');
  if (new Set(parts.map(c => c.user_id)).size !== parts.length) throw bad('Un administrador aparece repetido');
  const total = base + extra, sum = parts.reduce((a, c) => a + c.amount, 0);
  if (Math.abs(sum - total) > 1) throw bad(`Los aportes (${sum}) deben sumar el costo total (${total})`);
  return { items, extra, notes: b.notes || '', parts };
};
const checkAdmins = async (db, parts) => {
  const a = await db("select id from users where role='admin' and id = any($1)", [parts.map(c => c.user_id)]);
  if (a.length !== parts.length) throw bad('Todos los aportantes deben ser administradores');
};
const saveParts = async (db, id, parts) => {
  for (const c of parts) await db('insert into purchase_contributions(purchase_id,user_id,amount) values($1,$2,$3)', [id, c.user_id, c.amount]);
};
const stockError = e => e.code === '23514' ? bad('No se puede: ya se vendieron unidades de esta compra') : e;

// Aplica las líneas de una compra: ajusta stock por la diferencia, estado y costo promedio de cada producto
const applyItems = async (db, purchaseId, items, oldItems) => {
  const oldQty = new Map(oldItems.map(i => [i.product_id, i.qty])), newQty = new Map(items.map(i => [i.product_id, i.qty]));
  const ids = [...new Set([...oldQty.keys(), ...newQty.keys()])];
  const prods = await db('select id, name, eval_status from products where id = any($1) order by id for update', [ids]);
  for (const it of items) {
    const p = prods.find(x => x.id === it.product_id);
    if (!p) throw bad('Un producto de la compra no existe', 404);
    if (!oldQty.has(p.id) && p.eval_status !== 'aprobado') throw bad(`"${p.name}" no está aprobado`);
  }
  await db('delete from purchase_items where purchase_id=$1', [purchaseId]);
  for (const it of items)
    await db('insert into purchase_items(purchase_id,product_id,qty,unit_cost,line_total) values($1,$2,$3,$4,$5)', [purchaseId, it.product_id, it.qty, it.unit_cost, it.line_total]);
  for (const id of ids) {
    const delta = (newQty.get(id) ?? 0) - (oldQty.get(id) ?? 0);
    try { await db('update products set stock = stock + $1 where id = $2', [delta, id]); } catch (e) { throw stockError(e); }
  }
  await db(`update products p set
      active = case when p.acquired and exists (select 1 from purchase_items i where i.product_id = p.id) then p.active else false end,
      acquired = exists (select 1 from purchase_items i where i.product_id = p.id),
      cost = coalesce((select sum(line_total) / sum(qty) from purchase_items i where i.product_id = p.id), 0)
    where p.id = any($1)`, [ids]);
};

router.post('/purchases', wrap(async (req, res) => {
  const { items, extra, notes, parts } = parsePurchase(req.body);
  const id = await tx(async db => {
    await checkAdmins(db, parts);
    const [row] = await db('insert into purchases(extra_cost,notes,created_by) values($1,$2,$3) returning id', [extra, notes, req.user.id]);
    await saveParts(db, row.id, parts);
    await applyItems(db, row.id, items, []);
    return row.id;
  });
  res.status(201).json({ id });
}));

router.put('/purchases/:id', wrap(async (req, res) => {
  const { items, extra, notes, parts } = parsePurchase(req.body);
  await tx(async db => {
    const [old] = await db('select id from purchases where id=$1 for update', [req.params.id]);
    if (!old) throw bad('La compra no existe', 404);
    const oldItems = await db('select product_id, qty from purchase_items where purchase_id=$1', [old.id]);
    await checkAdmins(db, parts);
    await db('update purchases set extra_cost=$1, notes=$2 where id=$3', [extra, notes, old.id]);
    await db('delete from purchase_contributions where purchase_id=$1', [old.id]);
    await saveParts(db, old.id, parts);
    await applyItems(db, old.id, items, oldItems);
  });
  res.json({ ok: true });
}));

router.delete('/purchases/:id', wrap(async (req, res) => {
  await tx(async db => {
    const [old] = await db('select id from purchases where id=$1 for update', [req.params.id]);
    if (!old) throw bad('La compra no existe', 404);
    const oldItems = await db('select product_id, qty from purchase_items where purchase_id=$1', [old.id]);
    await applyItems(db, old.id, [], oldItems); // descuenta el stock; un producto sin otras compras vuelve a "por comprar"
    await db('delete from purchases where id=$1', [old.id]);
  });
  res.json({ ok: true });
}));

// ---- Devoluciones a los administradores
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