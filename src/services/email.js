// src/services/email.js — Envoi d'e-mail via EmailJS (API REST officielle, jusqu'à 5 QR codes différents)
import QRCode from 'qrcode';

/**
 * Construit un QR code compact en tableau HTML (cases noires/blanches), sans image.
 * Visible même quand la messagerie bloque les images.
 */
function buildQrHtmlTable(text) {
  try {
    const { modules } = QRCode.create(text, { errorCorrectionLevel: 'L' });
    const n = modules.size, px = n > 29 ? 4 : 6, W = n * px;
    let cols = '<colgroup>';
    for (let i = 0; i < n; i++) cols += `<col width=${px}>`;
    cols += '</colgroup>';
    let rows = '';
    for (let r = 0; r < n; r++) {
      let cells = '', c = 0;
      while (c < n) {
        const d = !!modules.get(r, c); let k = 1;
        while (c + k < n && !!modules.get(r, c + k) === d) k++;
        cells += `<td${k > 1 ? ' colspan=' + k : ''}${d ? ' bgcolor=#000' : ''}></td>`;
        c += k;
      }
      rows += `<tr height=${px}>${cells}</tr>`;
    }
    return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="${W}" align="center" bgcolor="#ffffff" style="border-collapse:collapse;table-layout:fixed;margin:0 auto;font-size:0;line-height:0;background:#ffffff;border:10px solid #ffffff">${cols}${rows}</table>`;
  } catch {
    return '';
  }
}

function buildTicketsEmailHtml(tickets, passagerNom, useImgOnly = false, ticketsUrl = '') {
  const total = tickets.length;
  // EmailJS limite les variables à 50 Ko : QR en tableau HTML tant que le budget le permet, sinon image.
  const TABLE_BUDGET = 34000;
  let used = 0;
  const cardsHtml = tickets.map((t, idx) => {
    const ref = t.reference || t.code || t;
    const qrContent = t.qrText || t.qr_text || ref;
    const num = idx + 1;
    const title = total > 1
      ? `Ticket ${num}/${total} — ${idx === 0 ? passagerNom + ' (Titulaire)' : 'Passager ' + num}`
      : `Ticket — ${passagerNom}`;
    const qrImgUrl = `https://api.qrserver.com/v1/create-qr-code/?size=220x220&margin=10&data=${encodeURIComponent(qrContent)}`;
    const imgTag = `<img src="${qrImgUrl}" alt="QR Code ${ref}" width="165" height="165" style="display:block;margin:0 auto;background:#fff;padding:8px;border-radius:6px">`;
    let qrVisual = imgTag;
    if (!useImgOnly) {
      const tbl = buildQrHtmlTable(qrContent);
      if (tbl && used + tbl.length <= TABLE_BUDGET) { qrVisual = tbl; used += tbl.length; }
    }
    return `<div style="margin:${idx === 0 ? '0' : '14px'} 0 0;padding:16px;background:#ffffff;border:1.5px dashed #cbd5e1;border-radius:10px;text-align:center">` +
      `<div style="font-size:13px;font-weight:700;color:#0a74b8;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px">${title}</div>` +
      qrVisual +
      `<div style="margin:10px 0 2px;font-size:20px;font-weight:800;letter-spacing:1.5px;color:#252a31">${ref}</div>` +
      `<div style="font-size:12px;color:#64748b">Billet individuel à usage unique — présentez ce QR code à la montée</div>` +
      `</div>`;
  }).join('');

  const linkBlock = ticketsUrl
    ? `<div style="margin-top:16px;padding:12px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;text-align:center">` +
      `<div style="font-size:12px;color:#475569;margin-bottom:8px">Conservez ce lien sécurisé pour retrouver vos billets à tout moment :</div>` +
      `<a href="${ticketsUrl}" style="display:inline-block;padding:10px 18px;background:#0a74b8;color:#ffffff;text-decoration:none;border-radius:999px;font-weight:700;font-size:13px">Afficher mes billets</a>` +
      `</div>`
    : '';

  return cardsHtml + linkBlock;
}

/**
 * Envoie les N billets de transport (1 à 5 QR codes différents) via EmailJS.
 */
