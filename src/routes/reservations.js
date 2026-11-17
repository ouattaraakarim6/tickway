// src/routes/reservations.js — POST /api/reservations et GET /api/reservations/:ref/qr.png
import { Router } from 'express';
import pool from '../db/pool.js';
import { generateReference } from '../services/reference.js';
import { generateQR, generateQRDataUrl } from '../services/qr.js';
import { sendTicketEmail } from '../services/email.js';
import { findEvent, findRelais, PAIEMENTS } from '../services/events.js';
import { validateReservation } from '../middleware/validate.js';

const router = Router();

router.post('/', async (req, res) => {
  // 1. Validation
  const { valid, errors, sanitized } = validateReservation(req.body);
  if (!valid) {
    return res.status(400).json({ statut: 'erreur', errors });
  }

  const { prenom, nom, telephone, email, eventId, zone, pointRelaisIndex, modePaiement, quantite } = sanitized;

  // 2. Vérification des données métier côté serveur
  const event = findEvent(eventId);
  if (!event) {
    return res.status(400).json({ statut: 'erreur', message: 'Événement introuvable.' });
  }

  const relais = findRelais(zone, pointRelaisIndex);
  if (!relais) {
    return res.status(400).json({ statut: 'erreur', message: 'Point relais invalide.' });
  }

  const pmLabel = PAIEMENTS[modePaiement];
  if (!pmLabel) {
    return res.status(400).json({ statut: 'erreur', message: 'Mode de paiement inconnu.' });
  }

  try {
    // 3. Générer N références uniques (1 à 5 tickets maximum, chacun avec son propre QR code unique)
    const totalMontant = event.p * quantite;
    const pointRelaisStr = `${relais.commune}, ${relais.lieu}`;
    const eventDate = event.h ? `${event.d}, ${event.h}` : event.d;

    const tickets = [];
    const references = [];

    for (let i = 1; i <= quantite; i++) {
      const ref = await generateReference();
      references.push(ref);
      const nomPassagerTicket = quantite > 1 ? `${nom} (Ticket ${i}/${quantite})` : nom;

      await pool.query(
        `INSERT INTO reservations
          (reference, prenom, nom, telephone, email,
           event_id, event_nom, event_date,
           zone, point_relais, montant, mode_paiement, quantite)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          ref, prenom, nomPassagerTicket, telephone, email,
          event.id, event.n, eventDate,
          relais.zone, pointRelaisStr, event.p, pmLabel, 1,
        ]
      );

      const qrDataUrl = await generateQRDataUrl(ref);
      tickets.push({
        numero: i,
        reference: ref,
        code: ref,
        label: i === 1 ? `${prenom} ${nom} (Titulaire)` : `Passager ${i}`,
        qrDataUrl,
        statut: 'valide',
      });
    }

    const primaryRef = references[0];
    const primaryQrDataUrl = tickets[0].qrDataUrl;

    // Envoyer l'e-mail avec les N QR codes différents (non bloquant)
    const reservation = {
      reference: references.join(', '),
      references,
      prenom, nom, telephone, email,
      event_nom: event.n, event_date: eventDate,
      zone: relais.zone, point_relais: pointRelaisStr,
      montant: totalMontant, mode_paiement: pmLabel,
      quantite, tickets,
    };

    sendTicketEmail({ to: email, reservation, qrDataUrl: primaryQrDataUrl }).catch((err) => {
      console.error(`[EMAIL] Échec d'envoi pour ${primaryRef} à ${email} :`, err.message);
    });

    // Répondre au client avec la liste des N tickets et leurs N QR codes différents
    return res.status(201).json({
      statut: 'ok',
      reference: primaryRef,
      references,
      qrDataUrl: primaryQrDataUrl,
      quantite,
      tickets,
      reservation: {
        prenom, nom, telephone, email,
        evenement: event.n,
        date: eventDate,
        zone: relais.zone,
        pointRelais: pointRelaisStr,
        montant: totalMontant,
        modePaiement: pmLabel,
        quantite,
      },
    });
  } catch (err) {
    console.error('[RESERVATION] Erreur :', err);
    return res.status(500).json({ statut: 'erreur', message: 'Erreur interne du serveur.' });
  }
});

// Endpoint pour récupérer directement l'image PNG du QR code
router.get('/:reference/qr.png', async (req, res) => {
  const reference = (req.params.reference || '').trim().toUpperCase();
  if (!/^TW-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(reference)) {
    return res.status(400).send('Format de référence invalide.');
  }
  try {
    const qrBuffer = await generateQR(reference);
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return res.send(qrBuffer);
  } catch (err) {
    return res.status(500).send('Erreur lors de la génération du QR code.');
  }
});

export default router;
