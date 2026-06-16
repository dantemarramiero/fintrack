require('dotenv').config();
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const path = require('path');
const low = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'change_this_secret_in_production';

// DB setup
const adapter = new FileSync(process.env.DB_PATH || 'db.json');
const db = low(adapter);
db.defaults({ users: [], abbonamenti: [], spese: [], entrate: [], carte: [] }).write();

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Auth middleware ────────────────────────────────────────────
function auth(req, res, next) {
  const header = req.headers.authorization;
  if (!header) return res.status(401).json({ error: 'Token mancante' });
  const token = header.split(' ')[1];
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Token non valido' });
  }
}

// ── Auth routes ────────────────────────────────────────────────
app.post('/api/register', async (req, res) => {
  const { username, password, nome } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username e password obbligatori' });
  if (db.get('users').find({ username }).value()) return res.status(409).json({ error: 'Username già esistente' });
  const hash = await bcrypt.hash(password, 10);
  const user = { id: Date.now().toString(), username, password: hash, nome: nome || username, createdAt: new Date().toISOString() };
  db.get('users').push(user).write();
  const token = jwt.sign({ id: user.id, username: user.username, nome: user.nome }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, nome: user.nome, username: user.username });
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  const user = db.get('users').find({ username }).value();
  if (!user) return res.status(401).json({ error: 'Credenziali non valide' });
  const ok = await bcrypt.compare(password, user.password);
  if (!ok) return res.status(401).json({ error: 'Credenziali non valide' });
  const token = jwt.sign({ id: user.id, username: user.username, nome: user.nome }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, nome: user.nome, username: user.username });
});

app.get('/api/me', auth, (req, res) => {
  res.json({ id: req.user.id, username: req.user.username, nome: req.user.nome });
});

// ── Generic CRUD factory ───────────────────────────────────────
function crudRoutes(resource) {
  app.get(`/api/${resource}`, auth, (req, res) => {
    const items = db.get(resource).filter({ userId: req.user.id }).value();
    res.json(items);
  });

  app.post(`/api/${resource}`, auth, (req, res) => {
    const item = { ...req.body, id: Date.now().toString(), userId: req.user.id, createdAt: new Date().toISOString() };
    db.get(resource).push(item).write();
    res.json(item);
  });

  app.put(`/api/${resource}/:id`, auth, (req, res) => {
    const existing = db.get(resource).find({ id: req.params.id, userId: req.user.id }).value();
    if (!existing) return res.status(404).json({ error: 'Non trovato' });
    db.get(resource).find({ id: req.params.id }).assign(req.body).write();
    res.json(db.get(resource).find({ id: req.params.id }).value());
  });

  app.delete(`/api/${resource}/:id`, auth, (req, res) => {
    const existing = db.get(resource).find({ id: req.params.id, userId: req.user.id }).value();
    if (!existing) return res.status(404).json({ error: 'Non trovato' });
    db.get(resource).remove({ id: req.params.id, userId: req.user.id }).write();
    res.json({ ok: true });
  });
}

crudRoutes('abbonamenti');
crudRoutes('spese');
crudRoutes('entrate');
crudRoutes('carte');

// ── Catch-all → SPA ───────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => console.log(`FinTrack running on port ${PORT}`));
