const router = require('express').Router(), bcrypt = require('bcryptjs');
const { query } = require('../db'), { wrap, bad } = require('../middleware/errors'), { sign } = require('../middleware/auth');

router.post('/register', wrap(async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password || password.length < 6) throw bad('Datos inválidos (clave mínimo 6)');
  try {
    const [u] = await query('insert into users(name,email,password) values($1,$2,$3) returning id,name,email,role',
      [name, email.toLowerCase(), bcrypt.hashSync(password, 10)]);
    res.status(201).json({ token: sign(u), user: u });
  } catch (e) { throw e.code === '23505' ? bad('El correo ya existe', 409) : e; }
}));

router.post('/login', wrap(async (req, res) => {
  const [u] = await query('select * from users where email=$1', [(req.body.email || '').toLowerCase()]);
  if (!u || !bcrypt.compareSync(req.body.password || '', u.password)) throw bad('Credenciales incorrectas', 401);
  res.json({ token: sign(u), user: { id: u.id, name: u.name, email: u.email, role: u.role } });
}));
module.exports = router;
