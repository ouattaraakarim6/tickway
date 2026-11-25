// src/routes/account.js — Espace personnel « Mon compte », billets, commandes et transferts (/api/account/*)
import { Router } from 'express';
import { requireUserAuth } from '../middleware/auth.js';
import { checkRateLockout, recordFailedAttempt, clearFailedAttempts } from '../services/platformStore.js';
import {
  getUserDashboard,
  getUserTicketByReference,
  transferTicket,
  updateUserProfile,
} from '../services/userStore.js';
import { supabaseUpdateUserMetadata } from '../services/supabaseAuth.js';
import { sendTransferOwnerConfirmationEmail, sendTransferRecipientEmail } from '../services/email.js';
import { generateQR } from '../services/qr.js';

const router = Router();
router.use(requireUserAuth);

function resolveFallbackOrigin(req) {
  if (process.env.APP_URL && !process.env.APP_URL.includes('localhost')) {
    return process.env.APP_URL.replace(/\/$/, '');
  }
  return req.get('host') ? `${req.protocol}://${req.get('host')}` : 'https://tickway.netlify.app';
}

// GET /api/account/dashboard — Billets actifs, billets utilisés, commandes et KPI personnels
router.get('/dashboard', async (req, res) => {
  try {
    const dashboard = await getUserDashboard(req.user, resolveFallbackOrigin(req));
    return res.json({
      statut: 'ok',
      user: req.user,
      ...dashboard,
    });
  } catch (err) {
    console.error('[ACCOUNT] Erreur dashboard :', err);
    return res.status(500).json({ statut: 'erreur', message: 'Impossible de charger votre espace personnel.' });
  }
});

// PATCH /api/account/profile — Mise à jour prénom, nom, téléphone (l'identité/e-mail reste verrouillée côté serveur)
router.patch('/profile', async (req, res) => {
  try {
    const { prenom, nom, telephone } = req.body || {};
    const updated = await updateUserProfile({
      userId: req.user.id,
      prenom,
      nom,
      telephone,
    });
    if (req.userToken) {
      await supabaseUpdateUserMetadata(req.userToken, {
        prenom: updated.prenom,
        nom: updated.nom,
        telephone: updated.telephone,
      }).catch(() => {});
    }
    return res.json({
      statut: 'ok',
      user: updated,
      message: 'Informations personnelles mises à jour.',
    });
  } catch (err) {
    return res.status(err.status || 400).json({
      statut: 'erreur',
      message: err.message || 'Impossible de mettre à jour le profil.',
    });
  }
});

// POST /api/account/tickets/:reference/transfer — Transfert atomique d'un billet exclusivement par adresse e-mail
router.post('/tickets/:reference/transfer', async (req, res) => {
  const lockKey = `transfer_user_${req.user.id}`;
  const lock = checkRateLockout(lockKey);
  if (lock.locked) {
    return res.status(429).json({
      statut: 'erreur',
      message: `Trop de tentatives. Réessayez dans ${lock.remainingSec}s.`,
    });
  }

  const body = req.body || {};
  // Restrictions explicites : aucun transfert par téléphone ou WhatsApp
  if (body.whatsapp || body.telephone || body.phone || (body.channel && String(body.channel).toLowerCase() !== 'email')) {
    return res.status(400).json({
      statut: 'erreur',
      code: 'EMAIL_ONLY',
      message: 'Le transfert de billets est autorisé exclusivement par adresse e-mail.',
    });
  }

  const recipientEmail = String(body.recipientEmail || body.email || '').trim();
  if (!recipientEmail) {
    return res.status(400).json({
      statut: 'erreur',
      code: 'RECIPIENT_EMAIL_REQUIRED',
      message: 'Veuillez saisir l’adresse e-mail du destinataire.',
    });
  }

  try {
    const origin = resolveFallbackOrigin(req);
    const result = await transferTicket({
      fromUserId: req.user.id,
      reference: req.params.reference,
      recipientEmail,
      baseOrigin: origin,
    });

    clearFailedAttempts(lockKey);

    const t = result.newTicket;
    const fromName = `${result.fromUser.prenom} ${result.fromUser.nom}`.trim();
    const [recipMail, ownerMail] = await Promise.all([
      sendTransferRecipientEmail({
        to: t.email,
        fromName,
        recipientName: result.transfer.toName,
        eventNom: t.eventNom,
        eventDate: t.eventDate,
        zone: t.zone,
        pointRelais: t.pointRelais,
        categorie: t.categorie,
        newReference: result.newReference,
        qrText: t.qrText,
        ticketsUrl: result.ticketsUrl,
        registerUrl: result.registerUrl,
        hasVerifiedAccount: result.hasVerifiedAccount,
      }).catch(() => ({ delivered: false, channel: 'error' })),
      sendTransferOwnerConfirmationEmail({
        to: result.fromUser.email,
        ownerName: fromName,
        toEmail: t.email,
        eventNom: t.eventNom,
        eventDate: t.eventDate,
        zone: t.zone,
        pointRelais: t.pointRelais,
        categorie: t.categorie,
        oldReference: result.oldReference,
        newReference: result.newReference,
        transferredAt: result.transfer.createdAt,
      }).catch(() => ({ delivered: false, channel: 'error' })),
    ]);

    return res.json({
      statut: 'ok',
      message: `Billet ${result.oldReference} transféré avec succès à ${t.email}. Votre ancien QR code est définitivement invalidé.`,
      oldReference: result.oldReference,
      transfer: result.transfer,
      emailNotifications: {
        recipient: recipMail,
        owner: ownerMail,
      },
    });
  } catch (err) {
    if (err.status && err.status >= 400 && err.status < 500) {
      if (err.code === 'NOT_OWNER') recordFailedAttempt(lockKey);
      return res.status(err.status).json({
        statut: 'erreur',
        code: err.code || 'TRANSFER_ERROR',
        message: err.message,
      });
    }
    console.error('[ACCOUNT] Erreur transfert billet :', err);
    return res.status(500).json({ statut: 'erreur', message: 'Erreur interne lors du transfert du billet.' });
  }
});

// GET /api/account/tickets/:reference/qr.png — QR PNG strictement isolé au propriétaire et bloqué après transfert
router.get('/tickets/:reference/qr.png', async (req, res) => {
  try {
    const ticket = await getUserTicketByReference(req.user, req.params.reference, resolveFallbackOrigin(req));
    if (!ticket) {
      return res.status(404).send('Billet introuvable.');
    }
    if (ticket.invalidated || !ticket.qrText) {
      return res.status(403).send('Ce billet a été transféré ou annulé : son QR code n’est plus valide.');
    }
    const qrBuffer = await generateQR(ticket.qrText);
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'no-store');
    return res.send(qrBuffer);
  } catch {
    return res.status(500).send('Erreur lors de la génération du QR code.');
  }
});

export default router;
