// src/routes/resend.js — POST /api/resend (renvoi de l'e-mail du billet)
import { Router } from 'express';
import pool from '../db/pool.js';
import { generateQR, generateQRDataUrl } from '../services/qr.js';
import { sendTicketEmail } from '../services/email.js';

const router = Router();

router.post('/', async (req, res) => {
  const rawRefs = Array.isArray(req.body.references) && req.body.references.length > 0
    ? req.body.references
    : [req.body.reference];
  const references = rawRefs.map((s) => (s || '').trim().toUpperCase()).filter(Boolean);

  if (references.length === 0) {
    return res.status(400).json({ statut: 'erreur', message: 'Référence manquante.' });
  }

  try {
    const { rows } = await pool.query(
      `SELECT reference, prenom, nom, email, telephone, event_nom, event_date,
              zone, point_relais, montant, mode_paiement, quantite
       FROM reservations WHERE reference = $1`,
      [references[0]]
    );

    if (rows.length === 0) {
      return res.status(404).json({ statut: 'erreur', message: 'Réservation introuvable.' });
    }

    const r = rows[0];
    const cleanNom = r.nom.replace(/\s*\(Ticket \d+\/\d+\)$/, '');
    const tickets = await Promise.all(
      references.map(async (ref, idx) => ({
        numero: idx + 1,
        reference: ref,
        code: ref,
        qrDataUrl: await generateQRDataUrl(ref),
      }))
    );

    const reservation = {
      ...r,
      nom: cleanNom,
      reference: references.join(', '),
      references,
      quantite: references.length,
      montant: Number(r.montant) * references.length,
      tickets,
    };

    await sendTicketEmail({ to: r.email, reservation, qrDataUrl: tickets[0].qrDataUrl });

    return res.json({ statut: 'ok', message: `E-mail renvoyé à ${r.email}.` });
  } catch (err) {
    console.error('[RESEND] Erreur :', err);
    return res.status(500).json({ statut: 'erreur', message: 'Erreur interne du serveur.' });
  }
});

export default router;
