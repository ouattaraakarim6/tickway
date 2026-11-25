// src/middleware/auth.js — Authentification serveur (Équipes Terrain, Fondateur & Comptes Clients Supabase Auth)
import { resolveTeamAuth, verifyFounderSessionToken } from '../services/platformStore.js';
import { verifyUserSession } from '../services/userStore.js';

export function extractUserToken(req) {
  const auth = String(req.headers.authorization || '').trim();
  if (/^Bearer\s+/i.test(auth)) {
    return auth.replace(/^Bearer\s+/i, '').trim();
  }
  const headerTok = req.headers['x-user-token'];
  if (headerTok && String(headerTok).trim()) {
    return String(headerTok).trim();
  }
  return '';
}

export async function resolveOptionalUserAuth(req, res, next) {
  try {
    const token = extractUserToken(req);
    if (!token) {
      req.user = null;
      req.userToken = null;
      req.supabaseUser = null;
      return next();
    }
    const sess = await verifyUserSession(token);
    if (sess && sess.user) {
      req.user = sess.user;
      req.userToken = token;
      req.supabaseUser = sess.supabaseUser || null;
    } else {
      req.user = null;
      req.userToken = null;
      req.supabaseUser = null;
    }
    return next();
  } catch {
    req.user = null;
    req.userToken = null;
    req.supabaseUser = null;
    return next();
  }
}

export async function requireUserAuth(req, res, next) {
  try {
    const token = extractUserToken(req);
    if (!token) {
      return res.status(401).json({
        statut: 'erreur',
        code: 'NON_CONNECTE',
        message: 'Veuillez vous connecter à votre compte TickWay.',
      });
    }
    const sess = await verifyUserSession(token);
    if (!sess || !sess.user) {
      return res.status(401).json({
        statut: 'erreur',
        code: 'SESSION_EXPIREE',
        message: 'Votre session a expiré ou n’est plus valide. Veuillez vous reconnecter.',
      });
    }
    req.user = sess.user;
    req.userToken = token;
    req.supabaseUser = sess.supabaseUser || null;
    req.userSessionExpiresAt = sess.expiresAt || null;
    return next();
  } catch (err) {
    if (err && err.status === 503) {
      return res.status(503).json({
        statut: 'erreur',
        code: 'AUTH_SERVICE_UNAVAILABLE',
        message: 'Service d’authentification temporairement indisponible. Réessayez dans un instant.',
      });
    }
    return res.status(500).json({ statut: 'erreur', message: 'Erreur de vérification de session.' });
  }
}

export function requireTeamAuth(req, res, next) {
  const resolved = resolveTeamAuth(req);
  if (!resolved) {
    return res.status(401).json({
      statut: 'erreur',
      message: "Accès refusé : Clé équipe invalide, désactivée ou session expirée.",
    });
  }
  req.team = resolved.equipe;
  req.agentId = resolved.agentId;
  next();
}

// Alias rétrocompatible
export const requireApiKey = requireTeamAuth;

export function requireFounderAuth(req, res, next) {
  const token = String(req.headers['x-founder-token'] || '').trim();
  const check = verifyFounderSessionToken(token);
  if (!check.valid) {
    return res.status(401).json({
      statut: 'erreur',
      code: check.reason,
      message: check.reason === 'expiree'
        ? 'Session Fondateur expirée après inactivité (15 min). Veuillez vous reconnecter.'
        : 'Accès Fondateur non autorisé. Authentification requise.',
    });
  }
  req.founderToken = token;
  next();
}
