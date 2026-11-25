// src/routes/founder.js — Authentification Fondateur, Dashboard analytique temps réel, Gestion Équipes & Finances
import { Router } from 'express';
import pool from '../db/pool.js';
import { EVENTS } from '../services/events.js';
import {
  checkRateLockout,
  recordFailedAttempt,
  clearFailedAttempts,
  isFounderConfigured,
  setupFounderPassword,
  verifyFounderPassword,
  changeFounderPassword,
  createFounderSession,
  revokeFounderSession,
  getPlatformConfig,
  createTeam,
  updateTeam,
  resetTeamKey,
  deleteTeam,
  getTeamStats,
  updateEventCapacity,
  addExpense,
  deleteExpense,
  updateTransactionFeeRate,
  getTransferConfig,
  updateTransferConfig,
} from '../services/platformStore.js';
import { getAdminTransfersReport } from '../services/userStore.js';
import { requireFounderAuth } from '../middleware/auth.js';

const router = Router();

// GET /api/founder/status — Vérifie si le mot de passe fondateur a déjà été configuré
router.get('/status', (req, res) => {
  return res.json({
    statut: 'ok',
    configured: isFounderConfigured(),
  });
});

// POST /api/founder/setup — Procédure sécurisée de configuration initiale du 2e mot de passe fondateur
router.post('/setup', (req, res) => {
  if (isFounderConfigured()) {
    return res.status(403).json({
      statut: 'erreur',
      message: 'Le mot de passe fondateur est déjà configuré. Utilisez la page de connexion.',
    });
  }
  const password = String(req.body.password || '');
  const confirm = String(req.body.confirmPassword || password);

  if (password.length < 8) {
    return res.status(400).json({
      statut: 'erreur',
      message: 'Le mot de passe fondateur doit contenir au moins 8 caractères.',
    });
  }
  if (password !== confirm) {
    return res.status(400).json({
      statut: 'erreur',
      message: 'Les deux mots de passe ne correspondent pas.',
    });
  }

  try {
    setupFounderPassword(password);
    const session = createFounderSession(req.ip || 'local');
    return res.status(201).json({
      statut: 'ok',
      message: 'Mot de passe fondateur configuré avec succès.',
      token: session.token,
      timeoutMs: session.timeoutMs,
    });
  } catch (err) {
    return res.status(400).json({ statut: 'erreur', message: err.message });
  }
});

// POST /api/founder/login — Connexion au Dashboard Fondateur (2e mot de passe indépendant)
router.post('/login', (req, res) => {
  const bucket = `founder:${req.ip || 'local'}`;
  const lock = checkRateLockout(bucket);
  if (lock.locked) {
    return res.status(429).json({
      statut: 'erreur',
      message: `Protection anti-intrusion active. Réessayez dans ${lock.remainingSec} secondes.`,
    });
  }

  if (!isFounderConfigured()) {
    return res.status(400).json({
      statut: 'non_configure',
      message: "Le mot de passe fondateur n'est pas encore configuré. Configurez-le d'abord.",
    });
  }

  const password = String(req.body.password || '');
  if (!password) {
    return res.status(400).json({
      statut: 'erreur',
      message: 'Mot de passe fondateur requis.',
    });
  }

  const ok = verifyFounderPassword(password);
  if (!ok) {
    const fail = recordFailedAttempt(bucket);
    return res.status(401).json({
      statut: 'erreur',
      message: fail.locked
        ? 'Mot de passe fondateur incorrect. Compte verrouillé pendant 5 minutes.'
        : `Mot de passe fondateur incorrect (${fail.attemptsLeft} essai(s) restant(s)).`,
    });
  }

  clearFailedAttempts(bucket);
  const session = createFounderSession(req.ip || 'local');
  return res.json({
    statut: 'ok',
    token: session.token,
    timeoutMs: session.timeoutMs,
  });
});

// POST /api/founder/logout — Déconnexion explicite
router.post('/logout', (req, res) => {
  const token = String(req.headers['x-founder-token'] || '').trim();
  revokeFounderSession(token);
  return res.json({ statut: 'ok' });
});

// POST /api/founder/password — Changement du mot de passe fondateur
router.post('/password', requireFounderAuth, (req, res) => {
  try {
    changeFounderPassword(req.body.currentPassword, req.body.newPassword);
    return res.json({ statut: 'ok', message: 'Mot de passe fondateur mis à jour.' });
  } catch (err) {
    return res.status(400).json({ statut: 'erreur', message: err.message });
  }
});

