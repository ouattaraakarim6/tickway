// src/routes/reservations.js — GET /api/reservations/access, GET /api/reservations/:ref/qr.png et verrouillage création directe
import { Router } from 'express';
import pool from '../db/pool.js';
import { generateQR, generateQRDataUrl } from '../services/qr.js';
import { getGuestTicketsByAccessToken } from '../services/ticketStore.js';

const router = Router();

function resolveBaseOrigin(req) {
  if (process.env.APP_URL && !process.env.APP_URL.includes('localhost')) {
    return process.env.APP_URL.replace(/\/$/, '');
  }
  return req.get('host') ? `${req.protocol}://${req.get('host')}` : 'https://tickway.netlify.app';
}

router.post('/', (req, res) => {
  return res.status(403).json({
    statut: 'erreur',
    code: 'PAYSECUREHUB_REQUIRED',
    message: 'Le paiement exclusif via le Hub sécurisé PaySecureHub est obligatoire (/api/payments/paysecurehub/init).',
  });
});

// GET /api/reservations/access?k=<accessToken> — Retrouver une commande achetée sans compte via son lien sécurisé
router.get('/access', async (req, res) => {
  try {
    const token = String(req.query.k || '').trim();
    if (token.length < 16) {
      return res.status(400).json({ statut: 'erreur', message: 'Lien d’accès invalide.' });
    }
    const baseOrigin = resolveBaseOrigin(req);
    const list = await getGuestTicketsByAccessToken(token, baseOrigin);
    if (!list.length) {
      return res.status(404).json({ statut: 'erreur', message: 'Aucun billet associé à ce lien sécurisé.' });
    }
    const ticketsWithQr = await Promise.all(
      list.map(async (t, i) => ({
        ...t,
        numero: i + 1,
        qrDataUrl: await generateQRDataUrl(t.qrText),
      }))
    );
    return res.json({
      statut: 'ok',
      tickets: ticketsWithQr,
    });
  } catch {
    return res.status(500).json({ statut: 'erreur', message: 'Erreur lors de la récupération des billets.' });
  }
});

// Endpoint pour récupérer directement l'image PNG du QR code (refuse tout billet transféré ou annulé)
router.get('/:reference/qr.png', async (req, res) => {
  const reference = (req.params.reference || '').trim().toUpperCase();
  if (!/^TW-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(reference)) {
    return res.status(400).send('Format de référence invalide.');
  }
  try {
    const { rows } = await pool.query('SELECT statut, qr_text FROM reservations WHERE reference = $1 LIMIT 1', [reference]);
    const row = rows[0];
    if (row && (row.statut === 'en_attente' || row.statut === 'transfere' || row.statut === 'annule')) {
      return res.status(403).send('Billet non actif (en attente de paiement, transféré ou annulé).');
    }
    const baseOrigin = resolveBaseOrigin(req);
    const qrText = (row && row.qr_text)
      || `${baseOrigin}/#controle?c=${encodeURIComponent(reference)}`;
    const qrBuffer = await generateQR(qrText);
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'no-store');
    return res.send(qrBuffer);
  } catch (err) {
    return res.status(500).send('Erreur lors de la génération du QR code.');
  }
});

export default router;
