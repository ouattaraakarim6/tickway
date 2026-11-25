// src/routes/team.js — Authentification et statistiques temps réel de l'Espace Équipe (sans données financières)
import { Router } from 'express';
import {
  checkRateLockout,
  recordFailedAttempt,
  clearFailedAttempts,
  findTeamByKey,
  createTeamSession,
  getTeamStats,
} from '../services/platformStore.js';
import { EVENTS } from '../services/events.js';
import { requireTeamAuth } from '../middleware/auth.js';

const router = Router();

function formatAssignedEvents(eventIds) {
  if (!Array.isArray(eventIds) || eventIds.includes('*')) {
    return EVENTS.map((e) => ({ id: e.id, nom: e.n, date: e.d }));
  }
  return EVENTS
    .filter((e) => eventIds.includes(e.id))
    .map((e) => ({ id: e.id, nom: e.n, date: e.d }));
}

// POST /api/team/login — Vérification de la clé équipe côté serveur
router.post('/login', async (req, res, next) => {
  try {
  const bucket = `team:${req.ip || 'local'}`;
  const lock = await checkRateLockout(bucket);
  if (lock.locked) {
    return res.status(429).json({
      statut: 'erreur',
      message: `Trop de tentatives échouées. Réessayez dans ${lock.remainingSec} secondes.`,
    });
  }

  const rawKey = String(req.body.key || req.body.cle || '').trim();
  const agentId = String(req.body.agentId || req.body.agent || 'Agent Terrain').trim().slice(0, 40);

  if (!rawKey) {
    return res.status(400).json({
      statut: 'erreur',
      message: 'Veuillez saisir votre clé équipe.',
    });
  }

  const equipe = await findTeamByKey(rawKey);
  if (!equipe) {
    const fail = await recordFailedAttempt(bucket);
    return res.status(401).json({
      statut: 'erreur',
      message: fail.locked
        ? 'Clé équipe incorrecte. Accès temporairement bloqué (5 minutes) suite à plusieurs échecs.'
        : `Clé équipe incorrecte. (${fail.attemptsLeft} tentative(s) restante(s)).`,
    });
  }

  if (!equipe.actif) {
    return res.status(403).json({
      statut: 'erreur',
      message: 'Cette clé équipe a été désactivée par le fondateur.',
    });
  }

  await clearFailedAttempts(bucket);
  const session = await createTeamSession(equipe, agentId);
  const stats = await getTeamStats(equipe.id);

  return res.json({
    statut: 'ok',
    token: session.token,
    agentId: session.agentId,
    equipe: {
      id: equipe.id,
      nom: equipe.nom,
      event_ids: equipe.event_ids,
      evenements: formatAssignedEvents(equipe.event_ids),
    },
    stats,
  });
  } catch (err) {
    return next(err);
  }
});

// GET /api/team/me — État de l'espace équipe & compteurs de contrôle
router.get('/me', requireTeamAuth, async (req, res, next) => {
  let stats;
  try {
    stats = await getTeamStats(req.team.id);
  } catch (err) {
    return next(err);
  }
  return res.json({
    statut: 'ok',
    agentId: req.agentId,
    equipe: {
      id: req.team.id,
      nom: req.team.nom,
      event_ids: req.team.event_ids,
      evenements: formatAssignedEvents(req.team.event_ids),
    },
    stats,
  });
});

export default router;