// ── Agrégation analytique temps réel du Dashboard Fondateur ──
function filterByPeriod(rows, period) {
  if (!period || period === 'all') return rows;
  const now = Date.now();
  let cutoffMs = 0;
  if (period === 'day') {
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    cutoffMs = startOfToday.getTime();
  } else if (period === 'week') {
    cutoffMs = now - 7 * 24 * 60 * 60 * 1000;
  } else if (period === 'month') {
    cutoffMs = now - 30 * 24 * 60 * 60 * 1000;
  }
  if (!cutoffMs) return rows;
  return rows.filter((r) => {
    const t = r.cree_le ? new Date(r.cree_le).getTime() : 0;
    return t >= cutoffMs;
  });
}

router.get('/dashboard', requireFounderAuth, async (req, res) => {
  const period = String(req.query.period || 'all').trim();
  const eventFilter = String(req.query.eventId || 'all').trim();

  try {
    const { rows: allRows } = await pool.query('SELECT * FROM reservations ORDER BY cree_le DESC');
    const cfg = getPlatformConfig();
    const capacities = cfg.capacities || {};

    // Filtrage période + événement
    const periodRows = filterByPeriod(allRows, period);
    const filteredRows = (eventFilter && eventFilter !== 'all')
      ? periodRows.filter((r) => r.event_id === eventFilter)
      : periodRows;

    // Capacité totale applicable au filtre d'événement
    let capaciteTotaleFiltree = 0;
    for (const ev of EVENTS) {
      if (eventFilter === 'all' || ev.id === eventFilter) {
        capaciteTotaleFiltree += Number(capacities[ev.id]) || 500;
      }
    }

    // ── A. VUE D'ENSEMBLE & C. FINANCES ──
    let totalTicketsVendus = 0;
    let ticketsPayes = 0;
    let paiementsEnAttente = 0;
    let ticketsAnnules = 0;
    let ticketsUtilises = 0;

    let chiffreAffairesTotal = 0;
    let chiffreAffairesBrut = 0;
    let totalPaiementsConfirmes = 0;
    let totalPaiementsEnAttente = 0;
    let montantRemboursements = 0;
    let fraisTransactionDisponibles = 0;

    const commandesSet = new Set();
    const geoMap = new Map();
    const catMap = new Map();
    const dailyMap = new Map();

    for (const r of filteredRows) {
      const q = Math.max(1, Number(r.quantite) || 1);
      const m = Math.max(0, Number(r.montant) || 0);
      const st = r.statut || 'valide';
      const cmdKey = r.commande_id || r.reference;

      if (st === 'transfere') {
        // Billet transféré : remplacé par le nouveau billet du destinataire (ne pas compter deux fois dans le CA ni la capacité)
        continue;
      }

      if (st === 'annule') {
        ticketsAnnules += q;
        montantRemboursements += m;
        continue;
      }

      if (st === 'en_attente') {
        paiementsEnAttente += q;
        totalPaiementsEnAttente += m;
        chiffreAffairesBrut += m;
        commandesSet.add(cmdKey);
        continue;
      }

      // Ticket payé ('valide' ou 'utilise')
      totalTicketsVendus += q;
      ticketsPayes += q;
      if (st === 'utilise') {
        ticketsUtilises += q;
      }

      chiffreAffairesTotal += m;
      chiffreAffairesBrut += m;
      totalPaiementsConfirmes += m;
      commandesSet.add(cmdKey);

      const fraisRow = r.frais_transaction !== undefined && Number(r.frais_transaction) > 0
        ? Number(r.frais_transaction)
        : (cfg.frais_taux_pct > 0 ? Math.round((m * cfg.frais_taux_pct) / 100) : 0);
      fraisTransactionDisponibles += fraisRow;

      // B. Répartition géographique basée sur le point relais sélectionné lors de l'achat
      const relayCommune = String(r.point_relais || '').split(',')[0].trim();
      const locRaw = relayCommune || (r.localite || '').trim();
      const locName = (locRaw && locRaw !== 'Point relais') ? locRaw : 'Localité non renseignée';
      if (!geoMap.has(locName)) {
        geoMap.set(locName, { localite: locName, ticketsVendus: 0, chiffreAffaires: 0 });
      }
      const g = geoMap.get(locName);
      g.ticketsVendus += q;
      g.chiffreAffaires += m;

      // C. Répartition par catégorie de ticket
      const catName = (r.categorie || 'Standard Navette').trim() || 'Standard Navette';
      const unitPrice = q > 0 ? Math.round(m / q) : 6000;
      if (!catMap.has(catName)) {
        catMap.set(catName, {
          categorie: catName,
          prixUnitaire: unitPrice,
          quantiteVendue: 0,
          recetteTotale: 0,
        });
      }
      const c = catMap.get(catName);
      c.quantiteVendue += q;
      c.recetteTotale += m;

      // D. Évolution quotidienne des ventes et du CA
      const dayKey = r.cree_le ? new Date(r.cree_le).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10);
      if (!dailyMap.has(dayKey)) {
        dailyMap.set(dayKey, { date: dayKey, tickets: 0, chiffreAffaires: 0 });
      }
      const d = dailyMap.get(dayKey);
      d.tickets += q;
      d.chiffreAffaires += m;
    }

    const ticketsDisponibles = Math.max(0, capaciteTotaleFiltree - totalTicketsVendus);
    const totalCommandes = commandesSet.size;
    const panierMoyen = totalCommandes > 0 ? Math.round(chiffreAffairesTotal / totalCommandes) : 0;
    const recettesNettesApresFrais = Math.max(0, totalPaiementsConfirmes - fraisTransactionDisponibles);

    // Dépenses enregistrées (ne jamais afficher un bénéfice si aucune dépense n'est enregistrée)
    const allExpenses = Array.isArray(cfg.expenses) ? cfg.expenses : [];
    const filteredExpenses = (eventFilter && eventFilter !== 'all')
      ? allExpenses.filter((e) => e.event_id === '*' || e.event_id === eventFilter)
      : allExpenses;
    const totalDepenses = filteredExpenses.reduce((acc, e) => acc + (Number(e.montant) || 0), 0);
    const hasExpenses = filteredExpenses.length > 0;
    const beneficeNet = hasExpenses ? (recettesNettesApresFrais - totalDepenses) : null;

    // Classement des localités
    const repartitionGeographique = [...geoMap.values()]
      .sort((a, b) => (b.ticketsVendus - a.ticketsVendus) || (b.chiffreAffaires - a.chiffreAffaires))
      .map((item, idx) => ({
        rang: idx + 1,
        localite: item.localite,
        ticketsVendus: item.ticketsVendus,
        chiffreAffaires: item.chiffreAffaires,
        pourcentageVentes: totalTicketsVendus > 0
          ? Number(((item.ticketsVendus / totalTicketsVendus) * 100).toFixed(1))
          : 0,
      }));

    // Tableau détaillé des catégories de tickets
    const repartitionCategories = [...catMap.values()].map((item) => ({
      ...item,
      quantiteRestante: ticketsDisponibles,
    }));
    if (repartitionCategories.length === 0) {
      repartitionCategories.push({
        categorie: 'Standard Navette',
        prixUnitaire: 6000,
        quantiteVendue: 0,
        recetteTotale: 0,
        quantiteRestante: ticketsDisponibles,
      });
    }

    // Évolution quotidienne triée chronologiquement
    const evolutionQuotidienne = [...dailyMap.values()].sort((a, b) => a.date.localeCompare(b.date));

    // E. Statistiques par événement (sur l'ensemble de la période sélectionnée)
    const evenementsStats = EVENTS.map((ev) => {
      const cap = Number(capacities[ev.id]) || 500;
      const evRows = periodRows.filter((r) => r.event_id === ev.id);
      let vendus = 0;
      let ca = 0;
      let scannes = 0;
      let personnesEntrees = 0;
      let personnesAttendues = 0;

      for (const r of evRows) {
        const q = Math.max(1, Number(r.quantite) || 1);
        const m = Math.max(0, Number(r.montant) || 0);
        const st = r.statut || 'valide';
        if (st === 'valide' || st === 'utilise') {
          vendus += q;
          ca += m;
          if (st === 'utilise') {
            scannes += q;
            personnesEntrees += q;
          } else {
            personnesAttendues += q;
          }
        }
      }

      return {
        id: ev.id,
        nom: ev.n,
        type: ev.t,
        date: ev.h ? `${ev.d}, ${ev.h}` : ev.d,
        prixUnitaire: ev.p,
        ticketsDisponiblesTotal: cap,
        ticketsVendus: vendus,
        ticketsRestants: Math.max(0, cap - vendus),
        chiffreAffaires: ca,
        ticketsScannes: scannes,
        personnesEntrees,
        personnesAttendues,
      };
    });

    // 5. Équipes & statistiques par agent
    const equipes = (cfg.equipes || []).map((eq) => ({
      id: eq.id,
      nom: eq.nom,
      cle_hint: eq.cle_hint,
      event_ids: eq.event_ids,
      actif: eq.actif,
      cree_le: eq.cree_le,
      stats: getTeamStats(eq.id),
    }));

    // 6. Liste détaillée des ventes réelles
    const ventes = filteredRows.map((r) => ({
      reference: r.reference,
      commandeId: r.commande_id || r.reference,
      client: `${r.prenom || ''} ${r.nom || ''}`.trim(),
      prenom: r.prenom,
      nom: r.nom,
      telephone: r.telephone,
      email: r.email,
      eventId: r.event_id,
      evenement: r.event_nom,
      eventDate: r.event_date,
      categorie: r.categorie || 'Standard Navette',
      zone: r.zone,
      pointRelais: r.point_relais,
      localite: String(r.point_relais || '').split(',')[0].trim() || (r.localite || '').trim() || 'Localité non renseignée',
      quantite: Number(r.quantite) || 1,
      montant: Number(r.montant) || 0,
      fraisTransaction: Number(r.frais_transaction) || 0,
      modePaiement: r.mode_paiement,
      statut: r.statut || 'valide',
      dateAchat: r.cree_le,
      utiliseLe: r.utilise_le || null,
      agentId: r.agent_id || null,
      equipeNom: r.equipe_nom || null,
    }));

    return res.json({
      statut: 'ok',
      filtres: { period, eventId: eventFilter },
      vueEnsemble: {
        totalTicketsVendus,
        ticketsPayes,
        paiementsEnAttente,
        ticketsAnnules,
        ticketsUtilises,
        ticketsDisponibles,
        capaciteTotale: capaciteTotaleFiltree,
        totalCommandes,
        chiffreAffairesTotal,
        panierMoyen,
      },
      repartitionGeographique,
      finances: {
        chiffreAffairesBrut,
        totalPaiementsConfirmes,
        totalPaiementsEnAttente,
        montantRemboursements,
        fraisTransactionDisponibles,
        fraisTauxPct: cfg.frais_taux_pct || 0,
        recettesNettesApresFrais,
        depenses: filteredExpenses,
        totalDepenses,
        hasExpenses,
        beneficeNet,
        repartitionCategories,
      },
      graphiques: {
        evolutionQuotidienne,
        repartitionGeographique,
        repartitionCategories,
        comparaisonEvenements: evenementsStats,
        comparaisonVendusDisponibles: {
          vendus: totalTicketsVendus,
          disponibles: ticketsDisponibles,
          capaciteTotale: capaciteTotaleFiltree,
        },
      },
      evenements: evenementsStats,
      equipes,
      scansLog: (cfg.scans_log || []).slice(0, 100),
      transferts: await getAdminTransfersReport(),
      ventes,
    });
  } catch (err) {
    console.error('[FOUNDER DASHBOARD] Erreur :', err);
    return res.status(500).json({ statut: 'erreur', message: 'Erreur lors du calcul des statistiques.' });
  }
});

