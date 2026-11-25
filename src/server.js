// src/server.js — Point d'entrée du serveur TickWay
import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import reservationsRouter from './routes/reservations.js';
import paymentsRouter from './routes/payments.js';
import validateRouter from './routes/validate.js';
import resendRouter from './routes/resend.js';
import teamRouter from './routes/team.js';
import founderRouter from './routes/founder.js';
import pool from './db/pool.js';
import { INIT_SQL } from './db/init.js';

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
  methods: ['GET', 'POST', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Api-Key', 'X-Team-Token', 'X-Agent-Id', 'X-Founder-Token', 'X-User-Token'],
}));

// ── Body parser ──
app.use(express.json({ limit: '32kb' }));
app.use(express.urlencoded({ extended: false, limit: '32kb' }));

// ── Rate limiting : réservations ──
const reservationLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10,             // 10 réservations par minute par IP
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    statut: 'erreur',
    message: 'Trop de requêtes. Réessayez dans une minute.',
  },
});

// ── Rate limiting : validation & espace équipe (souple, l'équipe scanne vite) ──
const validateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    statut: 'erreur',
    message: 'Trop de requêtes de validation.',
  },
});

// ── Routes API ──
// Les comptes clients sont désactivés : toutes les réservations sont effectuées sans compte
app.use('/api/auth', (req, res) => res.status(410).json({
  statut: 'erreur',
  code: 'ACCOUNTS_DISABLED',
  message: 'Les comptes clients ont été supprimés : réservez directement sans compte sur TickWay.',
}));
app.use('/api/account', (req, res) => res.status(410).json({
  statut: 'erreur',
  code: 'ACCOUNTS_DISABLED',
  message: 'Les espaces personnels clients ont été supprimés : utilisez votre lien sécurisé ou votre référence de billet.',
}));
app.use('/api/reservations', reservationLimiter, reservationsRouter);
app.use('/api/payments/paysecurehub/init', reservationLimiter);
app.use('/api/payments', validateLimiter, paymentsRouter);
app.use('/api/validate', validateLimiter, validateRouter);
app.use('/api/resend', reservationLimiter, resendRouter);
app.use('/api/team', validateLimiter, teamRouter);
app.use('/api/founder', validateLimiter, founderRouter);

// Aucune route /api/* inconnue ne doit retomber sur le fallback HTML
app.all('/api/*', (req, res) => {
  return res.status(404).json({
    statut: 'erreur',
    code: 'NOT_FOUND',
    message: 'Endpoint API introuvable.',
  });
});

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
  console.log(`   POST /api/validate       — Valider un billet (clé équipe requise)`);
  console.log(`   POST /api/team/login     — Connexion Espace Équipe`);
  console.log(`   GET  /api/founder/*      — Dashboard Fondateur sécurisé\n`);
});
