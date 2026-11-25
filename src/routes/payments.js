// src/routes/payments.js — Intégration serveur PaySecureHub / PAYHUB (https://docs.paysecurehub.com)
import crypto from 'node:crypto';
import { Router } from 'express';
import pool from '../db/pool.js';
import { generateReference } from '../services/reference.js';
import { generateQRDataUrl } from '../services/qr.js';
import { sendTicketEmail } from '../services/email.js';
import { findEvent, findRelais, PAIEMENTS } from '../services/events.js';
import { getPlatformConfig } from '../services/platformStore.js';
import { hashSecret } from '../services/userStore.js';
import { validateReservation } from '../middleware/validate.js';
import {
  getPaySecureHubConfig,
  createHostedPaymentIntent,
  checkPaySecureHubStatus,
  encryptAccessToken,
  decryptAccessToken,
  ensureHttpsUrl,
} from '../services/paysecurehub.js';

const router = Router();

function generateCommandeId() {
  const chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  const bytes = crypto.randomBytes(6);
  let out = 'CMD-';
  for (const b of bytes) out += chars[b % 32];
  return out;
}

function extractRequestHost(req) {
  const fwdHost = req && typeof req.get === 'function' ? req.get('x-forwarded-host') : '';
  const rawHost = fwdHost || (req && typeof req.get === 'function' ? req.get('host') : '') || '';
  return String(rawHost).split(',')[0].trim();
}

function isLocalHost(hostOrUrl) {
  const s = String(hostOrUrl || '').toLowerCase();
  return s.includes('localhost') || s.includes('127.0.0.1');
}

function toOriginOnly(rawUrl) {
  const normalized = ensureHttpsUrl(rawUrl);
  if (!normalized) return '';
  return new URL(normalized).origin;
}

function resolveApiOrigin(req) {
  const reqHost = extractRequestHost(req);
  const railwayHost = process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : '';
  const vercelHost = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : '';

  const envCandidates = [
    process.env.API_PUBLIC_URL,
    process.env.RENDER_EXTERNAL_URL,
    railwayHost,
    vercelHost,
    process.env.APP_URL,
  ]
    .map((s) => toOriginOnly(s))
    .filter((s) => s && !isLocalHost(s));

  // Si on est sur un environnement distant avec une variable publique dédiée (ou en local avec API_PUBLIC_URL définie)
  if (envCandidates.length > 0) return envCandidates[0];
  if (reqHost) return toOriginOnly(`https://${reqHost}`);
  return 'https://localhost:3000';
}