// ── 5. GESTION DES ÉQUIPES (Création, attribution événement, désactivation, réinitialisation clé) ──
router.post('/teams', requireFounderAuth, (req, res) => {
  try {
    const { nom, eventIds } = req.body;
    const { team, plainKey } = createTeam({ nom, eventIds });
    return res.status(201).json({
      statut: 'ok',
      message: 'Nouvelle équipe créée avec succès.',
      team: {
        id: team.id,
        nom: team.nom,
        cle_hint: team.cle_hint,
        event_ids: team.event_ids,
        actif: team.actif,
        cree_le: team.cree_le,
      },
      plainKey,
    });
  } catch (err) {
    return res.status(400).json({ statut: 'erreur', message: err.message });
  }
});

router.patch('/teams/:id', requireFounderAuth, (req, res) => {
  const team = updateTeam(req.params.id, {
    nom: req.body.nom,
    eventIds: req.body.eventIds,
    actif: req.body.actif,
  });
  if (!team) {
    return res.status(404).json({ statut: 'erreur', message: 'Équipe introuvable.' });
  }
  return res.json({
    statut: 'ok',
    message: 'Équipe mise à jour.',
    team: {
      id: team.id,
      nom: team.nom,
      cle_hint: team.cle_hint,
      event_ids: team.event_ids,
      actif: team.actif,
      cree_le: team.cree_le,
    },
  });
});

