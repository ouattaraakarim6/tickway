// src/services/email.js — Envoi des billets par e-mail via le SMTP de la messagerie o2switch (nodemailer)
// Les QR codes sont générés par le serveur et intégrés au message (images CID) : aucun service tiers.
import nodemailer from 'nodemailer';
import { generateQR } from './qr.js';

let cachedTransport = null;
let cachedKey = '';

function smtpConfig() {
  const port = Number(process.env.SMTP_PORT) || 465;
  const secureEnv = String(process.env.SMTP_SECURE || '').trim().toLowerCase();
  return {
    host: String(process.env.SMTP_HOST || '').trim(),
    port,
    secure: secureEnv ? secureEnv === 'true' : port === 465, // 465 = SSL/TLS direct, 587 = STARTTLS
    user: String(process.env.SMTP_USER || '').trim(),
    pass: String(process.env.SMTP_PASS || ''),
  };
}

export function isEmailConfigured() {
  const c = smtpConfig();
  return Boolean(c.host && c.user && c.pass);
}

function getTransport() {
  const c = smtpConfig();
  const key = `${c.host}|${c.port}|${c.secure}|${c.user}|${c.pass.length}`;
  if (!cachedTransport || cachedKey !== key) {
    cachedTransport = nodemailer.createTransport({
      host: c.host,
      port: c.port,
      secure: c.secure,
      requireTLS: !c.secure, // en 587 : chiffrement STARTTLS obligatoire, jamais d'envoi en clair
      auth: { user: c.user, pass: c.pass },
      connectionTimeout: 15000,
      greetingTimeout: 15000,
      socketTimeout: 30000,
      disableFileAccess: true, // aucune lecture de fichier local via le contenu du message
      disableUrlAccess: true,  // aucune récupération d'URL distante via le contenu du message
    });
    cachedKey = key;
  }
  return cachedTransport;
}

function sender() {
  const c = smtpConfig();
  const from = String(process.env.MAIL_FROM || '').trim() || `TickWay <${c.user}>`;
  const replyTo = String(process.env.MAIL_REPLY_TO || '').trim() || undefined;
  return { from, replyTo };
}