function resolveFrontOrigin(req, requestedOrigin = '') {
  const reqHost = extractRequestHost(req);
  const reqIsLocal = isLocalHost(reqHost);
  const headerOrigin = req && typeof req.get === 'function' ? req.get('origin') : '';

  const appUrlClean = String(process.env.APP_URL || '').trim().replace(/\/$/, '');
  const hostOrigin = reqHost ? `${req.protocol || 'https'}://${reqHost}` : '';

  const envDefault = (!reqIsLocal && appUrlClean && !isLocalHost(appUrlClean))
    ? (/^[a-z]+:\/\//i.test(appUrlClean) ? appUrlClean : `https://${appUrlClean}`)
    : (hostOrigin || 'https://tickway.netlify.app');

  const candidate = String(requestedOrigin || headerOrigin || '').trim().replace(/\/$/, '');
  if (!candidate) return envDefault;

  try {
    const parsed = new URL(candidate);
    if (!['http:', 'https:'].includes(parsed.protocol)) return envDefault;
    const allowedCors = (process.env.CORS_ORIGINS || '')
      .split(',')
      .map((s) => s.trim().replace(/\/$/, ''))
      .filter(Boolean);
    const sameHost = reqHost && parsed.host === reqHost;
    const isKnownHost = parsed.hostname === 'tickway.ci'
      || parsed.hostname.endsWith('.tickway.ci')
      || parsed.hostname.endsWith('.netlify.app')
      || parsed.hostname.endsWith('.onrender.com')
      || parsed.hostname.endsWith('.up.railway.app')
      || parsed.hostname === 'localhost'
      || parsed.hostname === '127.0.0.1';
    if (sameHost || allowedCors.includes(parsed.origin) || isKnownHost) {
      return parsed.origin;
    }
  } catch {
    return envDefault;
  }
  return envDefault;
}

function safeHashEqual(a, b) {
  if (!a || !b) return false;
  const bufA = Buffer.from(String(a), 'utf8');
  const bufB = Buffer.from(String(b), 'utf8');
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

async function getOrderRows(commandeId) {
  const { rows } = await pool.query(
    `SELECT * FROM reservations WHERE commande_id = $1 ORDER BY reference ASC`,
    [commandeId]
  );
  return rows || [];
}

async function loadPaymentTx(commandeId) {
  return pool.exec(
    `SELECT * FROM payment_transactions WHERE commande_id = $1 LIMIT 1`,
    [commandeId],
    () => {
      const db = pool.loadPaymentsJson();
      const row = db[commandeId] || null;
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
  ).then((res) => (res.rows && res.rows[0]) || null);
}

async function verifyAndFinalizeOrder(commandeId, frontOrigin, { webhookPayload = null } = {}) {
  const tx = await loadPaymentTx(commandeId);
  if (!tx) return null;

  let rows = await getOrderRows(commandeId);
  if (!rows.length) return null;

  if (tx.statut === 'paye') {
    return { status: 'paye', tx, rows };
  }

  let statusInfo;
  try {
    statusInfo = await checkPaySecureHubStatus(tx.code_paiement);
  } catch (err) {
    console.warn(`[PAYSECUREHUB] Erreur vérification statut pour ${commandeId} :`, err.message);
    return { status: tx.statut || 'en_attente', tx, rows, error: err.message };
  }

  // Vérification stricte anti-sous-paiement côté serveur
  if (
    statusInfo.state === 'paid'
    && statusInfo.amount !== null
    && Number.isFinite(statusInfo.amount)
    && statusInfo.amount < Number(tx.amount)
  ) {
    console.error(`[PAYSECUREHUB] Montant payé insuffisant pour ${commandeId} : reçu ${statusInfo.amount}, attendu ${tx.amount}`);
    return {
      status: 'echoue',
      tx,
      rows,
      error: 'Montant réglé inférieur au montant attendu.',
    };
  }

  const nowIso = new Date().toISOString();
  let emailPayload = null;

  if (statusInfo.state === 'paid') {
    const paidRows = await pool.withTransaction(
      async (client) => {
        const txCheck = await client.query(
          `SELECT * FROM payment_transactions WHERE commande_id = $1 FOR UPDATE`,
          [commandeId]
        );
        const curTx = txCheck.rows[0];
        if (!curTx) return null;

        const alreadyEmailSent = Boolean(curTx.email_sent);
        const recoveredToken = !alreadyEmailSent ? decryptAccessToken(curTx.access_token_enc) : null;

        await client.query(
          `UPDATE payment_transactions
           SET statut = 'paye',
               transaction_ref = COALESCE($2, transaction_ref),
               provider_service = COALESCE($3, provider_service),
               fees = GREATEST(fees, $4),
               last_webhook_payload = COALESCE($5::jsonb, last_webhook_payload),
               last_status_payload = $6::jsonb,
               email_sent = true,
               access_token_enc = NULL,
               paid_at = COALESCE(paid_at, now()),
               updated_at = now()
           WHERE commande_id = $1`,
          [
            commandeId,
            statusInfo.transactionId,
            statusInfo.serviceName,
            statusInfo.fees || 0,
            webhookPayload ? JSON.stringify(webhookPayload) : null,
            JSON.stringify(statusInfo.raw || {}),
          ]
        );

        const resCountRes = await client.query(
          `SELECT COUNT(*)::int AS cnt FROM reservations WHERE commande_id = $1`,
          [commandeId]
        );
        const totalTickets = Math.max(1, Number((resCountRes.rows[0] && resCountRes.rows[0].cnt) || 1));
        const perTicketFee = statusInfo.fees > 0 ? Math.round(statusInfo.fees / totalTickets) : 0;

        await client.query(
          `UPDATE reservations
           SET statut = 'valide',
               mode_paiement = COALESCE(NULLIF($2, ''), mode_paiement),
               frais_transaction = CASE WHEN frais_transaction = 0 AND $3 > 0 THEN $3 ELSE frais_transaction END
           WHERE commande_id = $1 AND statut = 'en_attente'`,
          [commandeId, statusInfo.serviceName || '', perTicketFee]
        );

        const updatedRes = await client.query(
          `SELECT * FROM reservations WHERE commande_id = $1 ORDER BY reference ASC`,
          [commandeId]
        );

        return {
          alreadyEmailSent,
          recoveredToken,
          rows: updatedRes.rows,
          tx: { ...curTx, statut: 'paye', provider_service: statusInfo.serviceName || curTx.provider_service },
        };
      },
      () => {
        const payDb = pool.loadPaymentsJson();
        const curTx = payDb[commandeId];
        if (!curTx) return null;

        const alreadyEmailSent = Boolean(curTx.email_sent);
        const recoveredToken = !alreadyEmailSent ? decryptAccessToken(curTx.access_token_enc) : null;

        curTx.statut = 'paye';
        if (statusInfo.transactionId) curTx.transaction_ref = statusInfo.transactionId;
        if (statusInfo.serviceName) curTx.provider_service = statusInfo.serviceName;
        if (statusInfo.fees) curTx.fees = Math.max(Number(curTx.fees) || 0, statusInfo.fees);
        if (webhookPayload) curTx.last_webhook_payload = webhookPayload;
        curTx.last_status_payload = statusInfo.raw || {};
        curTx.email_sent = true;
        curTx.access_token_enc = null;
        if (!curTx.paid_at) curTx.paid_at = nowIso;
        curTx.updated_at = nowIso;
        pool.savePaymentsJson(payDb);

        const resDb = pool.loadReservationsJson();
        const matching = Object.values(resDb).filter((r) => r.commande_id === commandeId);
        const perTicketFee = statusInfo.fees > 0 && matching.length > 0 ? Math.round(statusInfo.fees / matching.length) : 0;
        for (const r of matching) {
          if (r.statut === 'en_attente') {
            r.statut = 'valide';
            if (statusInfo.serviceName) r.mode_paiement = statusInfo.serviceName;
            if (!r.frais_transaction && perTicketFee > 0) r.frais_transaction = perTicketFee;
          }
        }
        pool.saveReservationsJson(resDb);
        matching.sort((a, b) => String(a.reference || '').localeCompare(String(b.reference || '')));
        return { alreadyEmailSent, recoveredToken, rows: matching, tx: curTx };
      }
    );

    if (paidRows) {
      rows = paidRows.rows;
      if (!paidRows.alreadyEmailSent && rows.length > 0) {
        const first = rows[0];
        const refs = rows.map((r) => r.reference);
        const cleanNom = String(first.nom || '').replace(/\s*\(Ticket \d+\/\d+\)$/, '').trim();
        const ticketsForMail = await Promise.all(
          rows.map(async (r, i) => ({
            numero: i + 1,
            reference: r.reference,
            code: r.reference,
            qrText: r.qr_text,
            qrDataUrl: await generateQRDataUrl(r.qr_text || `${frontOrigin}/#controle?c=${encodeURIComponent(r.reference)}`),
          }))
        );
        const totalMontant = rows.reduce((s, r) => s + (Number(r.montant) || 0), 0);
        const tokenPart = paidRows.recoveredToken ? `&k=${encodeURIComponent(paidRows.recoveredToken)}` : '';
        const ticketsUrl = `${frontOrigin}/#tickets?refs=${encodeURIComponent(refs.join(','))}${tokenPart}`;
        emailPayload = {
          to: first.email,
          reservation: {
            commandeId,
            reference: refs.join(', '),
            references: refs,
            prenom: first.prenom,
            nom: cleanNom,
            telephone: first.telephone,
            email: first.email,
            localite: first.localite,
            categorie: first.categorie,
            event_nom: first.event_nom,
            event_date: first.event_date,
            zone: first.zone,
            point_relais: first.point_relais,
            montant: totalMontant,
            mode_paiement: first.mode_paiement,
            quantite: rows.length,
            tickets: ticketsForMail,
            ticketsUrl,
          },
        };
      }
      if (emailPayload) {
        sendTicketEmail(emailPayload).catch((err) => {
          console.error(`[EMAIL][PAYSECUREHUB] Échec envoi e-mail pour ${commandeId} :`, err.message);
        });
      }
      return { status: 'paye', tx: paidRows.tx, rows };
    }
  } else if (statusInfo.state === 'failed') {
    await pool.withTransaction(
      async (client) => {
        await client.query(
          `UPDATE payment_transactions
           SET statut = CASE WHEN statut = 'en_attente' THEN 'echoue' ELSE statut END,
               last_webhook_payload = COALESCE($2::jsonb, last_webhook_payload),
               last_status_payload = $3::jsonb,
               updated_at = now()
           WHERE commande_id = $1`,
          [commandeId, webhookPayload ? JSON.stringify(webhookPayload) : null, JSON.stringify(statusInfo.raw || {})]
        );
        await client.query(
          `UPDATE reservations SET statut = 'annule' WHERE commande_id = $1 AND statut = 'en_attente'`,
          [commandeId]
        );
      },
      () => {
        const payDb = pool.loadPaymentsJson();
        if (payDb[commandeId]) {
          if (payDb[commandeId].statut === 'en_attente') payDb[commandeId].statut = 'echoue';
          if (webhookPayload) payDb[commandeId].last_webhook_payload = webhookPayload;
          payDb[commandeId].last_status_payload = statusInfo.raw || {};
          payDb[commandeId].updated_at = nowIso;
          pool.savePaymentsJson(payDb);
        }
        const resDb = pool.loadReservationsJson();
        for (const r of Object.values(resDb)) {
          if (r.commande_id === commandeId && r.statut === 'en_attente') {
            r.statut = 'annule';
          }
        }
        pool.saveReservationsJson(resDb);
      }
    );
    rows = await getOrderRows(commandeId);
    return { status: 'echoue', tx: { ...tx, statut: 'echoue' }, rows, message: statusInfo.message };
  }

  return { status: 'en_attente', tx, rows, message: statusInfo.message };
}

// GET /api/payments/config — Indique au frontend si le hub PaySecureHub est prêt (sans exposer les clés)
router.get('/config', (req, res) => {
  const cfg = getPaySecureHubConfig();
  return res.json({
    statut: 'ok',
    provider: 'paysecurehub',
    paysecurehubConfigured: cfg.configured,
  });
});

// POST /api/payments/paysecurehub/init — Crée la commande 'en_attente' + initialise /api/payhub-ws/build-away
router.post('/paysecurehub/init', async (req, res) => {
  const cfg = getPaySecureHubConfig();
  if (!cfg.configured) {
    return res.status(503).json({
      statut: 'erreur',
      code: 'PAYSECUREHUB_NOT_CONFIGURED',
      message: 'PaySecureHub n’est pas encore configuré sur le serveur (PAYSECUREHUB_API_KEY / PAYSECUREHUB_MERCHANT_ID manquants).',
    });
  }

  const { valid, errors, sanitized } = validateReservation(req.body || {});
  if (!valid) {
    return res.status(400).json({ statut: 'erreur', errors });
  }

  const {
    prenom, nom, telephone, email,
    eventId, zone, pointRelaisIndex, modePaiement, quantite,
    localite, categorie,
  } = sanitized;

  const event = findEvent(eventId);
  if (!event) {
    return res.status(400).json({ statut: 'erreur', message: 'Événement introuvable.' });
  }

  const relais = findRelais(zone, pointRelaisIndex);
  if (!relais) {
    return res.status(400).json({ statut: 'erreur', message: 'Point relais invalide.' });
  }

  const pmLabel = PAIEMENTS[modePaiement] || PAIEMENTS.psh;
  const commandeId = generateCommandeId();
  const localiteFinale = (relais && relais.commune ? relais.commune.trim() : '')
    || (localite && localite !== 'Non renseignée' ? localite : 'Localité non renseignée');
  const categorieFinale = categorie || 'Standard Navette';
  const platformCfg = getPlatformConfig();
  const fraisUnitaire = platformCfg.frais_taux_pct > 0
    ? Math.round((event.p * platformCfg.frais_taux_pct) / 100)
    : 0;

  const totalMontant = event.p * quantite;
  const pointRelaisStr = `${relais.commune}, ${relais.lieu}`;
  const eventDate = event.h ? `${event.d}, ${event.h}` : event.d;
  const frontOrigin = resolveFrontOrigin(req, req.body && req.body.returnOrigin);
  const apiOrigin = resolveApiOrigin(req);

  const accessToken = crypto.randomBytes(24).toString('base64url');
  const guestAccessHash = hashSecret(accessToken);
  const accessTokenEnc = encryptAccessToken(accessToken);

  try {
    const references = [];
    for (let i = 1; i <= quantite; i++) {
      references.push(await generateReference());
    }

    const nowIso = new Date().toISOString();
    await pool.withTransaction(
      async (client) => {
        for (let i = 0; i < quantite; i++) {
          const ref = references[i];
          const nomPassagerTicket = quantite > 1 ? `${nom} (Ticket ${i + 1}/${quantite})` : nom;
          const qrText = `${frontOrigin}/#controle?c=${encodeURIComponent(ref)}`;
          await client.query(
            `INSERT INTO reservations
              (reference, commande_id, user_id, prenom, nom, telephone, email, localite, categorie,
               event_id, event_nom, event_date,
               zone, point_relais, montant, mode_paiement, quantite, statut, frais_transaction, qr_text, guest_access_hash)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
            [
              ref, commandeId, null, prenom, nomPassagerTicket, telephone, email, localiteFinale, categorieFinale,
              event.id, event.n, eventDate,
              relais.zone, pointRelaisStr, event.p, pmLabel, 1, 'en_attente', fraisUnitaire, qrText, guestAccessHash,
            ]
          );
        }
        await client.query(
          `INSERT INTO payment_transactions
            (commande_id, provider, code_paiement, amount, currency, statut, email_sent, access_token_enc)
           VALUES ($1, 'paysecurehub', $2, $3, 'XOF', 'en_attente', false, $4)`,
          [commandeId, commandeId, totalMontant, accessTokenEnc]
        );
      },
      async () => {
        const resDb = pool.loadReservationsJson();
        for (let i = 0; i < quantite; i++) {
          const ref = references[i];
          const nomPassagerTicket = quantite > 1 ? `${nom} (Ticket ${i + 1}/${quantite})` : nom;
          const qrText = `${frontOrigin}/#controle?c=${encodeURIComponent(ref)}`;
          resDb[ref] = {
            reference: ref,
            commande_id: commandeId,
            user_id: null,
            prenom,
            nom: nomPassagerTicket,
            telephone,
            email,
            localite: localiteFinale,
            categorie: categorieFinale,
            event_id: event.id,
            event_nom: event.n,
            event_date: eventDate,
            zone: relais.zone,
            point_relais: pointRelaisStr,
            montant: event.p,
            frais_transaction: fraisUnitaire,
            mode_paiement: pmLabel,
            quantite: 1,
            statut: 'en_attente',
            qr_text: qrText,
            guest_access_hash: guestAccessHash,
            transfer_count: 0,
            transferred_from: null,
            transferred_to: null,
            transferred_at: null,
            cree_le: nowIso,
            utilise_le: null,
            agent_id: null,
            equipe_id: null,
            equipe_nom: null,
          };
        }
        pool.saveReservationsJson(resDb);

        const payDb = pool.loadPaymentsJson();
        payDb[commandeId] = {
          commande_id: commandeId,
          provider: 'paysecurehub',
          code_paiement: commandeId,
          provider_token: null,
          payment_url: null,
          transaction_ref: null,
          pm_id: null,
          provider_service: null,
          amount: totalMontant,
          fees: 0,
          currency: 'XOF',
          statut: 'en_attente',
          email_sent: false,
          access_token_enc: accessTokenEnc,
          last_webhook_payload: null,
          last_status_payload: null,
          paid_at: null,
          created_at: nowIso,
          updated_at: nowIso,
        };
        pool.savePaymentsJson(payDb);
      }
    );

    const urlRetour = ensureHttpsUrl(`${frontOrigin}/paiement-retour?cmd=${encodeURIComponent(commandeId)}&k=${encodeURIComponent(accessToken)}`);
    const urlCallback = ensureHttpsUrl(`${apiOrigin}/api/payments/paysecurehub/webhook`);

    let session;
    try {
      session = await createHostedPaymentIntent({
        commandeId,
        nom,
        prenom,
        telephone,
        email,
        libelleArticle: `Navette TickWay - ${event.n}`,
        quantite,
        montant: totalMontant,
        libOrder: `${event.n} (${quantite} place${quantite > 1 ? 's' : ''}) · ${relais.commune}`,
        urlRetour,
        urlCallback,
      });
    } catch (initErr) {
      await pool.withTransaction(
        async (client) => {
          await client.query(`UPDATE payment_transactions SET statut = 'echoue', access_token_enc = NULL, updated_at = now() WHERE commande_id = $1`, [commandeId]);
          await client.query(`UPDATE reservations SET statut = 'annule' WHERE commande_id = $1 AND statut = 'en_attente'`, [commandeId]);
        },
        () => {
          const payDb = pool.loadPaymentsJson();
          if (payDb[commandeId]) {
            payDb[commandeId].statut = 'echoue';
            payDb[commandeId].access_token_enc = null;
            payDb[commandeId].updated_at = new Date().toISOString();
            pool.savePaymentsJson(payDb);
          }
          const resDb = pool.loadReservationsJson();
          for (const r of Object.values(resDb)) {
            if (r.commande_id === commandeId && r.statut === 'en_attente') r.statut = 'annule';
          }
          pool.saveReservationsJson(resDb);
        }
      );
      return res.status(initErr.status || 502).json({
        statut: 'erreur',
        code: initErr.code || 'PAYSECUREHUB_INIT_FAILED',
        message: initErr.message || 'Impossible d’initialiser le paiement PaySecureHub.',
      });
    }

    await pool.exec(
      `UPDATE payment_transactions SET provider_token = $2, payment_url = $3, updated_at = now() WHERE commande_id = $1`,
      [commandeId, session.tokens, session.url],
      () => {
        const payDb = pool.loadPaymentsJson();
        if (payDb[commandeId]) {
          payDb[commandeId].provider_token = session.tokens;
          payDb[commandeId].payment_url = session.url;
          payDb[commandeId].updated_at = new Date().toISOString();
          pool.savePaymentsJson(payDb);
        }
        return { rowCount: 1 };
      }
    );

    return res.status(201).json({
      statut: 'en_attente',
      provider: 'paysecurehub',
      commandeId,
      paymentUrl: session.url,
      accessToken,
      ticketsUrl: urlRetour,
      quantite,
      montant: totalMontant,
      references,
    });
  } catch (err) {
    console.error('[PAYSECUREHUB] Erreur init :', err);
    return res.status(500).json({ statut: 'erreur', message: 'Erreur interne lors de l’initialisation du paiement.' });
  }
});

// POST/GET /api/payments/paysecurehub/webhook — Callback IPN serveur-à-serveur PaySecureHub
router.all('/paysecurehub/webhook', async (req, res) => {
  const rawCode = String(
    (req.body && (req.body.codePaiement || req.body.code_paiement || req.body.commandeId || req.body.code))
    || (req.query && (req.query.codePaiement || req.query.code_paiement || req.query.commandeId || req.query.code))
    || ''
  ).trim().toUpperCase();

  if (!rawCode) {
    return res.status(400).json({ received: false, message: 'codePaiement manquant.' });
  }

  try {
    const frontOrigin = resolveFrontOrigin(req);
    const result = await verifyAndFinalizeOrder(rawCode, frontOrigin, { webhookPayload: req.body || {} });
    if (!result) {
      return res.status(200).json({ received: true, ignored: true });
    }
    return res.status(200).json({
      received: true,
      commandeId: rawCode,
      statut: result.status,
    });
  } catch (err) {
    console.error('[PAYSECUREHUB][WEBHOOK] Erreur :', err.message);
    return res.status(500).json({ received: false, message: 'Erreur interne webhook.' });
  }
});

// GET /api/payments/paysecurehub/status/:commandeId?k=<accessToken>
// Permet au client (retour Url_Retour ou attente) de vérifier le paiement sans exposer d'autres commandes
router.get('/paysecurehub/status/:commandeId', async (req, res) => {
  const commandeId = String(req.params.commandeId || '').trim().toUpperCase();
  const accessKey = String(req.query.k || '').trim();

  if (!/^CMD-[A-Z0-9]{4,16}$/.test(commandeId) || accessKey.length < 16) {
    return res.status(403).json({ statut: 'erreur', message: 'Accès non autorisé à cette commande.' });
  }

  try {
    const rows = await getOrderRows(commandeId);
    if (!rows.length) {
      return res.status(404).json({ statut: 'erreur', message: 'Commande introuvable.' });
    }

    const expectedHash = hashSecret(accessKey);
    const matchesOrder = rows.some((r) => safeHashEqual(r.guest_access_hash, expectedHash));
    if (!matchesOrder) {
      return res.status(403).json({ statut: 'erreur', message: 'Jeton d’accès invalide pour cette commande.' });
    }

    const frontOrigin = resolveFrontOrigin(req);
    const result = await verifyAndFinalizeOrder(commandeId, frontOrigin);
    if (!result) {
      return res.status(404).json({ statut: 'erreur', message: 'Transaction introuvable.' });
    }

    if (result.status === 'paye') {
      const activeRows = result.rows.filter((r) => r.statut === 'valide' || r.statut === 'utilise');
      const refs = activeRows.map((r) => r.reference);
      const tickets = await Promise.all(
        activeRows.map(async (r, i) => {
          const qrText = r.qr_text || `${frontOrigin}/#controle?c=${encodeURIComponent(r.reference)}`;
          return {
            numero: i + 1,
            reference: r.reference,
            code: r.reference,
            commandeId: r.commande_id,
            prenom: r.prenom,
            nom: String(r.nom || '').replace(/\s*\(Ticket \d+\/\d+\)$/, ''),
            telephone: r.telephone,
            email: r.email,
            eventId: r.event_id,
            eventNom: r.event_nom,
            eventDate: r.event_date,
            zone: r.zone,
            pointRelais: r.point_relais,
            modePaiement: r.mode_paiement,
            montant: r.montant,
            statut: r.statut,
            qrText,
            qrDataUrl: await generateQRDataUrl(qrText),
          };
        })
      );
      return res.json({
        statut: 'paye',
        commandeId,
        paymentMethod: (result.tx && result.tx.provider_service) || (activeRows[0] && activeRows[0].mode_paiement) || 'PaySecureHub',
        ticketsUrl: `${frontOrigin}/#tickets?refs=${encodeURIComponent(refs.join(','))}&k=${encodeURIComponent(accessKey)}`,
        tickets,
      });
    }

    if (result.status === 'echoue') {
      return res.json({
        statut: 'echoue',
        commandeId,
        message: result.message || 'Le paiement a été annulé ou refusé.',
      });
    }

    return res.json({
      statut: 'en_attente',
      commandeId,
      paymentUrl: result.tx ? result.tx.payment_url : null,
      message: result.message || 'Paiement en attente de confirmation par l’opérateur.',
    });
  } catch (err) {
    console.error('[PAYSECUREHUB][STATUS] Erreur :', err.message);
    return res.status(500).json({ statut: 'erreur', message: 'Impossible de vérifier le statut du paiement.' });
  }
});

export default router;
