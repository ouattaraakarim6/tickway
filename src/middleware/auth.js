// src/middleware/auth.js — Authentification serveur (Équipes Terrain & Fondateur), sessions persistées en MySQL
import { resolveTeamAuth, verifyFounderSessionToken } from '../services/platformStore.js';

export async function requireTeamAuth(req, res, next) {
  try {
    const resolved = await resolveTeamAuth(req);
    if (!resolved) {
      return res.status(401).json({
        statut: 'erreur',
        message: 'Accès refusé : Clé équipe invalide, désactivée ou session expirée.',
      });
    }
    req.team = resolved.equipe;
    req.agentId = resolved.agentId;
    return next();
  } catch (err) {
    return next(err);
  }
}

// Alias rétrocompatible
export const requireApiKey = requireTeamAuth;

export async function requireFounderAuth(req, res, next) {
  try {
    const token = String(req.headers['x-founder-token'] || '').trim();
    const check = await verifyFounderSessionToken(token);
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
    return next();
  } catch (err) {
    return next(err);
  }
}