export async function sendTicketEmail({ to, reservation }) {
  const serviceId = process.env.EMAILJS_SERVICE_ID;
  let templateId = process.env.EMAILJS_TEMPLATE_ID;
  const publicKey = process.env.EMAILJS_PUBLIC_KEY || process.env.EMAILJS_USER_ID;
  const privateKey = process.env.EMAILJS_PRIVATE_KEY || process.env.EMAILJS_ACCESS_TOKEN;

  if (!serviceId || !templateId || !publicKey) {
    console.warn(
      '[EMAILJS] Variables manquantes (EMAILJS_SERVICE_ID, EMAILJS_TEMPLATE_ID, EMAILJS_PUBLIC_KEY). ' +
      `E-mail pour ${reservation.reference} non envoyé.`
    );
    return { statut: 'non_configure' };
  }

  if (templateId.startsWith('modèle_') || templateId.startsWith('modele_')) {
    templateId = templateId.replace(/^mod[èe]le_/, 'template_');
  }

  const {
    reference, references, tickets, prenom, nom, telephone, email,
    event_nom, event_date, zone, point_relais,
    montant, mode_paiement, ticketsUrl,
  } = reservation;

  const ticketList = Array.isArray(tickets) && tickets.length > 0
    ? tickets
    : (Array.isArray(references) ? references.map((r, i) => ({ numero: i + 1, reference: r })) : [{ numero: 1, reference }]);

  const refs = ticketList.map((t) => t.reference || t.code || t);
  const firstRef = refs[0];
  const allRefsStr = refs.join(', ');
  const quantite = ticketList.length;
  const quantiteLabel = quantite === 1 ? '1 ticket' : `${quantite} tickets`;

  const recipientEmail = to || email;
  const montantFmt = `${Number(montant).toLocaleString('fr-FR')} FCFA (${quantiteLabel})`;
  const passagerNom = `${prenom} ${nom}`.trim();
  const firstQrContent = (ticketList[0] && (ticketList[0].qrText || ticketList[0].qr_text)) || firstRef;
  const qrCodeUrl = `https://api.qrserver.com/v1/create-qr-code/?size=220x220&margin=10&data=${encodeURIComponent(firstQrContent)}`;
  const safeTicketsUrl = String(ticketsUrl || '');
  const paymentNote = 'Paiement réglé exclusivement en ligne via PaySecureHub.';

  const buildPayload = (useImgOnly) => {
    const payload = {
      service_id: serviceId,
      template_id: templateId,
      user_id: publicKey,
      template_params: {
        email: recipientEmail,
        to_email: recipientEmail,
        user_email: recipientEmail,
        destinataire: recipientEmail,
        to_name: passagerNom,
        name: passagerNom,
        prenom,
        nom,
        telephone: telephone || '',
        from_name: 'TickWay',
        reply_to: process.env.EMAILJS_REPLY_TO || '',
        reference: allRefsStr,
        event_nom,
        event_name: event_nom,
        evenement: event_nom,
        event_date,
        date: event_date,
        zone,
        point_relais,
        lieu: point_relais,
        quantite,
        nb_places: quantite,
        places: quantiteLabel,
        montant: montantFmt,
        montant_brut: montant,
        mode_paiement,
        paiement: mode_paiement,
        wave_link: safeTicketsUrl,
        wave_url: safeTicketsUrl,
        wave_message: paymentNote,
        tickets_url: safeTicketsUrl,
        ticket_url: safeTicketsUrl,
        qr_code_url: qrCodeUrl,
        qr_code: qrCodeUrl,
        qr: qrCodeUrl,
        qrcode: qrCodeUrl,
        qr_url: qrCodeUrl,
        qr_image: qrCodeUrl,
        qr_html: buildTicketsEmailHtml(ticketList, passagerNom, useImgOnly, safeTicketsUrl),
        subject: quantite > 1
          ? `Confirmation de vos ${quantite} billets TickWay (${firstRef})`
          : `Confirmation de votre réservation TickWay (${firstRef})`,
        message: `Bonjour ${passagerNom}, vos ${quantite} place(s) à bord de la navette TickWay pour ${event_nom} (${event_date}) au départ de ${point_relais} (${zone}) sont enregistrées sous : ${allRefsStr}.${safeTicketsUrl ? ' Retrouvez vos billets ici : ' + safeTicketsUrl : ''}`,
        consigne: "Billets individuels à usage unique - À présenter à l'embarquement.",
      },
    };
    if (privateKey && privateKey !== 'votre_cle_privee' && privateKey.trim().length > 5) {
      payload.accessToken = privateKey.trim();
    }
    return payload;
  };

  const appOrigin = process.env.APP_URL || 'http://localhost:3000';
  const headers = {
    'Content-Type': 'application/json',
    'Origin': appOrigin,
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko)',
  };

  const htmlBodyStr = JSON.stringify(buildPayload(false));
  const initialBody = htmlBodyStr.length <= 46000 ? htmlBodyStr : JSON.stringify(buildPayload(true));

  let resp = await fetch('https://api.emailjs.com/api/v1.0/email/send', {
    method: 'POST',
    headers,
    body: initialBody,
  });

  if (!resp.ok && htmlBodyStr.length <= 46000) {
    resp = await fetch('https://api.emailjs.com/api/v1.0/email/send', {
      method: 'POST',
      headers,
      body: JSON.stringify(buildPayload(true)),
    });
  }

  if (!resp.ok) {
    const errorText = await resp.text();
    console.error(`[EMAILJS] Échec d'envoi (${resp.status}) :`, errorText);
    throw new Error(`EmailJS error (${resp.status}): ${errorText}`);
  }

  console.log(`[EMAILJS] ✓ ${quantite} QR code(s) envoyé(s) avec succès à ${recipientEmail} (${allRefsStr})`);
  return { statut: 'ok' };
}