router.post('/teams/:id/reset-key', requireFounderAuth, (req, res) => {
  const result = resetTeamKey(req.params.id);
  if (!result) {
    return res.status(404).json({ statut: 'erreur', message: 'Équipe introuvable.' });
  }
  return res.json({
    statut: 'ok',
    message: 'Nouvelle clé équipe générée.',
    team: {
      id: result.team.id,
      nom: result.team.nom,
      cle_hint: result.team.cle_hint,
      event_ids: result.team.event_ids,
      actif: result.team.actif,
    },
    plainKey: result.plainKey,
  });
});

router.delete('/teams/:id', requireFounderAuth, (req, res) => {
  try {
    const ok = deleteTeam(req.params.id);
    if (!ok) return res.status(404).json({ statut: 'erreur', message: 'Équipe introuvable.' });
    return res.json({ statut: 'ok', message: 'Équipe supprimée.' });
  } catch (err) {
    return res.status(400).json({ statut: 'erreur', message: err.message });
  }
});

// ── Gestion des capacités d'événements, frais & dépenses ──
router.post('/capacity', requireFounderAuth, (req, res) => {
  const { eventId, capacity } = req.body;
  if (!eventId) return res.status(400).json({ statut: 'erreur', message: 'Événement requis.' });
  const capacities = updateEventCapacity(eventId, capacity);
  return res.json({ statut: 'ok', capacities });
});