// Échappe toute donnée saisie par l'utilisateur avant insertion dans le HTML
function escHtml(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Retire les retours à la ligne des valeurs placées dans des en-têtes (sujet, nom)
function oneLine(v) {
  return String(v ?? '').replace(/[\r\n]+/g, ' ').trim();
}

function maskEmail(email) {
  const [user, domain] = String(email || '').split('@');
  if (!domain) return '***';
  return `${user.slice(0, 2)}***@${domain}`;
}

function safeHttpUrl(url) {
  try {
    const u = new URL(String(url || ''));
    return ['http:', 'https:'].includes(u.protocol) ? u.toString() : '';
  } catch {
    return '';
  }
}

/**
 * Construit le message (sujet, HTML, texte, pièces jointes QR) pour 1 à 5 billets.
 * Même présentation que l'ancien modèle EmailJS.
 */
export async function buildTicketEmail(reservation) {
  const {
    tickets, prenom, nom, event_nom, event_date, zone, point_relais, montant, mode_paiement, ticketsUrl,
  } = reservation;

  const ticketList = Array.isArray(tickets) && tickets.length
    ? tickets
    : [{ reference: reservation.reference, qrText: reservation.qr_text }];
  const refs = ticketList.map((t) => t.reference || t.code || t);
  const quantite = ticketList.length;
  const quantiteLabel = quantite === 1 ? 'votre ticket' : `vos ${quantite} tickets`;
  const montantFmt = `${Number(montant || 0).toLocaleString('fr-FR')} FCFA (${quantite} ticket${quantite > 1 ? 's' : ''})`;
  const passagerNom = oneLine(`${prenom || ''} ${nom || ''}`);
  const link = safeHttpUrl(ticketsUrl);

  const attachments = [];
  const cards = [];
  for (let i = 0; i < ticketList.length; i++) {
    const t = ticketList[i];
    const ref = String(refs[i]);
    const qrContent = t.qrText || t.qr_text || ref;
    const cid = `qr-${ref.replace(/[^A-Za-z0-9-]/g, '')}@tickway`;
    attachments.push({
      filename: `billet-${ref}.png`,
      content: await generateQR(qrContent),
      contentType: 'image/png',
      cid,
    });
    const title = quantite > 1
      ? `Ticket ${i + 1}/${quantite} — ${i === 0 ? `${escHtml(passagerNom)} (Titulaire)` : `Passager ${i + 1}`}`
      : `Ticket — ${escHtml(passagerNom)}`;
    cards.push(
      `<div style="margin:${i === 0 ? '0' : '14px'} 0 0;padding:16px;background:#ffffff;border:1.5px dashed #cbd5e1;border-radius:10px;text-align:center">`
      + `<div style="font-size:13px;font-weight:700;color:#0a74b8;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px">${title}</div>`
      + `<img src="cid:${cid}" alt="QR Code ${escHtml(ref)}" width="180" height="180" style="display:block;margin:0 auto;background:#fff;border-radius:6px">`
      + `<div style="margin:10px 0 2px;font-size:20px;font-weight:800;letter-spacing:1.5px;color:#252a31">${escHtml(ref)}</div>`
      + '<div style="font-size:12px;color:#64748b">Billet individuel à usage unique — présentez ce QR code à la montée</div>'
      + '</div>'
    );
  }

  const linkBlock = link
    ? '<div style="margin-top:16px;padding:12px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;text-align:center">'
      + '<div style="font-size:12px;color:#475569;margin-bottom:8px">Conservez ce lien sécurisé pour retrouver vos billets à tout moment :</div>'
      + `<a href="${escHtml(link)}" style="display:inline-block;padding:10px 18px;background:#0a74b8;color:#ffffff;text-decoration:none;border-radius:999px;font-weight:700;font-size:13px">Afficher mes billets</a>`
      + '</div>'
    : '';

  const subject = oneLine(quantite > 1
    ? `Confirmation de vos ${quantite} billets TickWay (${refs[0]})`
    : `Confirmation de votre réservation TickWay (${refs[0]})`);

  const html = `<!DOCTYPE html>
<html lang="fr">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escHtml(subject)}</title></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:Arial,Helvetica,sans-serif;color:#252a31;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f1f5f9;">
    <tr><td align="center" style="padding:24px 12px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;background:#ffffff;border-radius:12px;">
        <tr><td style="padding:24px 24px 8px 24px;">
          <div style="font-size:24px;font-weight:800;color:#0a74b8;">Tick<span style="color:#e0a526;">Way</span></div>
        </td></tr>
        <tr><td style="padding:8px 24px 0 24px;font-size:16px;line-height:1.5;">
          Bonjour ${escHtml(prenom)},<br><br>
          Votre réservation pour <b>${escHtml(event_nom)}</b> est bien enregistrée. Voici ${quantiteLabel} :
        </td></tr>
        <tr><td style="padding:16px 24px 0 24px;font-size:14px;line-height:1.6;color:#334155;">
          <b>Événement :</b> ${escHtml(event_nom)}<br>
          <b>Date :</b> ${escHtml(event_date)}<br>
          <b>Point relais :</b> ${escHtml(point_relais)} (${escHtml(zone)})<br>
          <b>Montant :</b> ${escHtml(montantFmt)}<br>
          ${mode_paiement ? `<b>Paiement :</b> ${escHtml(mode_paiement)}<br>` : ''}
          <b>Référence(s) :</b> ${escHtml(refs.join(', '))}
        </td></tr>
        <tr><td style="padding:20px 24px 8px 24px;">${cards.join('')}${linkBlock}</td></tr>
        <tr><td style="padding:8px 24px 24px 24px;font-size:12px;line-height:1.5;color:#64748b;">
          Présentez le QR code (ou la référence) au contrôleur lors de l’embarquement. Chaque ticket est à usage unique.<br><br>
          Vous recevez ce message car vous avez effectué une réservation sur TickWay. Pour toute question, répondez simplement à cet e-mail.
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  const text = [
    `Bonjour ${oneLine(prenom)},`,
    '',
    `Votre réservation pour ${oneLine(event_nom)} est bien enregistrée.`,
    `Date : ${oneLine(event_date)}`,
    `Point relais : ${oneLine(point_relais)} (${oneLine(zone)})`,
    `Montant : ${montantFmt}`,
    `Référence(s) : ${refs.join(', ')}`,
    link ? `\nVos billets : ${link}` : '',
    '',
    'Les QR codes sont joints à ce message. Chaque ticket est à usage unique.',
  ].join('\n');

  return { subject, html, text, attachments, refs };
}

/**
 * Envoie les N billets de transport (1 à 5 QR codes différents) via le SMTP o2switch.
 */
export async function sendTicketEmail({ to, reservation }) {
  const recipient = String(to || reservation.email || '').trim();
  if (!isEmailConfigured()) {
    console.warn(
      `[EMAIL] SMTP non configuré (SMTP_HOST, SMTP_USER, SMTP_PASS). E-mail pour ${reservation.reference} non envoyé.`
    );
    return { statut: 'non_configure' };
  }

  const { subject, html, text, attachments, refs } = await buildTicketEmail(reservation);
  const { from, replyTo } = sender();
  const info = await getTransport().sendMail({
    from,
    replyTo,
    to: recipient,
    subject,
    html,
    text,
    attachments,
  });
  console.log(`[EMAIL] ✓ ${refs.length} billet(s) envoyé(s) à ${maskEmail(recipient)} (${refs.join(', ')}) — ${info.messageId || 'ok'}`);
  return { statut: 'ok' };
}
