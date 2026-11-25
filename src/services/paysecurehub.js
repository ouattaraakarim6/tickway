// src/services/paysecurehub.js — Client serveur PaySecureHub / PAYHUB (BMI-CI)
// Documentation officielle : https://docs.paysecurehub.com
import crypto from 'node:crypto';

const DEFAULT_BASE_URL = 'https://rest-airtime.paysecurehub.com';

/**
 * Garantit une URL absolue en HTTPS pour les champs Url_Retour et Url_Callback exigés par PaySecureHub,
 * quel que soit l'environnement (local HTTP, proxy, Render, Railway, Netlify, domaine custom).
 */
export function ensureHttpsUrl(rawUrl, fallback = '') {
  const tryNormalize = (val) => {
    let s = String(val || '').trim();
    if (!s) return null;
    if (/^http:\/\//i.test(s)) {
      s = 'https://' + s.slice(7);
    } else if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
      s = 'https://' + s.replace(/^\/+/, '');
    }
    try {
      const parsed = new URL(s);
      if (parsed.protocol !== 'https:') return null;
      return parsed.toString();
    } catch {
      return null;
    }
  };
  return tryNormalize(rawUrl) || tryNormalize(fallback) || '';
}

export function getPaySecureHubConfig() {
  const baseUrl = (process.env.PAYSECUREHUB_BASE_URL || DEFAULT_BASE_URL).trim().replace(/\/$/, '');
  const apiKey = (process.env.PAYSECUREHUB_API_KEY || '').trim();
  const merchantId = (process.env.PAYSECUREHUB_MERCHANT_ID || '').trim();
  return {
    configured: Boolean(apiKey && merchantId),
    baseUrl,
    apiKey,
    merchantId,
  };
}

function buildHeaders(cfg, includeMerchant = true) {
  const h = {
    'ApiKey': cfg.apiKey,
    'Content-Type': 'application/json',
  };
  if (includeMerchant) h['MerchantId'] = cfg.merchantId;
  return h;
}

async function parseJsonSafe(resp) {
  const text = await resp.text();
  try {
    return { data: JSON.parse(text), rawText: text };
  } catch {
    return { data: null, rawText: text };
  }
}

/**
 * Crée une session de paiement hébergée sur le Hub PaySecureHub (/api/payhub-ws/build-away).
 * Retourne { tokens, url, raw } pour rediriger le client vers https://payx.paysecurehub.com/payment/<tokens>.
 */
export async function createHostedPaymentIntent({
  commandeId,
  nom,
  prenom,
  telephone,
  email,
  libelleArticle,
  quantite,
  montant,
  libOrder,
  urlRetour,
  urlCallback,
}) {
  const cfg = getPaySecureHubConfig();
  if (!cfg.configured) {
    const err = new Error('PaySecureHub non configuré sur le serveur (PAYSECUREHUB_API_KEY / PAYSECUREHUB_MERCHANT_ID).');
    err.code = 'PAYSECUREHUB_NOT_CONFIGURED';
    err.status = 503;
    throw err;
  }

  const cleanAmount = Math.round(Number(montant) || 0);
  if (cleanAmount <= 0) {
    const err = new Error('Montant de paiement invalide.');
    err.status = 400;
    throw err;
  }

  const safeReturnUrl = ensureHttpsUrl(urlRetour);
  const safeCallbackUrl = ensureHttpsUrl(urlCallback);
  if (!safeReturnUrl || !safeCallbackUrl) {
    const err = new Error('Url_Retour et Url_Callback HTTPS valides requises pour PaySecureHub.');
    err.status = 400;
    throw err;
  }

  const payload = {
    code_paiement: String(commandeId).trim(),
    nom_usager: String(nom || 'Client').trim().slice(0, 80),
    prenom_usager: String(prenom || 'TickWay').trim().slice(0, 80),
    telephone: String(telephone || '').trim(),
    email: String(email || '').trim(),
    libelle_article: String(libelleArticle || 'Billet TickWay').trim().slice(0, 120),
    quantite: Math.max(1, Math.min(5, Math.floor(Number(quantite) || 1))),
    montant: cleanAmount,
    lib_order: String(libOrder || `Commande TickWay ${commandeId}`).trim().slice(0, 160),
    Url_Retour: safeReturnUrl,
    Url_Callback: safeCallbackUrl,
  };

  const resp = await fetch(`${cfg.baseUrl}/api/payhub-ws/build-away`, {
    method: 'POST',
    headers: buildHeaders(cfg, true),
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15000),
  });

  const { data, rawText } = await parseJsonSafe(resp);
  const apiCode = data && data.code !== undefined ? Number(data.code) : resp.status;
  if (!resp.ok || !data || apiCode !== 200 || !data.url) {
    const detail = data && Array.isArray(data.message)
      ? data.message.join(', ')
      : ((data && data.message) || rawText || `HTTP ${resp.status}`);
    const err = new Error(`PaySecureHub build-away refusé : ${detail}`);
    err.code = 'PAYSECUREHUB_INIT_FAILED';
    err.status = 502;
    err.providerResponse = data || rawText;
    throw err;
  }

  return {
    tokens: String(data.tokens || ''),
    url: String(data.url),
    raw: data,
  };
}

