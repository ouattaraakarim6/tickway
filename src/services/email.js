// src/services/email.js — Envoi d'e-mail via EmailJS (API REST officielle, jusqu'à 5 QR codes différents)
import QRCode from 'qrcode';

/**
 * Construit un QR code compact en tableau HTML (cases noires/blanches), sans image.
 * Visible même quand la messagerie bloque les images.
 */
function buildQrHtmlTable(text) {
  try {
    const { modules } = QRCode.create(text, { errorCorrectionLevel: 'M' });
    const n = modules.size, px = 6, W = n * px;
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
    return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="${W}" align="center" style="border-collapse:collapse;table-layout:fixed;margin:0 auto;font-size:0;line-height:0;background:#fff;border:10px solid #fff">${cols}${rows}</table>`;
  } catch {
    return '';
  }
}

function buildTicketsEmailHtml(tickets, passagerNom, useImgOnly = false) {
  const total = tickets.length;
  return tickets.map((t, idx) => {
    const ref = t.reference || t.code || t;
    const num = idx + 1;
    const title = total > 1
      ? `Ticket ${num}/${total} — ${idx === 0 ? passagerNom + ' (Titulaire)' : 'Passager ' + num}`
      : `Ticket — ${passagerNom}`;
    const qrImgUrl = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&margin=10&data=${encodeURIComponent(ref)}`;
    const qrVisual = useImgOnly
      ? `<img src="${qrImgUrl}" alt="QR Code ${ref}" width="150" height="150" style="display:block;margin:0 auto;background:#fff;padding:8px;border-radius:6px">`
      : (buildQrHtmlTable(ref) || `<img src="${qrImgUrl}" alt="QR Code ${ref}" width="150" height="150" style="display:block;margin:0 auto;background:#fff;padding:8px;border-radius:6px">`);
    return `<div style="margin:${idx === 0 ? '0' : '14px'} 0 0;padding:16px;background:#ffffff;border:1.5px dashed #cbd5e1;border-radius:10px;text-align:center">` +
      `<div style="font-size:13px;font-weight:700;color:#0a74b8;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px">${title}</div>` +
      qrVisual +
      `<div style="margin:10px 0 2px;font-size:20px;font-weight:800;letter-spacing:1.5px;color:#252a31">${ref}</div>` +
      `<div style="font-size:12px;color:#64748b">Billet individuel à usage unique — présentez ce QR code à la montée</div>` +
      `<div style="margin-top:6px;font-size:12px"><a href="${qrImgUrl}" target="_blank" style="color:#0a74b8">Afficher le QR code #${num} en image</a></div>` +
      `</div>`;
  }).join('');
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
    montant, mode_paiement,
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
  const qrCodeUrl = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&margin=10&data=${encodeURIComponent(firstRef)}`;
  const waveTotal = Number(montant) || (6000 * quantite);
  const waveLink = `https://pay.wave.com/m/M_ci_BDqgKg4Wl7G2/c/ci/?amount=${waveTotal}`;
  const waveMessage = `Veuillez Payer TICKWAY ${waveTotal.toLocaleString('fr-FR')}F avec Wave en cliquant sur ce lien ${waveLink}. Ajoutez cet expéditeur à vos contacts pour rendre le lien cliquable.`;

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
        wave_link: waveLink,
        wave_url: waveLink,
        wave_message: waveMessage,
        qr_code_url: qrCodeUrl,
        qr_code: qrCodeUrl,
        qr: qrCodeUrl,
        qrcode: qrCodeUrl,
        qr_url: qrCodeUrl,
        qr_image: qrCodeUrl,
        qr_html: buildTicketsEmailHtml(ticketList, passagerNom, useImgOnly),
        subject: quantite > 1
          ? `Confirmation de vos ${quantite} billets TickWay (${firstRef})`
          : `Confirmation de votre réservation TickWay (${firstRef})`,
        message: `Bonjour ${passagerNom}, vos ${quantite} place(s) à bord de la navette TickWay pour ${event_nom} (${event_date}) au départ de ${point_relais} (${zone}) sont enregistrées sous : ${allRefsStr}.`,
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

  let resp = await fetch('https://api.emailjs.com/api/v1.0/email/send', {
    method: 'POST',
    headers,
    body: JSON.stringify(buildPayload(false)),
  });

  if (!resp.ok) {
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