router.post('/expenses', requireFounderAuth, (req, res) => {
  try {
    const expenses = addExpense({
      libelle: req.body.libelle,
      montant: req.body.montant,
      eventId: req.body.eventId,
    });
    return res.status(201).json({ statut: 'ok', expenses });
  } catch (err) {
    return res.status(400).json({ statut: 'erreur', message: err.message });
  }
});

router.delete('/expenses/:id', requireFounderAuth, (req, res) => {
  const expenses = deleteExpense(req.params.id);
  return res.json({ statut: 'ok', expenses });
});

router.post('/fees', requireFounderAuth, (req, res) => {
  const pct = updateTransactionFeeRate(req.body.fraisTauxPct);
  return res.json({ statut: 'ok', fraisTauxPct: pct });
});

// ── Gestion & historique des transferts de billets (Administration) ──
router.get('/transfers', requireFounderAuth, async (req, res) => {
  try {
    const report = await getAdminTransfersReport();
    return res.json({ statut: 'ok', ...report });
  } catch (err) {
    return res.status(500).json({ statut: 'erreur', message: 'Impossible de charger les transferts.' });
  }
});

router.post('/transfer-config', requireFounderAuth, (req, res) => {
  const { enabled, maxTransfersPerTicket, maxTransfersPerUser } = req.body || {};
  const config = updateTransferConfig({ enabled, maxTransfersPerTicket, maxTransfersPerUser });
  return res.json({
    statut: 'ok',
    message: 'Paramètres de transfert mis à jour.',
    config,
  });
});

// Mise à jour du statut d'un ticket (valide, en_attente, annule) par le fondateur
router.patch('/reservations/:reference/statut', requireFounderAuth, async (req, res) => {
  const reference = String(req.params.reference || '').trim().toUpperCase();
  const nouveauStatut = String(req.body.statut || '').trim();
  if (!['valide', 'en_attente', 'annule'].includes(nouveauStatut)) {
    return res.status(400).json({ statut: 'erreur', message: 'Statut invalide.' });
  }
  try {
    const { rows, rowCount } = await pool.query(
      `UPDATE reservations SET statut = $2 WHERE reference = $1 RETURNING *`,
      [reference, nouveauStatut]
    );
    if (rowCount === 0) {
      return res.status(404).json({ statut: 'erreur', message: 'Ticket introuvable.' });
    }
    return res.json({ statut: 'ok', ticket: rows[0] });
  } catch (err) {
    return res.status(500).json({ statut: 'erreur', message: err.message });
  }
});

export default router;