async function dispatchTransactionalEmail({
  to,
  toName,
  subject,
  html,
  templateParams = {},
  preferredTemplateEnv = 'EMAILJS_AUTH_TEMPLATE_ID',
  allowTicketTemplateFallback = false,
  purposeLabel = 'notification',
}) {
  const recipient = String(to || '').trim();
  const displayName = String(toName || 'Client').trim();

  // 1. Resend (prioritaire pour les e-mails transactionnels dédiés)
  const resendKey = process.env.RESEND_API_KEY;
  if (resendKey && resendKey.trim().length > 10) {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${resendKey.trim()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: process.env.EMAIL_FROM || 'TickWay <onboarding@resend.dev>',
        to: [recipient],
        subject,
        html,
      }),
    });
    if (!resp.ok) {
      const txt = await resp.text();
      console.error(`[RESEND] Échec d'envoi ${purposeLabel} (${resp.status}) :`, txt);
      return { delivered: false, channel: 'resend_error' };
    }
    return { delivered: true, channel: 'resend' };
  }

  // 2. EmailJS (template dédié prioritaire, sinon fallback éventuel sur template principal)
  const serviceId = process.env.EMAILJS_SERVICE_ID;
  const publicKey = process.env.EMAILJS_PUBLIC_KEY || process.env.EMAILJS_USER_ID;
  const privateKey = process.env.EMAILJS_PRIVATE_KEY || process.env.EMAILJS_ACCESS_TOKEN;
  const templateId = process.env[preferredTemplateEnv]
    || process.env.EMAILJS_AUTH_TEMPLATE_ID
    || (allowTicketTemplateFallback ? process.env.EMAILJS_TEMPLATE_ID : '');

  if (serviceId && templateId && publicKey) {
    const payload = {
      service_id: serviceId,
      template_id: templateId.replace(/^mod[èe]le_/, 'template_'),
      user_id: publicKey,
      template_params: {
        email: recipient,
        to_email: recipient,
        user_email: recipient,
        destinataire: recipient,
        to_name: displayName,
        name: displayName,
        prenom: displayName,
        subject,
        qr_html: html,
        ...templateParams,
      },
    };
    if (privateKey && privateKey.trim().length > 5 && privateKey !== 'votre_cle_privee') {
      payload.accessToken = privateKey.trim();
    }
    const resp = await fetch('https://api.emailjs.com/api/v1.0/email/send', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Origin': process.env.APP_URL || 'http://localhost:3000',
        'User-Agent': 'Mozilla/5.0 (compatible; TickWay/1.0)',
      },
      body: JSON.stringify(payload),
    });
    if (resp.ok) return { delivered: true, channel: 'emailjs' };
    console.warn(`[EMAILJS] Échec template ${purposeLabel} (${resp.status})`);
  }

  console.warn(`[EMAIL] Transport non configuré pour ${purposeLabel} vers ${recipient}.`);
  return { delivered: false, channel: 'unconfigured' };
}

/**
 * Envoie un code de vérification ou de réinitialisation de mot de passe.
 */
