// src/routes/validate.js — POST /api/validate (contrôle atomique anti-double-scan, vérification événement & équipe)
import { Router } from 'express';
import pool from '../db/pool.js';
import { requireTeamAuth } from '../middleware/auth.js';
import { recordScanLog, getTeamStats } from '../services/platformStore.js';

const router = Router();

router.post('/', requireTeamAuth, async (req, res, next) => {
  try {
    return await handleValidate(req, res);
  } catch (err) {
    return next(err);
  }
});

async function handleValidate(req, res) {
  const reference = String(req.body.reference || '').trim().toUpperCase().slice(0, 64);
  const agentId = String(req.body.agentId || req.agentId || 'Agent Terrain').trim().slice(0, 40);
  const equipe = req.team;

  if (!reference) {
    return res.status(400).json({
      statut: 'erreur',
      couleur: 'ROUGE',
      message: 'Référence du ticket manquante.',
    });
  }

  // Format attendu : TW-XXXX-XXXX
  if (!/^TW-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(reference)) {
    await recordScanLog({
      reference,
      passager: 'Inconnu',
      eventId: null,
      eventNom: 'Format invalide',
      resultat: 'invalide',
      raison: 'Format QR Code invalide',
      agentId,
      equipeId: equipe.id,
      equipeNom: equipe.nom,
    });
    return res.status(400).json({
      statut: 'invalide',
      couleur: 'ROUGE',
      reference,
      message: 'ENTRÉE REFUSÉE — Format de ticket invalide.',
      stats: await getTeamStats(equipe.id),
    });
  }

  try {
    // 1. Vérifier l'existence du ticket, l'événement associé et le statut de paiement
    const { rows: checkRows } = await pool.query(
      `SELECT reference, commande_id, prenom, nom, event_id, event_nom, event_date,
              categorie, zone, point_relais, mode_paiement, quantite, statut,
              utilise_le, agent_id, equipe_id, equipe_nom
       FROM reservations WHERE reference = $1`,
      [reference]
    );

    if (checkRows.length === 0) {
      await recordScanLog({
        reference,
        passager: 'Introuvable',
        eventId: null,
        eventNom: 'Inconnu',
        resultat: 'invalide',
        raison: 'Ticket inexistant en base de données',
        agentId,
        equipeId: equipe.id,
        equipeNom: equipe.nom,
      });
      return res.status(404).json({
        statut: 'introuvable',
        couleur: 'ROUGE',
        reference,
        message: 'ENTRÉE REFUSÉE — Ticket introuvable dans la base de données.',
        stats: await getTeamStats(equipe.id),
      });
    }

    const ticket = checkRows[0];
    const passagerNom = `${ticket.prenom} ${ticket.nom}`;

    // 2. Vérifier que l'événement est bien attribué à l'équipe de l'agent
    const allowedEvents = Array.isArray(equipe.event_ids) ? equipe.event_ids : ['*'];
    if (!allowedEvents.includes('*') && !allowedEvents.includes(ticket.event_id)) {
      await recordScanLog({
        reference,
        passager: passagerNom,
        eventId: ticket.event_id,
        eventNom: ticket.event_nom,
        resultat: 'invalide',
        raison: `Événement non attribué à l'équipe (${ticket.event_nom})`,
        agentId,
        equipeId: equipe.id,
        equipeNom: equipe.nom,
      });
      return res.status(403).json({
        statut: 'event_non_autorise',
        couleur: 'ROUGE',
        reference,
        passager: passagerNom,
        evenement: ticket.event_nom,
        date: ticket.event_date,
        message: `ENTRÉE REFUSÉE — Votre équipe n'est pas affectée à l'événement « ${ticket.event_nom} ».`,
        stats: await getTeamStats(equipe.id),
      });
    }

    // 3. Vérifier l'invalidation par transfert, le paiement et la validité du ticket
    if (ticket.statut === 'transfere') {
      await recordScanLog({
        reference,
        passager: passagerNom,
        eventId: ticket.event_id,
        eventNom: ticket.event_nom,
        resultat: 'invalide',
        raison: 'Billet transféré (ancien QR code invalidé)',
        agentId,
        equipeId: equipe.id,
        equipeNom: equipe.nom,
      });
      return res.status(403).json({
        statut: 'transfere',
        couleur: 'ROUGE',
        reference,
        passager: passagerNom,
        evenement: ticket.event_nom,
        date: ticket.event_date,
        statutPaiement: 'Ancien QR code invalidé après transfert',
        message: 'ENTRÉE REFUSÉE — Ce billet a été transféré à un autre bénéficiaire : cet ancien QR code est définitivement invalidé.',
        stats: await getTeamStats(equipe.id),
      });
    }

    if (ticket.statut === 'en_attente' || ticket.statut === 'annule') {
      const raison = ticket.statut === 'en_attente'
        ? 'Paiement non confirmé (en attente)'
        : 'Ticket annulé / remboursé';
      await recordScanLog({
        reference,
        passager: passagerNom,
        eventId: ticket.event_id,
        eventNom: ticket.event_nom,
        resultat: 'invalide',
        raison,
        agentId,
        equipeId: equipe.id,
        equipeNom: equipe.nom,
      });
      return res.status(403).json({
        statut: 'paiement_invalide',
        couleur: 'ROUGE',
        reference,
        passager: passagerNom,
        evenement: ticket.event_nom,
        date: ticket.event_date,
        statutPaiement: raison,
        message: `ENTRÉE REFUSÉE — ${raison}.`,
        stats: await getTeamStats(equipe.id),
      });
    }

    // 4. Mise à jour atomique : empêche tout double scan simultané par plusieurs agents
    // (MySQL : l'UPDATE conditionnel est atomique ; affectedRows === 1 garantit qu'un seul agent valide le billet)
    const { rowCount } = await pool.query(
      `UPDATE reservations
       SET statut = 'utilise', utilise_le = UTC_TIMESTAMP(3), agent_id = $2, equipe_id = $3, equipe_nom = $4
       WHERE reference = $1 AND statut = 'valide'`,
      [reference, agentId, equipe.id, equipe.nom]
    );

    if (rowCount === 1) {
      // VERT : Ticket valide, entrée autorisée
      const { rows } = await pool.query(
        `SELECT reference, prenom, nom, event_id, event_nom, event_date,
                categorie, zone, point_relais, mode_paiement, quantite, utilise_le, agent_id, equipe_nom
         FROM reservations WHERE reference = $1`,
        [reference]
      );
      const r = rows[0];
      const quantite = r.quantite || 1;
      const tickets = [];
      for (let i = 1; i <= quantite; i++) {
        tickets.push({
          numero: i,
          code: quantite > 1 ? `${r.reference}-${i}` : r.reference,
          label: i === 1 ? `${r.prenom} ${r.nom} (Titulaire)` : `Accompagnateur ${i - 1}`,
          statut: 'valide',
          utiliseLe: r.utilise_le,
        });
      }

      const scanEntry = await recordScanLog({
        reference: r.reference,
        passager: `${r.prenom} ${r.nom}`,
        eventId: r.event_id,
        eventNom: r.event_nom,
        resultat: 'valide',
        raison: 'Entrée autorisée',
        agentId,
        equipeId: equipe.id,
        equipeNom: equipe.nom,
      });

      return res.json({
        statut: 'valide_maintenant',
        couleur: 'VERT',
        message: 'TICKET VALIDE — ENTRÉE AUTORISÉE',
        reference: r.reference,
        passager: `${r.prenom} ${r.nom}`,
        evenement: r.event_nom,
        eventId: r.event_id,
        date: r.event_date,
        categorie: r.categorie || 'Standard Navette',
        zone: r.zone,
        pointRelais: r.point_relais,
        statutPaiement: 'Payé & Confirmé',
        quantite,
        utiliseLe: r.utilise_le,
        agentId,
        equipeNom: equipe.nom,
        tickets,
        scan: scanEntry,
        stats: await getTeamStats(equipe.id),
      });
    }

    // 5. rowCount === 0 → Le ticket a déjà été scanné (ORANGE)
    const { rows: afterRows } = await pool.query(
      `SELECT reference, prenom, nom, event_id, event_nom, event_date,
              categorie, zone, point_relais, quantite, statut, utilise_le, agent_id, equipe_nom
       FROM reservations WHERE reference = $1`,
      [reference]
    );
    const r = afterRows[0] || ticket;
    const quantite = r.quantite || 1;
    const tickets = [];
    for (let i = 1; i <= quantite; i++) {
      tickets.push({
        numero: i,
        code: quantite > 1 ? `${r.reference}-${i}` : r.reference,
        label: i === 1 ? `${r.prenom} ${r.nom} (Titulaire)` : `Accompagnateur ${i - 1}`,
        statut: 'utilise',
        utiliseLe: r.utilise_le,
      });
    }

    const scanEntry = await recordScanLog({
      reference: r.reference,
      passager: `${r.prenom} ${r.nom}`,
      eventId: r.event_id,
      eventNom: r.event_nom,
      resultat: 'deja_utilise',
      raison: `Déjà scanné${r.agent_id ? ' par ' + r.agent_id : ''}`,
      agentId,
      equipeId: equipe.id,
      equipeNom: equipe.nom,
    });

    return res.status(409).json({
      statut: 'deja_utilise',
      couleur: 'ORANGE',
      message: 'TICKET DÉJÀ UTILISÉ — ENTRÉE REFUSÉE',
      reference: r.reference,
      passager: `${r.prenom} ${r.nom}`,
      evenement: r.event_nom,
      eventId: r.event_id,
      date: r.event_date,
      categorie: r.categorie || 'Standard Navette',
      zone: r.zone,
      pointRelais: r.point_relais,
      statutPaiement: 'Payé (Déjà scanné)',
      quantite,
      utiliseLe: r.utilise_le,
      scanneParAgent: r.agent_id || 'Agent Terrain',
      scanneParEquipe: r.equipe_nom || 'Équipe Terrain',
      tickets,
      scan: scanEntry,
      stats: await getTeamStats(equipe.id),
    });
  } catch (err) {
    console.error('[VALIDATE] Erreur :', err);
    return res.status(500).json({
      statut: 'erreur',
      couleur: 'ROUGE',
      message: 'Erreur interne du serveur lors de la vérification.',
    });
  }
}

export default router;
