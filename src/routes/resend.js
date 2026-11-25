// src/routes/resend.js — POST /api/resend (renvoi de l'e-mail du billet)
import { Router } from 'express';
import pool from '../db/pool.js';
import { generateQRDataUrl } from '../services/qr.js';
import { sendTicketEmail } from '../services/email.js';

const router = Router();
const REF_RE = /^TW-[A-Z0-9]{4}-[A-Z0-9]{4}$/;
const MAX_REFS = 5;

function maskEmail(email) {
  const [user, domain] = String(email || '').split('@');
  if (!domain) return '***';
  const visible = user.slice(0, Math.min(2, user.length));
  return `${visible}${'*'.repeat(Math.max(1, user.length - visible.length))}@${domain}`;
}

router.post('/', async (req, res) => {
  const rawRefs = Array.isArray(req.body.references) && req.body.references.length > 0
    ? req.body.references
    : [req.body.reference];
  const references = [...new Set(
    rawRefs.map((s) => String(s || '').trim().toUpperCase()).filter((s) => REF_RE.test(s))
  )].slice(0, MAX_REFS);

  if (references.length === 0) {
    return res.status(400).json({ statut: 'erreur', message: 'Référence manquante ou invalide.' });
  }

  try {
    const { rows } = await pool.query(
      `SELECT reference, commande_id, prenom, nom, email, telephone, event_nom, event_date,
              zone, point_relais, montant, mode_paiement, quantite, statut, qr_text
       FROM reservations WHERE reference IN (?)`,
      [references]
    );
    const byRef = new Map(rows.map((r) => [r.reference, r]));
    const r = byRef.get(references[0]);

    if (!r) {
      return res.status(404).json({ statut: 'erreur', message: 'Réservation introuvable.' });
    }
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

    // Sécurité : seuls les billets actifs de la MÊME commande sont renvoyés, et uniquement à l'e-mail de cette commande.
    // (empêche de se faire envoyer les QR codes d'autres clients en ajoutant leurs références)
    const orderKey = r.commande_id || r.reference;
    const sameOrderRows = references
      .map((ref) => byRef.get(ref))
      .filter((row) => row
        && (row.commande_id || row.reference) === orderKey
        && (row.statut === 'valide' || row.statut === 'utilise'));

    const cleanNom = String(r.nom || '').replace(/\s*\(Ticket \d+\/\d+\)$/, '');
    const baseOrigin = (process.env.APP_URL && !process.env.APP_URL.includes('localhost'))
      ? process.env.APP_URL.replace(/\/$/, '')
      : (req.get('host') ? `${req.protocol}://${req.get('host')}` : 'https://tickway.netlify.app');

    const tickets = await Promise.all(
      sameOrderRows.map(async (row, idx) => {
        const qrText = row.qr_text || `${baseOrigin}/#controle?c=${encodeURIComponent(row.reference)}`;
        return {
          numero: idx + 1,
          reference: row.reference,
          code: row.reference,
          qrText,
          qrDataUrl: await generateQRDataUrl(qrText),
        };
      })
    );
    const refs = sameOrderRows.map((row) => row.reference);

    const reservation = {
      ...r,
      nom: cleanNom,
      reference: refs.join(', '),
      references: refs,
      quantite: refs.length,
      montant: Number(r.montant) * refs.length,
      tickets,
    };

    await sendTicketEmail({ to: r.email, reservation, qrDataUrl: tickets[0].qrDataUrl });

    return res.json({ statut: 'ok', message: `E-mail renvoyé à ${maskEmail(r.email)}.` });
  } catch (err) {
    console.error('[RESEND] Erreur :', err);
    return res.status(500).json({ statut: 'erreur', message: 'Erreur interne du serveur.' });
  }
});

export default router;