export async function sendAuthEmail({ to, prenom, purpose, code, expiresMinutes = 15 }) {
  const displayName = String(prenom || 'Client').trim();
  const isReset = purpose === 'reset_password';
  const subject = isReset
    ? 'Réinitialisation de votre mot de passe TickWay'
    : `Vérifiez votre adresse e-mail TickWay (${code})`;
  const title = isReset ? 'Réinitialisation du mot de passe' : 'Vérification de votre adresse e-mail';
  const intro = isReset
    ? `Vous avez demandé à réinitialiser le mot de passe de votre compte TickWay.`
    : `Merci d'avoir créé votre compte TickWay. Utilisez le code ci-dessous pour vérifier votre adresse e-mail et sécuriser votre espace billets.`;

  const html = `
    <div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;padding:24px;background:#f8fafc;border-radius:14px;border:1px solid #e2e8f0;color:#252a31">
      <div style="font-size:18px;font-weight:800;color:#0a74b8;margin-bottom:8px">TICKWAY</div>
      <h2 style="font-size:20px;margin:0 0 12px;color:#1b1f24">${title}</h2>
      <p style="font-size:14px;line-height:1.55;margin:0 0 16px">Bonjour ${displayName},<br>${intro}</p>
      <div style="text-align:center;margin:20px 0;padding:18px;background:#ffffff;border:1.5px dashed #0a74b8;border-radius:12px">
        <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:#64748b;margin-bottom:6px">Code à usage unique (valable ${expiresMinutes} min)</div>
        <div style="font-size:32px;font-weight:800;letter-spacing:6px;color:#1b1f24">${code}</div>
      </div>
      <p style="font-size:12px;color:#64748b;margin:0">Si vous n'êtes pas à l'origine de cette demande, ignorez simplement cet e-mail.</p>
    </div>`;

  return dispatchTransactionalEmail({
    to,
    toName: displayName,
    subject,
    html,
    preferredTemplateEnv: 'EMAILJS_AUTH_TEMPLATE_ID',
    allowTicketTemplateFallback: false,
    purposeLabel: purpose,
    templateParams: {
      title,
      code,
      otp: code,
      expires_minutes: expiresMinutes,
      message: `${intro} Votre code : ${code} (valable ${expiresMinutes} minutes).`,
    },
  });
}

/**
 * Envoie un e-mail au destinataire d'un transfert de billet avec nouveau lien sécurisé et instructions QR code.
 */
export async function sendTransferRecipientEmail({
  to,
  fromName,
  recipientName,
  eventNom,
  eventDate,
  zone,
  pointRelais,
  categorie,
  newReference,
  qrText,
  ticketsUrl,
  registerUrl,
  hasVerifiedAccount,
}) {
  const displayTo = String(recipientName || to || 'Voyageur').trim();
  const lieu = [pointRelais, zone].filter(Boolean).join(' · ') || 'Abidjan';
  const subject = `Vous avez reçu un billet TickWay pour ${eventNom} (${newReference})`;
  const accessInstruction = hasVerifiedAccount
    ? `Ce billet a été automatiquement ajouté à votre espace personnel « Mon compte » associé à l’adresse ${to}.`
    : `Pour conserver votre billet et accéder à votre QR code à tout moment, cliquez sur le lien sécurisé ci-dessous ou créez gratuitement un compte TickWay avec cette adresse e-mail (${to}).`;

  const qrContent = qrText || newReference;
  const qrImgUrl = `https://api.qrserver.com/v1/create-qr-code/?size=220x220&margin=10&data=${encodeURIComponent(qrContent)}`;

  const html = `
    <div style="font-family:Arial,Helvetica,sans-serif;max-width:540px;margin:0 auto;padding:24px;background:#f8fafc;border-radius:14px;border:1px solid #e2e8f0;color:#252a31">
      <div style="font-size:18px;font-weight:800;color:#0a74b8;margin-bottom:8px">TICKWAY · TRANSFERT DE BILLET</div>
      <h2 style="font-size:20px;margin:0 0 12px;color:#1b1f24">Un billet vous a été transféré !</h2>
      <p style="font-size:14px;line-height:1.55;margin:0 0 14px">Bonjour ${displayTo},<br><strong>${fromName}</strong> vous a transféré un billet navette TickWay :</p>
      <div style="background:#ffffff;border:1px solid #cbd5e1;border-radius:12px;padding:16px;margin-bottom:16px;font-size:14px;line-height:1.65">
        <div><strong>Événement :</strong> ${eventNom}</div>
        <div><strong>Date :</strong> ${eventDate}</div>
        <div><strong>Lieu (Point relais) :</strong> ${lieu}</div>
        <div><strong>Type de billet :</strong> ${categorie}</div>
        <div><strong>Nouvelle référence :</strong> <span style="font-family:monospace;font-weight:700">${newReference}</span></div>
      </div>
      <p style="font-size:13px;line-height:1.5;color:#334155;margin:0 0 16px">${accessInstruction}</p>
      <div style="text-align:center;margin:18px 0">
        <a href="${ticketsUrl}" style="display:inline-block;padding:12px 22px;background:#0a74b8;color:#ffffff;text-decoration:none;border-radius:999px;font-weight:700;font-size:14px">Récupérer mon billet &amp; QR code</a>
        ${!hasVerifiedAccount && registerUrl ? `<div style="margin-top:10px"><a href="${registerUrl}" style="color:#0a74b8;font-weight:700;font-size:13px;text-decoration:underline">Créer gratuitement un compte TickWay</a></div>` : ''}
      </div>
      <p style="font-size:12px;color:#64748b;margin:0">Un nouveau QR code unique a été généré exclusivement pour vous. L’ancien billet du cédant est définitivement désactivé.</p>
    </div>`;

  return dispatchTransactionalEmail({
    to,
    toName: displayTo,
    subject,
    html,
    preferredTemplateEnv: 'EMAILJS_TRANSFER_TEMPLATE_ID',
    allowTicketTemplateFallback: true,
    purposeLabel: 'transfer_recipient',
    templateParams: {
      reference: newReference,
      event_nom: eventNom,
      event_name: eventNom,
      event_date: eventDate,
      date: eventDate,
      zone: zone || '',
      point_relais: pointRelais || '',
      lieu,
      places: `1 billet (${categorie})`,
      montant: 'Transféré (Payé)',
      mode_paiement: 'Transfert par e-mail',
      tickets_url: ticketsUrl,
      ticket_url: ticketsUrl,
      qr_code_url: qrImgUrl,
      qr_url: qrImgUrl,
      message: `${fromName} vous a transféré un billet TickWay (${categorie}) pour ${eventNom} (${eventDate}) au départ de ${lieu}. Récupérez votre QR code ici : ${ticketsUrl}`,
    },
  });
}

