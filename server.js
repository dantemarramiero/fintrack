require('dotenv').config();
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const path = require('path');
const Database = require('better-sqlite3');
const cron = require('node-cron');
const nodemailer = require('nodemailer');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'change_this_secret_in_production';

// ── DB setup ───────────────────────────────────────────────────
const DB_PATH = process.env.DB_PATH || path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH || __dirname, 'fintrack.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, username TEXT UNIQUE, password TEXT,
    nome TEXT, email TEXT, reminder_days INTEGER DEFAULT 3, created_at TEXT
  );
  CREATE TABLE IF NOT EXISTS abbonamenti (
    id TEXT PRIMARY KEY, userId TEXT, nome TEXT, cat TEXT, imp REAL,
    freq TEXT, rinnovo TEXT, carta TEXT, stato TEXT DEFAULT 'Attivo', note TEXT, created_at TEXT
  );
  CREATE TABLE IF NOT EXISTS spese (
    id TEXT PRIMARY KEY, userId TEXT, data TEXT, imp REAL, desc TEXT,
    cat TEXT, forn TEXT, carta TEXT, deduct TEXT, note TEXT, created_at TEXT
  );
  CREATE TABLE IF NOT EXISTS entrate (
    id TEXT PRIMARY KEY, userId TEXT, data TEXT, imp REAL, desc TEXT,
    cat TEXT, prov TEXT, conto TEXT, per TEXT, note TEXT, created_at TEXT
  );
  CREATE TABLE IF NOT EXISTS carte (
    id TEXT PRIMARY KEY, userId TEXT, nome TEXT, banca TEXT, num TEXT,
    tipo TEXT, lim REAL, saldo REAL, scad TEXT, note TEXT, created_at TEXT
  );
  CREATE TABLE IF NOT EXISTS conti (
    id TEXT PRIMARY KEY, userId TEXT, nome TEXT, banca TEXT, iban TEXT,
    tipo TEXT DEFAULT 'Corrente', saldo REAL DEFAULT 0, valuta TEXT DEFAULT 'EUR', note TEXT, created_at TEXT
  );
  CREATE TABLE IF NOT EXISTS fatture (
    id TEXT PRIMARY KEY, userId TEXT, tipo TEXT, numero TEXT, controparte TEXT,
    importo REAL, iva REAL DEFAULT 22, importo_totale REAL,
    data_emissione TEXT, data_scadenza TEXT, stato TEXT DEFAULT 'non_pagata',
    conto_id TEXT, note TEXT, created_at TEXT
  );
  CREATE TABLE IF NOT EXISTS pagamenti (
    id TEXT PRIMARY KEY, userId TEXT, fattura_id TEXT, conto_id TEXT,
    importo REAL, data TEXT, metodo TEXT DEFAULT 'Bonifico', note TEXT, created_at TEXT
  );