const PAID_STATES = new Set([
  'SUCCESS',
  'SUCCESSFUL',
  'SUCCEEDED',
  'COMPLETED',
  'COMPLETE',
  'PAID',
  'VALIDATED',
  'APPROVED',
  'DONE',
]);

const FAILED_STATES = new Set([
  'CANCEL',
  'CANCELED',
  'CANCELLED',
  'FAILED',
  'FAIL',
  'ERROR',
  'REJECTED',
  'DECLINED',
  'EXPIRED',
  'TIMEOUT',
]);

const PENDING_STATES = new Set([
  'PENDDING',
  'PENDING',
  'INITIATED',
  'PROCESSING',
  'IN_PROGRESS',
  'WAITING',
]);

export function normalizePaySecureHubStatusResponse(data, httpStatus = 200) {
  if (!data || typeof data !== 'object') {
    return {
      state: 'pending',
      rawState: '',
      code: httpStatus,
      transactionId: null,
      serviceName: null,
      serviceId: null,
      amount: null,
      fees: 0,
      pmId: null,
      message: 'Réponse PaySecureHub vide ou illisible.',
      raw: data,
    };
  }

  const rawPayment = Array.isArray(data.payments)
    ? (data.payments[data.payments.length - 1] || null)
    : (data.payments && typeof data.payments === 'object' ? data.payments : null);

  const apiCode = data.code !== undefined ? Number(data.code) : httpStatus;
  const rawState = String(
    (rawPayment && (rawPayment.state || rawPayment.status))
    || data.state
    || data.status
    || ''
  ).trim().toUpperCase();

  const transactionId = (rawPayment && (rawPayment.transactionId || rawPayment.referencePaiement))
    || data.referencePaiement
    || data.transactionId
    || null;
  const serviceName = (rawPayment && (rawPayment.serviceName || rawPayment.moyenPaiement))
    || data.moyenPaiement
    || null;
  const serviceId = (rawPayment && rawPayment.serviceId) ?? data.service_id ?? null;
  const amountRaw = (rawPayment && rawPayment.amount !== undefined) ? rawPayment.amount : data.montant;
  const amount = amountRaw !== undefined && amountRaw !== null && !Number.isNaN(Number(amountRaw))
    ? Number(amountRaw)
    : null;
  const feesRaw = (rawPayment && rawPayment.fees !== undefined) ? rawPayment.fees : 0;
  const fees = Number.isFinite(Number(feesRaw)) ? Math.max(0, Math.round(Number(feesRaw))) : 0;
  const errorMsg = (rawPayment && rawPayment.error) || data.cleretour || data.message || '';

  let state = 'pending';
  if (FAILED_STATES.has(rawState) || (apiCode >= 400 && apiCode !== 404)) {
    state = 'failed';
  } else if (PAID_STATES.has(rawState) && apiCode === 200) {
    state = 'paid';
  } else if (PENDING_STATES.has(rawState) || !rawState || apiCode === 404) {
    state = 'pending';
  } else if (apiCode === 200 && rawPayment && transactionId && !rawState) {
    state = 'pending';
  }

  return {
    state,
    rawState,
    code: apiCode,
    transactionId: transactionId ? String(transactionId) : null,
    serviceName: serviceName ? String(serviceName) : null,
    serviceId: serviceId !== null && serviceId !== undefined ? Number(serviceId) : null,
    amount,
    fees,
    pmId: data.pmId ? String(data.pmId) : null,
    message: typeof errorMsg === 'string' ? errorMsg : JSON.stringify(errorMsg),
    raw: data,
  };
}