/**
 * Envoie une confirmation à l'ancien propriétaire après transfert définitif.
 */
export async function sendTransferOwnerConfirmationEmail({
  to,
  ownerName,
  toEmail,
  eventNom,
  eventDate,
  zone,
  pointRelais,
  categorie,
  oldReference,
  newReference,
  transferredAt,
}) {
  const lieu = [pointRelais, zone].filter(Boolean).join(' · ') || 'Abidjan';
  const dtStr = new Date(transferredAt || Date.now()).toLocaleString('fr-FR');
  const subject = `Confirmation de transfert de votre billet ${oldReference} (${eventNom})`;

  const html = `
    <div style="font-family:Arial,Helvetica,sans-serif;max-width:540px;margin:0 auto;padding:24px;background:#f8fafc;border-radius:14px;border:1px solid #e2e8f0;color:#252a31">
      <div style="font-size:18px;font-weight:800;color:#0a74b8;margin-bottom:8px">TICKWAY · CONFIRMATION DE TRANSFERT</div>
      <h2 style="font-size:20px;margin:0 0 12px;color:#1b1f24">Votre billet a bien été transféré</h2>
      <p style="font-size:14px;line-height:1.55;margin:0 0 14px">Bonjour ${ownerName},<br>Nous confirmons le transfert définitif de votre billet vers <strong>${toEmail}</strong> le ${dtStr}.</p>
      <div style="background:#ffffff;border:1px solid #cbd5e1;border-radius:12px;padding:16px;margin-bottom:16px;font-size:14px;line-height:1.65">
        <div><strong>Événement :</strong> ${eventNom} (${eventDate})</div>
        <div><strong>Lieu :</strong> ${lieu}</div>
        <div><strong>Type de billet :</strong> ${categorie}</div>
        <div><strong>Ancienne référence (invalidée) :</strong> <span style="font-family:monospace">${oldReference}</span></div>
        <div><strong>Nouvelle référence destinataire :</strong> <span style="font-family:monospace">${newReference}</span></div>
      </div>
      <p style="font-size:12px;color:#991b1b;background:#fef2f2;border:1px solid #fecaca;padding:10px 12px;border-radius:8px;margin:0">
        Important : votre ancien QR code (${oldReference}) est définitivement invalidé et ne permet plus l’accès à bord.
      </p>
    </div>`;

  return dispatchTransactionalEmail({
    to,
    toName: ownerName,
    subject,
    html,
    preferredTemplateEnv: 'EMAILJS_TRANSFER_TEMPLATE_ID',
    allowTicketTemplateFallback: true,
    purposeLabel: 'transfer_owner_confirmation',
    templateParams: {
      reference: oldReference,
      event_nom: eventNom,
      event_name: eventNom,
      event_date: eventDate,
      date: eventDate,
      zone: zone || '',
      point_relais: pointRelais || '',
      lieu,
      places: `Transfert vers ${toEmail}`,
      montant: 'Transféré',
      mode_paiement: 'Transfert confirmé',
      message: `Votre billet ${oldReference} pour ${eventNom} a été transféré à ${toEmail} le ${dtStr}. L'ancien QR code est définitivement invalidé.`,
    },
  });
}