`);

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Email ──────────────────────────────────────────────────────
let emailTransport = null;
let emailFrom = '';
let emailReady = false;

async function initEmail() {
  if (process.env.GMAIL_USER && process.env.GMAIL_PASS) {
    emailTransport = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_PASS }
    });
    emailFrom = process.env.GMAIL_USER;
    emailReady = true;
    console.log('Email: Gmail SMTP configurato');
  } else if (process.env.RESEND_API_KEY) {
    const { Resend } = require('resend');
    const resendClient = new Resend(process.env.RESEND_API_KEY);
    emailTransport = {
      sendMail: async (opts) => {
        return resendClient.emails.send({
          from: opts.from || process.env.RESEND_FROM || 'FinTrack <noreply@fintrack.app>',
          to: Array.isArray(opts.to) ? opts.to : [opts.to],
          subject: opts.subject,
          html: opts.html
        });
      }
    };
    emailFrom = process.env.RESEND_FROM || 'FinTrack <noreply@fintrack.app>';
    emailReady = true;
    console.log('Email: Resend configurato');
  } else {
    console.log('Email: non configurata (impostare GMAIL_USER/GMAIL_PASS o RESEND_API_KEY)');
  }
}

async function sendEmail({ to, subject, html }) {
  if (!emailReady || !emailTransport) return;
  try {
    await emailTransport.sendMail({ from: emailFrom, to, subject, html });
  } catch (e) {
    console.error('Errore invio email:', e.message);
  }
}

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
  const { nome, email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email e password obbligatorie' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Email non valida' });
  const emailLower = email.toLowerCase().trim();
  if (db.prepare('SELECT id FROM users WHERE username=?').get(emailLower)) return res.status(409).json({ error: 'Email già registrata' });
  const hash = await bcrypt.hash(password, 10);
  const user = { id: Date.now().toString(), username: emailLower, password: hash, nome: nome?.trim() || emailLower, email: emailLower, reminder_days: 3, created_at: new Date().toISOString() };
  db.prepare('INSERT INTO users (id,username,password,nome,email,reminder_days,created_at) VALUES (?,?,?,?,?,?,?)')
    .run(user.id, user.username, user.password, user.nome, user.email, user.reminder_days, user.created_at);
  const token = jwt.sign({ id: user.id, username: user.username, nome: user.nome }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, nome: user.nome, username: user.username });
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  const emailLower = (email || '').toLowerCase().trim();
  const user = db.prepare('SELECT * FROM users WHERE username=?').get(emailLower);
  if (!user) return res.status(401).json({ error: 'Credenziali non valide' });
  const ok = await bcrypt.compare(password, user.password);
  if (!ok) return res.status(401).json({ error: 'Credenziali non valide' });
  const token = jwt.sign({ id: user.id, username: user.username, nome: user.nome }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, nome: user.nome, username: user.username });
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.get('/api/me', auth, (req, res) => {
  const user = db.prepare('SELECT id,username,nome,email,reminder_days FROM users WHERE id=?').get(req.user.id);
  res.json(user);
});

app.patch('/api/me/settings', auth, (req, res) => {
  const { email, reminder_days } = req.body;
  db.prepare('UPDATE users SET email=?, reminder_days=? WHERE id=?')
    .run(email || null, reminder_days || 3, req.user.id);
  res.json({ ok: true });
});

// ── CRUD factory ───────────────────────────────────────────────
const resourceCols = {
  abbonamenti: ['nome','cat','imp','freq','rinnovo','carta','stato','note'],
  spese:       ['data','imp','desc','cat','forn','carta','deduct','note'],
  entrate:     ['data','imp','desc','cat','prov','conto','per','note'],
  carte:       ['nome','banca','num','tipo','lim','saldo','scad','note'],
  conti:       ['nome','banca','iban','tipo','saldo','valuta','note'],
  fatture:     ['tipo','numero','controparte','importo','iva','importo_totale','data_emissione','data_scadenza','stato','conto_id','note'],
  pagamenti:   ['fattura_id','conto_id','importo','data','metodo','note']
};

function crud(resource) {
  const cols = resourceCols[resource];

  app.get('/api/' + resource, auth, (req, res) => {
    const rows = db.prepare('SELECT * FROM ' + resource + ' WHERE userId=? ORDER BY created_at DESC').all(req.user.id);
    res.json(rows);
  });

  app.post('/api/' + resource, auth, (req, res) => {
    const id = Date.now().toString();
    const now = new Date().toISOString();
    const item = { id, userId: req.user.id, created_at: now };
    cols.forEach(c => { item[c] = req.body[c] !== undefined ? req.body[c] : null; });
    const keys = Object.keys(item);
    const placeholders = keys.map(() => '?').join(',');
    db.prepare('INSERT INTO ' + resource + ' (' + keys.join(',') + ') VALUES (' + placeholders + ')')
      .run(...keys.map(k => item[k]));
    res.json(item);
  });

  app.put('/api/' + resource + '/:id', auth, (req, res) => {
    const existing = db.prepare('SELECT id FROM ' + resource + ' WHERE id=? AND userId=?').get(req.params.id, req.user.id);
    if (!existing) return res.status(404).json({ error: 'Non trovato' });
    const setClauses = cols.map(c => c + '=?').join(',');
    const vals = cols.map(c => req.body[c] !== undefined ? req.body[c] : null);
    db.prepare('UPDATE ' + resource + ' SET ' + setClauses + ' WHERE id=? AND userId=?')
      .run(...vals, req.params.id, req.user.id);
    const updated = db.prepare('SELECT * FROM ' + resource + ' WHERE id=?').get(req.params.id);
    res.json(updated);
  });

  app.delete('/api/' + resource + '/:id', auth, (req, res) => {
    const existing = db.prepare('SELECT id FROM ' + resource + ' WHERE id=? AND userId=?').get(req.params.id, req.user.id);
    if (!existing) return res.status(404).json({ error: 'Non trovato' });
    db.prepare('DELETE FROM ' + resource + ' WHERE id=? AND userId=?').run(req.params.id, req.user.id);
    res.json({ ok: true });
  });
}

crud('abbonamenti');
crud('spese');
crud('entrate');
crud('carte');
crud('conti');
crud('fatture');
crud('pagamenti');

// ── Fattura: paga ──────────────────────────────────────────────
app.post('/api/fatture/:id/paga', auth, (req, res) => {
  const fattura = db.prepare('SELECT * FROM fatture WHERE id=? AND userId=?').get(req.params.id, req.user.id);
  if (!fattura) return res.status(404).json({ error: 'Fattura non trovata' });

  const { conto_id, data, metodo } = req.body;
  const pagatoData = data || new Date().toISOString().split('T')[0];
  const pagatoMetodo = metodo || 'Bonifico';

  const pagId = Date.now().toString();
  db.prepare('INSERT INTO pagamenti (id,userId,fattura_id,conto_id,importo,data,metodo,created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(pagId, req.user.id, fattura.id, conto_id || null, fattura.importo_totale, pagatoData, pagatoMetodo, new Date().toISOString());

  db.prepare('UPDATE fatture SET stato=? WHERE id=?').run('pagata', fattura.id);

  if (conto_id) {
    const conto = db.prepare('SELECT * FROM conti WHERE id=? AND userId=?').get(conto_id, req.user.id);
    if (conto) {
      const delta = fattura.tipo === 'emessa' ? fattura.importo_totale : -fattura.importo_totale;
      db.prepare('UPDATE conti SET saldo=saldo+? WHERE id=?').run(delta, conto_id);
    }
  }

  res.json({ ok: true });
});

// ── Dashboard ──────────────────────────────────────────────────
app.get('/api/dashboard', auth, (req, res) => {
  const uid = req.user.id;
  const oggi = new Date().toISOString().split('T')[0];
  const tra7 = new Date(Date.now() + 7 * 86400000).toISOString().split('T')[0];

  const saldoRow = db.prepare('SELECT SUM(saldo) as tot FROM conti WHERE userId=?').get(uid);
  const fattureScadute = db.prepare("SELECT COUNT(*) as cnt FROM fatture WHERE userId=? AND stato='non_pagata' AND data_scadenza < ?").get(uid, oggi);
  const fattureAperte = db.prepare("SELECT COUNT(*) as cnt, SUM(importo_totale) as tot FROM fatture WHERE userId=? AND stato='non_pagata'").get(uid);
  const inScadenza = db.prepare("SELECT * FROM fatture WHERE userId=? AND stato='non_pagata' AND data_scadenza >= ? AND data_scadenza <= ? ORDER BY data_scadenza ASC LIMIT 5").all(uid, oggi, tra7);

  res.json({
    saldoConti: saldoRow.tot || 0,
    fattureScadute: fattureScadute.cnt || 0,
    fattureAperte: { count: fattureAperte.cnt || 0, tot: fattureAperte.tot || 0 },
    inScadenza
  });
});

// ── Cron: reminder fatture ─────────────────────────────────────
cron.schedule('0 8 * * *', async () => {
  const users = db.prepare('SELECT * FROM users WHERE email IS NOT NULL AND email != ""').all();
  for (const user of users) {
    const oggi = new Date().toISOString().split('T')[0];
    const targetDate = new Date(Date.now() + (user.reminder_days || 3) * 86400000).toISOString().split('T')[0];
    const fatture = db.prepare(
      "SELECT * FROM fatture WHERE userId=? AND stato='non_pagata' AND data_scadenza >= ? AND data_scadenza <= ? ORDER BY data_scadenza ASC"
    ).all(user.id, oggi, targetDate);

    if (fatture.length > 0) {
      const rows = fatture.map(f =>
        '<tr><td style="padding:6px 12px">' + (f.numero || '—') + '</td>' +
        '<td style="padding:6px 12px">' + (f.controparte || '—') + '</td>' +
        '<td style="padding:6px 12px">' + f.tipo + '</td>' +
        '<td style="padding:6px 12px;text-align:right">€ ' + (f.importo_totale || 0).toFixed(2) + '</td>' +
        '<td style="padding:6px 12px">' + (f.data_scadenza || '—') + '</td></tr>'
      ).join('');

      const html = '<div style="font-family:sans-serif;max-width:600px">' +
        '<h2 style="color:#1A2940">FinTrack — Fatture in scadenza</h2>' +
        '<p>Ciao ' + user.nome + ', hai ' + fatture.length + ' fattura/e in scadenza nei prossimi ' + (user.reminder_days || 3) + ' giorni:</p>' +
        '<table style="width:100%;border-collapse:collapse;font-size:14px">' +
        '<thead><tr style="background:#1A2940;color:#fff">' +
        '<th style="padding:8px 12px;text-align:left">N°</th>' +
        '<th style="padding:8px 12px;text-align:left">Controparte</th>' +
        '<th style="padding:8px 12px;text-align:left">Tipo</th>' +
        '<th style="padding:8px 12px;text-align:right">Totale</th>' +
        '<th style="padding:8px 12px;text-align:left">Scadenza</th>' +
        '</tr></thead><tbody>' + rows + '</tbody></table>' +
        '<p style="color:#5a6a7e;font-size:12px;margin-top:20px">Questo messaggio è stato inviato automaticamente da FinTrack.</p></div>';

      await sendEmail({ to: user.email, subject: 'FinTrack — ' + fatture.length + ' fattura/e in scadenza', html });
    }
  }
});

// ── SPA fallback ───────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Start ──────────────────────────────────────────────────────
initEmail().then(() => {
  app.listen(PORT, () => {
    console.log('FinTrack v2 running on port ' + PORT);
    console.log('DB path: ' + DB_PATH);
    console.log('Email ready: ' + emailReady);
  });
});
