// src/server.js — Point d'entrée du serveur TickWay
import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import reservationsRouter from './routes/reservations.js';
import validateRouter from './routes/validate.js';
import resendRouter from './routes/resend.js';
import pool from './db/pool.js';

const INIT_SQL = `
CREATE TABLE IF NOT EXISTS reservations (
  reference     TEXT PRIMARY KEY,
  prenom        TEXT        NOT NULL,
  nom           TEXT        NOT NULL,
  telephone     TEXT        NOT NULL,
  email         TEXT        NOT NULL,
  event_id      TEXT        NOT NULL,
  event_nom     TEXT        NOT NULL,
  event_date    TEXT        NOT NULL,
  zone          TEXT        NOT NULL,
  point_relais  TEXT        NOT NULL,
  montant       INTEGER     NOT NULL,
  mode_paiement TEXT        NOT NULL,
  quantite      INTEGER     NOT NULL DEFAULT 1 CHECK (quantite >= 1 AND quantite <= 5),
  statut        TEXT        NOT NULL DEFAULT 'valide'
                            CHECK (statut IN ('valide', 'utilise')),
  cree_le       TIMESTAMPTZ NOT NULL DEFAULT now(),
  utilise_le    TIMESTAMPTZ
);
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS quantite INTEGER NOT NULL DEFAULT 1;
CREATE INDEX IF NOT EXISTS idx_reservations_statut ON reservations (statut);
CREATE INDEX IF NOT EXISTS idx_reservations_email  ON reservations (email);
`;

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.set('trust proxy', 1);
const PORT = Number(process.env.PORT) || 3000;

// ── Sécurité ──
app.use(helmet({
  contentSecurityPolicy: false, // Le front est un fichier statique autonome
}));

// ── CORS ──
const origins = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    // Autoriser les appels sans origine (ex: file://, curl, mobile) ou en développement
    if (!origin || origin === 'null' || process.env.NODE_ENV !== 'production' || origins.length === 0 || origins.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error('Non autorisé par CORS'));
  },
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'X-Api-Key'],
}));

// ── Body parser ──
app.use(express.json({ limit: '16kb' }));

// ── Rate limiting : réservations ──
const reservationLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 5,              // 5 réservations par minute par IP
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    statut: 'erreur',
    message: 'Trop de requêtes. Réessayez dans une minute.',
  },
});

// ── Rate limiting : validation (plus souple, l'équipe scanne vite) ──
const validateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    statut: 'erreur',
    message: 'Trop de requêtes de validation.',
  },
});

// ── Routes API ──
app.post('/api/reservations', reservationLimiter, reservationsRouter);
app.post('/api/validate', validateLimiter, validateRouter);
app.post('/api/resend', reservationLimiter, resendRouter);

// ── Servir les fichiers statiques (le front) ──
app.use(express.static(join(__dirname, '..', 'public')));

// ── Fallback : SPA ──
app.get('*', (req, res) => {
  res.sendFile(join(__dirname, '..', 'public', 'index.html'));
});

// ── Démarrage ──
app.listen(PORT, async () => {
  try {
    await pool.query(INIT_SQL);
  } catch (err) {
    console.warn('[DB] Initialisation schéma :', err.message);
  }
  console.log(`\n🚐 TickWay backend démarré sur http://localhost:${PORT}\n`);
  console.log(`   POST /api/reservations   — Créer une réservation`);
  console.log(`   POST /api/validate       — Valider un billet (clé requise)`);
  console.log(`   POST /api/resend         — Renvoyer l'e-mail du billet\n`);
});
