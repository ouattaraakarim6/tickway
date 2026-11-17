// src/routes/validate.js — POST /api/validate (validation atomique avec affichage des jusqu'à 5 tickets)
import { Router } from 'express';
import pool from '../db/pool.js';
import { requireApiKey } from '../middleware/auth.js';

const router = Router();

router.post('/', requireApiKey, async (req, res) => {
  const reference = (req.body.reference || '').trim().toUpperCase();

  if (!reference) {
    return res.status(400).json({ statut: 'erreur', message: 'Référence manquante.' });
  }

  // Format attendu : TW-XXXX-XXXX
  if (!/^TW-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(reference)) {
    return res.status(400).json({ statut: 'erreur', message: 'Format de référence invalide.' });
  }

  try {
    // Mise à jour atomique : une seule requête, pas de race condition
    const { rows, rowCount } = await pool.query(
      `UPDATE reservations
       SET statut = 'utilise', utilise_le = now()
       WHERE reference = $1 AND statut = 'valide'
       RETURNING reference, prenom, nom, event_nom, event_date,
                 zone, point_relais, montant, mode_paiement, quantite, utilise_le`,
      [reference]
    );

    if (rowCount === 1) {
      // Billet(s) validé(s) avec succès
      const r = rows[0];
      const quantite = r.quantite || 1;

      // Génération de la liste des N tickets du groupe
      const tickets = [];
      for (let i = 1; i <= quantite; i++) {
        tickets.push({
          numero: i,
          code: `${r.reference}-${i}`,
          label: i === 1 ? `${r.prenom} ${r.nom} (Titulaire)` : `Accompagnateur ${i - 1}`,
          statut: 'valide',
          utiliseLe: r.utilise_le,
        });
      }

      return res.json({
        statut: 'valide_maintenant',
        reference: r.reference,
        passager: `${r.prenom} ${r.nom}`,
        evenement: r.event_nom,
        date: r.event_date,
        zone: r.zone,
        pointRelais: r.point_relais,
        montant: r.montant,
        modePaiement: r.mode_paiement,
        quantite,
        utiliseLe: r.utilise_le,
        tickets,
      });
    }

    // 0 lignes modifiées → soit déjà utilisé, soit introuvable
    const { rows: existing } = await pool.query(
      `SELECT reference, prenom, nom, event_nom, event_date,
              zone, point_relais, montant, mode_paiement, quantite, statut, utilise_le
       FROM reservations WHERE reference = $1`,
      [reference]
    );

    if (existing.length === 0) {
      return res.status(404).json({ statut: 'introuvable', reference });
    }

    // Billet existe mais déjà utilisé
    const r = existing[0];
    const quantite = r.quantite || 1;
    const tickets = [];
    for (let i = 1; i <= quantite; i++) {
      tickets.push({
        numero: i,
        code: `${r.reference}-${i}`,
        label: i === 1 ? `${r.prenom} ${r.nom} (Titulaire)` : `Accompagnateur ${i - 1}`,
        statut: 'utilise',
        utiliseLe: r.utilise_le,
      });
    }

    return res.status(409).json({
      statut: 'deja_utilise',
      reference: r.reference,
      passager: `${r.prenom} ${r.nom}`,
      evenement: r.event_nom,
      date: r.event_date,
      zone: r.zone,
      pointRelais: r.point_relais,
      montant: r.montant,
      quantite,
      utiliseLe: r.utilise_le,
      tickets,
    });
  } catch (err) {
    console.error('[VALIDATE] Erreur :', err);
    return res.status(500).json({ statut: 'erreur', message: 'Erreur interne du serveur.' });
  }
});

export default router;
