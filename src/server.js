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
import { initDb } from './db/init.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.set('trust proxy', 1);
const PORT = Number(process.env.PORT) || 3000;

// ── Adresse canonique : www et http → https://<domaine> (filet de sécurité derrière le .htaccess Apache) ──
const CANONICAL = (() => {
  try {
    const u = new URL(process.env.CANONICAL_URL || process.env.APP_URL || '');
    return u.protocol === 'https:' ? u : null;
  } catch {
    return null;
  }
})();
if (process.env.NODE_ENV === 'production' && CANONICAL) {
  const canonicalHost = CANONICAL.host.toLowerCase();
  app.use((req, res, next) => {
    const host = String(req.get('host') || '').toLowerCase();
    const hostname = host.replace(/:\d+$/, '');
    if (!host || hostname === 'localhost' || hostname === '127.0.0.1') return next();
    if (req.path.startsWith('/.well-known/acme-challenge/')) return next();
    const isWww = host === `www.${canonicalHost}`;
    // Redirection HTTPS uniquement si le proxy indique explicitement une requête http (aucune boucle possible)
    const forwardedProto = String(req.get('x-forwarded-proto') || '').split(',')[0].trim().toLowerCase();
    const isPlainHttp = forwardedProto === 'http';
    if (!isWww && !isPlainHttp) return next();
    const status = req.method === 'GET' || req.method === 'HEAD' ? 301 : 308; // 308 : un POST reste un POST
    return res.redirect(status, `https://${canonicalHost}${req.originalUrl}`);
  });
}

// ── Sécurité ──
app.use(helmet({
  contentSecurityPolicy: false, // Le front est un fichier statique autonome
  hsts: { maxAge: 31536000, includeSubDomains: true, preload: false },
}));

// ── CORS ──
const origins = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map((s) => s.trim().replace(/\/$/, ''))
  .filter(Boolean);
// L'origine publique du site (APP_URL) est toujours autorisée
try {
  if (process.env.APP_URL) origins.push(new URL(process.env.APP_URL).origin);
} catch { /* APP_URL invalide : ignorée */ }

app.use(cors({
  origin: (origin, callback) => {
    // Autoriser les appels sans origine (ex: file://, curl, mobile) ou en développement
    if (!origin || process.env.NODE_ENV !== 'production' || origins.includes(origin)) {
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

// ── Gestion centralisée des erreurs (aucune trace interne renvoyée au client) ──
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ statut: 'erreur', message: 'Corps de requête JSON invalide.' });
  }
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ statut: 'erreur', message: 'Requête trop volumineuse.' });
  }
  if (err && err.message === 'Non autorisé par CORS') {
    return res.status(403).json({ statut: 'erreur', message: 'Origine non autorisée.' });
  }
  if (err && err.code === 'DB_UNAVAILABLE') {
    console.error('[DB]', err.message);
    return res.status(503).json({ statut: 'erreur', message: 'Service temporairement indisponible.' });
  }
  console.error('[SERVEUR] Erreur non gérée :', err);
  return res.status(500).json({ statut: 'erreur', message: 'Erreur interne du serveur.' });
});

// ── Démarrage : la base MySQL doit être prête avant d'accepter des requêtes ──
try {
  await initDb();
} catch (err) {
  console.error(`
❌ Impossible d'initialiser la base MySQL : ${err.message}
`);
  process.exit(1);
}

app.listen(PORT, () => {
  console.log(`
🚐 TickWay backend démarré sur http://localhost:${PORT} (MySQL)
`);
  console.log(`   POST /api/payments/paysecurehub/init — Créer une commande`);
  console.log(`   POST /api/validate       — Valider un billet (clé équipe requise)`);
  console.log(`   POST /api/team/login     — Connexion Espace Équipe`);
  console.log(`   GET  /api/founder/*      — Dashboard Fondateur sécurisé
`);
});
