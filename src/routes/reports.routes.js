const router = require('express').Router(), { query } = require('../db'), { wrap } = require('../middleware/errors');

router.get('/reports/summary', wrap(async (req, res) => {
  const j = "from orders o join order_items i on i.order_id=o.id where o.status<>'cancelado'";
  const [totals] = await query(`select count(distinct o.id) orders,coalesce(sum(i.price*i.qty),0) revenue,coalesce(sum((i.price-i.cost)*i.qty),0) profit ${j}`);
  res.json({
    totals,
    byDay: await query(`select to_char(o.created_at,'YYYY-MM-DD') day,sum(i.price*i.qty) revenue ${j} group by 1 order by 1 desc limit 14`),
    top: await query(`select i.name,sum(i.qty) units,sum(i.price*i.qty) revenue ${j} group by i.name order by units desc limit 5`),
    lowStock: await query('select id,name,stock from products where active and stock<=5 order by stock limit 20'),
    evals: await query('select eval_status s,count(*) n from products group by 1'),
  });
}));

const csv = (rows, cols) => '\ufeff' + [cols.join(','), ...rows.map(r => cols.map(c => '"' + String(r[c] ?? '').replace(/"/g, '""') + '"').join(','))].join('\n');
router.get('/export/:kind', wrap(async (req, res) => {
  const rows = req.params.kind === 'sales'
    ? await query("select o.id pedido,to_char(o.created_at,'YYYY-MM-DD') fecha,o.status estado,o.customer cliente,i.name producto,i.qty cantidad,i.price precio from orders o join order_items i on i.order_id=o.id order by o.id")
    : await query("select name producto,cost costo,price venta,stock,source_url url from products where eval_status='aprobado' order by name");
  res.type('text/csv').send(csv(rows, Object.keys(rows[0] || { producto: 1 })));
}));
module.exports = router;
