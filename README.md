# FinTrack — Rendiconto Economico-Finanziario

App web per tracciare abbonamenti, spese, entrate e carte di credito con rendiconto automatico.

## Struttura

```
fintrack/
├── server.js          # Backend Express + API REST
├── public/
│   └── index.html     # Frontend SPA (login + dashboard)
├── package.json
├── railway.toml       # Config deploy Railway
├── .env.example       # Variabili d'ambiente da copiare
└── .gitignore
```

## Deploy su Railway (passo per passo)

### 1. Carica su GitHub

```bash
cd fintrack
git init
git add .
git commit -m "first commit"
git branch -M main
git remote add origin https://github.com/TUO_USERNAME/fintrack.git
git push -u origin main
```

### 2. Deploy su Railway

1. Vai su [railway.app](https://railway.app) e accedi con GitHub
2. Click **New Project → Deploy from GitHub repo**
3. Seleziona il repo `fintrack`
4. Railway lo rileva come Node.js e fa il deploy automatico

### 3. Configura le variabili d'ambiente su Railway

Vai su **Variables** nel progetto Railway e aggiungi:

| Variabile     | Valore                                      |
|---------------|---------------------------------------------|
| `JWT_SECRET`  | Una stringa lunga e casuale (es. 64 char)   |
| `DB_PATH`     | `/app/db.json`                              |
| `NODE_ENV`    | `production`                                |

> **Genera un JWT_SECRET sicuro:**
> ```bash
> node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
> ```

### 4. Aggiungi un volume persistente (IMPORTANTE)

Railway di default non persiste i file tra i deploy. Per non perdere i dati:

1. Nel progetto Railway → **Settings → Volumes**
2. Click **New Volume**
3. Mount path: `/app`
4. Questo rende `db.json` persistente tra i deploy

### Sviluppo locale

```bash
cp .env.example .env
# modifica .env con i tuoi valori
npm install
npm start
# → http://localhost:3000
```

## Funzionalità

- **Autenticazione** multi-utente con JWT (ogni utente vede solo i propri dati)
- **Abbonamenti** ricorrenti con calcolo automatico costo mensile/annuo
- **Spese** con categorie, carta usata, flag deducibilità
- **Entrate** per provenienza e periodicità
- **Carte di credito** con monitoraggio utilizzo
- **Rendiconto** economico-finanziario mensile aggiornato in tempo reale

## API

```
POST /api/register        Crea account
POST /api/login           Accedi (ritorna JWT)
GET  /api/me              Utente corrente

GET/POST   /api/abbonamenti
GET/POST   /api/spese
GET/POST   /api/entrate
GET/POST   /api/carte

PUT/DELETE /api/:resource/:id
```
