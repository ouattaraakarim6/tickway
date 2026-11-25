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
              zone, point_relais, montant, mode_paiement, quantite, statut, qr_text
       FROM reservations WHERE reference = $1`,
      [references[0]]
    );

    if (rows.length === 0) {
      return res.status(404).json({ statut: 'erreur', message: 'Réservation introuvable.' });
    }

    const r = rows[0];
    if (r.statut === 'en_attente') {
      return res.status(403).json({
        statut: 'erreur',
        message: 'Paiement en attente de confirmation : vos billets seront envoyés dès validation du paiement.',
      });
    }
    if (r.statut === 'transfere' || r.statut === 'annule') {
      return res.status(403).json({
        statut: 'erreur',
        message: 'Impossible de renvoyer ce billet : il a été transféré ou annulé.',
      });
    }
    const cleanNom = r.nom.replace(/\s*\(Ticket \d+\/\d+\)$/, '');
    const baseOrigin = (process.env.APP_URL && !process.env.APP_URL.includes('localhost'))
      ? process.env.APP_URL.replace(/\/$/, '')
      : (req.get('host') ? `${req.protocol}://${req.get('host')}` : 'https://tickway.netlify.app');

    const tickets = await Promise.all(
      references.map(async (ref, idx) => {
        const resRow = idx === 0
          ? r
          : ((await pool.query(`SELECT qr_text FROM reservations WHERE reference = $1`, [ref])).rows[0] || {});
        const qrText = resRow.qr_text || `${baseOrigin}/#controle?c=${encodeURIComponent(ref)}`;
        return {
          numero: idx + 1,
          reference: ref,
          code: ref,
          qrText,
          qrDataUrl: await generateQRDataUrl(qrText),
        };
      })
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