/**
 * Interroge le statut réel d'une transaction auprès de PaySecureHub
 * (POST /api/airtime/status/transact).
 */
export async function checkPaySecureHubStatus(codePaiement) {
  const cfg = getPaySecureHubConfig();
  if (!cfg.configured) {
    const err = new Error('PaySecureHub non configuré sur le serveur.');
    err.code = 'PAYSECUREHUB_NOT_CONFIGURED';
    err.status = 503;
    throw err;
  }

  const resp = await fetch(`${cfg.baseUrl}/api/airtime/status/transact`, {
    method: 'POST',
    headers: buildHeaders(cfg, true),
    body: JSON.stringify({ codePaiement: String(codePaiement).trim() }),
    signal: AbortSignal.timeout(15000),
  });

  const { data } = await parseJsonSafe(resp);
  return normalizePaySecureHubStatusResponse(data, resp.status);
}

/**
 * Récupère la liste des providers disponibles (GET /api/data-ws/providers).
 */
let cachedProviders = { expiresAt: 0, items: [] };
export async function listPaySecureHubProviders() {
  const cfg = getPaySecureHubConfig();
  if (!cfg.configured) return [];
  if (Date.now() < cachedProviders.expiresAt && cachedProviders.items.length > 0) {
    return cachedProviders.items;
  }
  const resp = await fetch(`${cfg.baseUrl}/api/data-ws/providers`, {
    method: 'GET',
    headers: buildHeaders(cfg, false),
    signal: AbortSignal.timeout(12000),
  });
  const { data } = await parseJsonSafe(resp);
  const items = data && Array.isArray(data.data) ? data.data : [];
  if (items.length > 0) {
    cachedProviders = { expiresAt: Date.now() + 5 * 60 * 1000, items };
  }
  return items;
}

// Chiffrement éphémère AES-256-GCM du guest accessToken le temps d'attendre le webhook IPN
function getTempCipherKey() {
  const seed = process.env.TICKWAY_RESET_SECRET
    || process.env.PAYSECUREHUB_API_KEY
    || process.env.FOUNDER_PASSWORD
    || process.env.VALIDATE_API_KEY
    || 'tickway-dev-ephemeral-cipher-key';
  return crypto.createHash('sha256').update(`TICKWAY_GUEST_ENC_V1:${seed}`).digest();
}

export function encryptAccessToken(plainToken) {
  if (!plainToken) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getTempCipherKey(), iv);
  const enc = Buffer.concat([cipher.update(String(plainToken), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}.${tag.toString('hex')}.${enc.toString('hex')}`;
}

export function decryptAccessToken(encoded) {
  if (!encoded || typeof encoded !== 'string') return null;
  const parts = encoded.split('.');
  if (parts.length !== 3) return null;
  try {
    const [ivHex, tagHex, encHex] = parts;
    const decipher = crypto.createDecipheriv('aes-256-gcm', getTempCipherKey(), Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    const plain = Buffer.concat([decipher.update(Buffer.from(encHex, 'hex')), decipher.final()]);
    return plain.toString('utf8');
  } catch {
    return null;
  }
}
