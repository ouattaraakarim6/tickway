// src/services/userStore.js — Gestion des comptes clients TickWay avec Supabase Auth, profils liés et transferts sécurisés
import crypto from 'node:crypto';
import fs from 'node:fs';
import { join } from 'node:path';
import pool, { getJsonDataDir, loadReservationsJson, saveReservationsJson } from '../db/pool.js';
import { generateReference } from './reference.js';
import { isEventExpired } from './events.js';
import { getTransferConfig } from './platformStore.js';
import {
  getSupabasePublishableKey,
  hasSupabaseAdminKey,
  supabaseAdminCreateUser,
  supabaseGetUser,
  supabaseSignInWithPassword,
  supabaseSignUp,
} from './supabaseAuth.js';

const RESET_GRANT_TTL_MS = 5 * 60 * 1000;          // 5 minutes après validation du code OTP recovery
const PBKDF2_ITERATIONS = 100000;
const DUMMY_SALT = '7d3e9f2c1b4a6850e9d2c1b4a7865432';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(val) {
  return UUID_RE.test(String(val || '').trim());
}

function getUsersJsonPath() {
  return join(getJsonDataDir(), 'users.json');
}

function getTransfersJsonPath() {
  return join(getJsonDataDir(), 'transfers.json');
}

function loadTransfersJson() {
  const filePath = getTransfersJsonPath();
  try {
    if (!fs.existsSync(filePath)) {
      fs.mkdirSync(getJsonDataDir(), { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify([], null, 2), 'utf8');
      return [];
    }
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8') || '[]');
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function saveTransfersJson(list) {
  const filePath = getTransfersJsonPath();
  fs.mkdirSync(getJsonDataDir(), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(Array.isArray(list) ? list : [], null, 2), 'utf8');
}

function loadUsersJson() {
  const filePath = getUsersJsonPath();
  try {
    if (!fs.existsSync(filePath)) {
      const init = { users: {}, profiles: {}, sessions: {}, tokens: {}, resetGrants: {}, rateLimits: {} };
      fs.mkdirSync(getJsonDataDir(), { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify(init, null, 2), 'utf8');
      return init;
    }
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8') || '{}');
    return {
      users: raw.users && typeof raw.users === 'object' ? raw.users : {},
      profiles: raw.profiles && typeof raw.profiles === 'object' ? raw.profiles : {},
      sessions: raw.sessions && typeof raw.sessions === 'object' ? raw.sessions : {},
      tokens: raw.tokens && typeof raw.tokens === 'object' ? raw.tokens : {},
      resetGrants: raw.resetGrants && typeof raw.resetGrants === 'object' ? raw.resetGrants : {},
      rateLimits: raw.rateLimits && typeof raw.rateLimits === 'object' ? raw.rateLimits : {},
    };
  } catch {
    return { users: {}, profiles: {}, sessions: {}, tokens: {}, resetGrants: {}, rateLimits: {} };
  }
}

function saveUsersJson(db) {
  const filePath = getUsersJsonPath();
  fs.mkdirSync(getJsonDataDir(), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(db, null, 2), 'utf8');
}

export function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

export function hashSecret(raw) {
  return crypto.createHash('sha256').update(String(raw || '')).digest('hex');
}

function verifyLegacyPassword(password, salt, expectedHash) {
  if (!salt || !expectedHash || expectedHash === 'supabase_managed') {
    crypto.pbkdf2Sync(String(password || ''), DUMMY_SALT, PBKDF2_ITERATIONS, 64, 'sha256');
    return false;
  }
  const computed = crypto.pbkdf2Sync(String(password), salt, PBKDF2_ITERATIONS, 64, 'sha256');
  const expected = Buffer.from(expectedHash, 'hex');
  if (computed.length !== expected.length) return false;
  return crypto.timingSafeEqual(computed, expected);
}

function deriveResetEncryptionKey() {
  const material = String(
    process.env.TICKWAY_RESET_SECRET
    || process.env.VALIDATE_API_KEY
    || `${getSupabasePublishableKey()}:tickway_recovery_grant_v1`
  );
  return crypto.createHash('sha256').update(material).digest();
}

function encryptRecoveryToken(plain) {
  const key = deriveResetEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`;
}

function decryptRecoveryToken(encoded) {
  try {
    const parts = String(encoded || '').split(':');
    if (parts.length !== 3) return null;
    const [ivHex, tagHex, encHex] = parts;
    const key = deriveResetEncryptionKey();
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    const dec = Buffer.concat([decipher.update(Buffer.from(encHex, 'hex')), decipher.final()]);
    return dec.toString('utf8');
  } catch {
    return null;
  }
}

export function extractOwnerIds(userOrId, userRow = null) {
  const ids = [];
  if (typeof userOrId === 'string' && userOrId) {
    ids.push(userOrId);
  } else if (userOrId && typeof userOrId === 'object') {
    if (userOrId.id) ids.push(userOrId.id);
    if (userOrId.supabaseId) ids.push(userOrId.supabaseId);
    if (userOrId.legacyUserId) ids.push(userOrId.legacyUserId);
    if (Array.isArray(userOrId.ownerIds)) ids.push(...userOrId.ownerIds);
  }
  if (userRow) {
    if (userRow.id) ids.push(userRow.id);
    if (userRow.supabase_id) ids.push(userRow.supabase_id);
    if (userRow.legacy_user_id) ids.push(userRow.legacy_user_id);
  }
  return [...new Set(ids.map((x) => String(x || '').trim()).filter(Boolean))];
}

export function sanitizeUser(row, supaUser = null) {
  if (!row) return null;
  const supabaseId = row.supabase_id || (supaUser && supaUser.id) || (isUuid(row.id) ? row.id : null);
  const canonicalId = supabaseId || row.id;
  const legacyUserId = row.legacy_user_id || (row.id && supabaseId && row.id !== supabaseId ? row.id : null);
  const emailVerified = Boolean(row.email_verified || (supaUser && supaUser.email_confirmed_at));

  return {
    id: canonicalId,
    supabaseId,
    legacyUserId,
    ownerIds: extractOwnerIds({ id: canonicalId, supabaseId, legacyUserId }, row),
    prenom: row.prenom,
    nom: row.nom,
    email: row.email,
    telephone: row.telephone || '',
    emailVerified,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function findUserInJsonByEmail(db, cleanEmail) {
  const target = normalizeEmail(cleanEmail);
  return Object.values(db.users).find((u) => u && normalizeEmail(u.email) === target) || null;
}

function findUserInJsonByAnyId(db, idOrSupabaseId) {
  const clean = String(idOrSupabaseId || '').trim();
  if (!clean) return null;
  if (db.users[clean]) return db.users[clean];
  return Object.values(db.users).find((u) => u && (u.id === clean || u.supabase_id === clean)) || null;
}

function mapReservationToTicket(r, fallbackOrigin = 'https://tickway.netlify.app', transferCfg = null) {
  const cfg = transferCfg || getTransferConfig();
  const isTransferredOut = r.statut === 'transfere';
  const qrText = isTransferredOut
    ? null
    : (r.qr_text || `${fallbackOrigin.replace(/\/$/, '')}/#controle?c=${encodeURIComponent(r.reference)}`);
  const transferCount = Number(r.transfer_count) || 0;
  const expired = isEventExpired(r.event_id);
  const maxPerTicket = Number(cfg.maxTransfersPerTicket ?? 1);
  return {
    reference: r.reference,
    commandeId: r.commande_id || r.reference,
    prenom: r.prenom,
    nom: r.nom,
    telephone: r.telephone,
    email: r.email,
    localite: r.localite || 'Localité non renseignée',
    categorie: r.categorie || 'Standard Navette',
    eventId: r.event_id,
    eventNom: r.event_nom,
    eventDate: r.event_date,
    zone: r.zone,
    pointRelais: r.point_relais,
    montant: Number(r.montant) || 0,
    fraisTransaction: Number(r.frais_transaction) || 0,
    modePaiement: r.mode_paiement,
    statut: r.statut || 'valide',
    qrText,
    transferCount,
    maxTransfersPerTicket: maxPerTicket,
    transferredFrom: r.transferred_from || null,
    transferredTo: r.transferred_to || null,
    transferredAt: r.transferred_at || null,
    isExpired: expired,
    canTransfer: r.statut === 'valide' && !expired && Boolean(cfg.enabled) && transferCount < maxPerTicket,
    creeLe: r.cree_le,
    utiliseLe: r.utilise_le || null,
  };
}

export async function getUserRawByEmail(email) {
  const cleanEmail = normalizeEmail(email);
  if (!cleanEmail) return null;
  const { rows } = await pool.exec(
    `SELECT * FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1`,
    [cleanEmail],
    () => {
      const db = loadUsersJson();
      const u = findUserInJsonByEmail(db, cleanEmail);
      return { rows: u ? [u] : [], rowCount: u ? 1 : 0 };
    }
  );
  return rows[0] || null;
}

export async function getUserRawByAnyId(idOrSupabaseId) {
  const clean = String(idOrSupabaseId || '').trim();
  if (!clean) return null;
  const { rows } = await pool.exec(
    `SELECT * FROM users WHERE id = $1 OR supabase_id::text = $1 LIMIT 1`,
    [clean],
    () => {
      const db = loadUsersJson();
      const u = findUserInJsonByAnyId(db, clean);
      return { rows: u ? [u] : [], rowCount: u ? 1 : 0 };
    }
  );
  return rows[0] || null;
}

export async function getUserByEmail(email) {
  return sanitizeUser(await getUserRawByEmail(email));
}

export async function getUserById(userId) {
  return sanitizeUser(await getUserRawByAnyId(userId));
}

async function upsertProfileMirror(userRow) {
  if (!userRow) return;
  const supabaseId = userRow.supabase_id || (isUuid(userRow.id) ? userRow.id : null);
  if (!supabaseId || !isUuid(supabaseId)) return;
  const legacyId = userRow.id && userRow.id !== supabaseId ? userRow.id : null;
  const nowIso = userRow.updated_at || new Date().toISOString();

  await pool.exec(
    `INSERT INTO profiles (id, legacy_user_id, prenom, nom, email, telephone, email_verified, created_at, updated_at)
     VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (id) DO UPDATE SET
       legacy_user_id = COALESCE(EXCLUDED.legacy_user_id, profiles.legacy_user_id),
       prenom = EXCLUDED.prenom,
       nom = EXCLUDED.nom,
       email = EXCLUDED.email,
       telephone = EXCLUDED.telephone,
       email_verified = profiles.email_verified OR EXCLUDED.email_verified,
       updated_at = EXCLUDED.updated_at`,
    [
      supabaseId,
      legacyId,
      userRow.prenom || 'Client',
      userRow.nom || 'TickWay',
      normalizeEmail(userRow.email),
      userRow.telephone || '',
      Boolean(userRow.email_verified),
      userRow.created_at || nowIso,
      nowIso,
    ],
    () => {
      const db = loadUsersJson();
      db.profiles[supabaseId] = {
        id: supabaseId,
        legacy_user_id: legacyId || (db.profiles[supabaseId] && db.profiles[supabaseId].legacy_user_id) || null,
        prenom: userRow.prenom || 'Client',
        nom: userRow.nom || 'TickWay',
        email: normalizeEmail(userRow.email),
        telephone: userRow.telephone || '',
        email_verified: Boolean(userRow.email_verified || (db.profiles[supabaseId] && db.profiles[supabaseId].email_verified)),
        created_at: userRow.created_at || nowIso,
        updated_at: nowIso,
      };
      saveUsersJson(db);
      return { rows: [], rowCount: 1 };
    }
  );
}

/**
 * Synchronise ou rattache un compte TickWay à partir d'un utilisateur vérifié par Supabase Auth.
 * Sécurité : allowEmailLink ne doit être true qu'après une preuve cryptographique de propriété
 * (vérification du mot de passe PBKDF2 historique, confirmation d'inscription par e-mail ou OTP recovery validé).
 */
export async function syncUserFromSupabase(supaUser, { allowEmailLink = false, profileInput = {}, wipeLegacyPassword = false } = {}) {
  if (!supaUser || !isUuid(supaUser.id) || !supaUser.email) {
    return null;
  }

  const supabaseId = String(supaUser.id).trim();
  const cleanEmail = normalizeEmail(supaUser.email);
  const supaConfirmed = Boolean(supaUser.email_confirmed_at || supaUser.confirmed_at);
  const meta = supaUser.user_metadata && typeof supaUser.user_metadata === 'object' ? supaUser.user_metadata : {};
  const nowIso = new Date().toISOString();

  // 1. Recherche directe par supabase_id (cas nominal, aucune ambiguïté)
  let existingBySupa = await getUserRawByAnyId(supabaseId);
  if (existingBySupa) {
    const nextVerified = Boolean(existingBySupa.email_verified || supaConfirmed);
    const shouldWipePwd = wipeLegacyPassword && existingBySupa.password_hash !== 'supabase_managed';
    if (nextVerified !== Boolean(existingBySupa.email_verified) || shouldWipePwd || normalizeEmail(existingBySupa.email) !== cleanEmail) {
      const { rows } = await pool.exec(
        `UPDATE users
         SET email_verified = $2,
             email = $3,
             password_salt = CASE WHEN $4::boolean THEN '' ELSE password_salt END,
             password_hash = CASE WHEN $4::boolean THEN 'supabase_managed' ELSE password_hash END,
             updated_at = $5
         WHERE id = $1
         RETURNING *`,
        [existingBySupa.id, nextVerified, cleanEmail, shouldWipePwd, nowIso],
        () => {
          const db = loadUsersJson();
          const u = db.users[existingBySupa.id];
          if (!u) return { rows: [], rowCount: 0 };
          u.email_verified = nextVerified;
          u.email = cleanEmail;
          if (shouldWipePwd) {
            u.password_salt = '';
            u.password_hash = 'supabase_managed';
          }
          u.updated_at = nowIso;
          saveUsersJson(db);
          return { rows: [u], rowCount: 1 };
        }
      );
      if (rows[0]) existingBySupa = rows[0];
    }
    await upsertProfileMirror(existingBySupa);
    const sanitized = sanitizeUser(existingBySupa, supaUser);
    if (sanitized.emailVerified) {
      await attachPendingTransfersForVerifiedUser(sanitized);
    }
    return sanitized;
  }

  // 2. Recherche d'un éventuel compte historique non encore relié à Supabase
  const existingByEmail = await getUserRawByEmail(cleanEmail);
  if (existingByEmail) {
    if (existingByEmail.supabase_id && existingByEmail.supabase_id !== supabaseId) {
      return null;
    }
    if (!allowEmailLink) {
      // Bloquer tout rattachement automatique par simple e-mail sans preuve préalable
      return null;
    }

    const nextVerified = Boolean(existingByEmail.email_verified || supaConfirmed);
    const { rows } = await pool.exec(
      `UPDATE users
       SET supabase_id = $2::uuid,
           email_verified = $3,
           password_salt = CASE WHEN $4::boolean THEN '' ELSE password_salt END,
           password_hash = CASE WHEN $4::boolean THEN 'supabase_managed' ELSE password_hash END,
           updated_at = $5
       WHERE id = $1 AND (supabase_id IS NULL OR supabase_id = $2::uuid)
       RETURNING *`,
      [existingByEmail.id, supabaseId, nextVerified, Boolean(wipeLegacyPassword), nowIso],
      () => {
        const db = loadUsersJson();
        const u = db.users[existingByEmail.id];
        if (!u || (u.supabase_id && u.supabase_id !== supabaseId)) return { rows: [], rowCount: 0 };
        u.supabase_id = supabaseId;
        u.email_verified = nextVerified;
        if (wipeLegacyPassword) {
          u.password_salt = '';
          u.password_hash = 'supabase_managed';
        }
        u.updated_at = nowIso;
        saveUsersJson(db);
        return { rows: [u], rowCount: 1 };
      }
    );
    if (!rows[0]) return null;
    await upsertProfileMirror(rows[0]);
    const sanitized = sanitizeUser(rows[0], supaUser);
    if (sanitized.emailVerified) {
      await attachPendingTransfersForVerifiedUser(sanitized);
    }
    return sanitized;
  }

  // 3. Nouveau client natif Supabase Auth
  const prenom = String(profileInput.prenom || meta.prenom || 'Client').trim() || 'Client';
  const nom = String(profileInput.nom || meta.nom || 'TickWay').trim() || 'TickWay';
  const telephone = String(profileInput.telephone || meta.telephone || '').trim();

  const { rows } = await pool.exec(
    `INSERT INTO users (id, supabase_id, prenom, nom, email, telephone, password_salt, password_hash, email_verified, created_at, updated_at)
     VALUES ($1, $1::uuid, $2, $3, $4, $5, '', 'supabase_managed', $6, $7, $7)
     ON CONFLICT (id) DO UPDATE SET
       supabase_id = EXCLUDED.supabase_id,
       email_verified = users.email_verified OR EXCLUDED.email_verified,
       updated_at = EXCLUDED.updated_at
     RETURNING *`,
    [supabaseId, prenom, nom, cleanEmail, telephone, supaConfirmed, nowIso],
    () => {
      const db = loadUsersJson();
      const row = {
        id: supabaseId,
        supabase_id: supabaseId,
        prenom,
        nom,
        email: cleanEmail,
        telephone,
        password_salt: '',
        password_hash: 'supabase_managed',
        email_verified: supaConfirmed,
        created_at: nowIso,
        updated_at: nowIso,
      };
      db.users[supabaseId] = row;
      saveUsersJson(db);
      return { rows: [row], rowCount: 1 };
    }
  );
  const createdRow = rows[0];
  await upsertProfileMirror(createdRow);
  const sanitized = sanitizeUser(createdRow, supaUser);
  if (sanitized.emailVerified) {
    await attachPendingTransfersForVerifiedUser(sanitized);
  }
  return sanitized;
}

/**
 * Migration transparente lors du login d'un compte historique (PBKDF2) pas encore présent dans Supabase Auth.
 */
export async function authenticateAndMigrateLegacyUser({ email, password }) {
  const cleanEmail = normalizeEmail(email);
  const legacy = await getUserRawByEmail(cleanEmail);
  if (!legacy || legacy.supabase_id || legacy.password_hash === 'supabase_managed') {
    return { ok: false, reason: 'NOT_APPLICABLE' };
  }
  if (!verifyLegacyPassword(password, legacy.password_salt, legacy.password_hash)) {
    return { ok: false, reason: 'INVALID_CREDENTIALS' };
  }

  // Mot de passe historique prouvé côté serveur : provisionner dans Supabase Auth
  if (hasSupabaseAdminKey()) {
    try {
      await supabaseAdminCreateUser({
        email: legacy.email,
        password,
        emailConfirm: Boolean(legacy.email_verified),
        userMetadata: {
          prenom: legacy.prenom,
          nom: legacy.nom,
          telephone: legacy.telephone || '',
        },
      });
    } catch (adminErr) {
      if (adminErr && adminErr.status !== 422 && adminErr.status !== 409) {
        throw adminErr;
      }
    }
    const signIn = await supabaseSignInWithPassword({ email: legacy.email, password });
    const syncedUser = await syncUserFromSupabase(signIn.user, {
      allowEmailLink: true,
      wipeLegacyPassword: true,
    });
    return { ok: true, session: signIn, user: syncedUser };
  }

  let supaRes = null;
  try {
    supaRes = await supabaseSignUp({
      email: legacy.email,
      password,
      metadata: {
        prenom: legacy.prenom,
        nom: legacy.nom,
        telephone: legacy.telephone || '',
      },
    });
  } catch (err) {
    return {
      ok: false,
      reason: 'SUPABASE_CONFLICT',
      message: 'Un compte existe déjà côté authentification. Utilisez « Mot de passe oublié ? » pour sécuriser votre accès.',
    };
  }

  const supaUser = supaRes && (supaRes.user || (supaRes.id ? supaRes : null));
  if (supaRes && supaRes.access_token && supaUser) {
    const syncedUser = await syncUserFromSupabase(supaUser, {
      allowEmailLink: true,
      wipeLegacyPassword: true,
    });
    return { ok: true, session: supaRes, user: syncedUser };
  }

  if (supaUser && isUuid(supaUser.id)) {
    await syncUserFromSupabase(supaUser, {
      allowEmailLink: true,
      wipeLegacyPassword: true,
    });
    return {
      ok: false,
      reason: 'EMAIL_CONFIRMATION_REQUIRED',
      email: legacy.email,
      message: 'Migration du compte initiée : confirmez votre adresse e-mail via le code envoyé par Supabase avant de vous connecter.',
    };
  }

  return { ok: false, reason: 'MIGRATION_FAILED' };
}

/**
 * Vérification stricte côté serveur de chaque requête authentifiée via Supabase Auth (/auth/v1/user).
 */
export async function verifyUserSession(rawToken) {
  if (!rawToken || typeof rawToken !== 'string' || rawToken.trim().length < 16) return null;
  const cleanToken = rawToken.trim();

  let supaUser = null;
  try {
    supaUser = await supabaseGetUser(cleanToken);
  } catch (err) {
    if (err && (err.status === 401 || err.status === 403 || err.status === 400)) {
      return null;
    }
    const serviceErr = new Error("Impossible de vérifier la session auprès du service d'authentification.");
    serviceErr.status = 503;
    throw serviceErr;
  }

  if (!supaUser || !isUuid(supaUser.id) || !supaUser.email) {
    return null;
  }

  const user = await syncUserFromSupabase(supaUser, { allowEmailLink: false });
  if (!user) return null;

  return {
    user,
    supabaseUser: supaUser,
    expiresAt: null,
  };
}

export async function revokeAllLegacyUserSessions(userOrId) {
  const ownerIds = extractOwnerIds(userOrId);
  if (!ownerIds.length) return;
  await pool.exec(
    `DELETE FROM user_sessions WHERE user_id = ANY($1::text[])`,
    [ownerIds],
    () => {
      const db = loadUsersJson();
      for (const [k, s] of Object.entries(db.sessions)) {
        if (s && ownerIds.includes(s.user_id)) delete db.sessions[k];
      }
      saveUsersJson(db);
      return { rows: [], rowCount: 1 };
    }
  );
}

/**
 * Limitation de débit persistante (PostgreSQL + fallback JSON verrouillé) contre brute-force et abus.
 */
export async function checkAndTouchRateLimit(rateKey, { maxAttempts = 5, windowMs = 15 * 60 * 1000, lockoutMs = 10 * 60 * 1000, increment = false } = {}) {
  const key = String(rateKey || '').slice(0, 180);
  if (!key) return { allowed: true, attemptsLeft: maxAttempts, remainingSec: 0 };

  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();

  return pool.withTransaction(
    async (client) => {
      const { rows } = await client.query(
        `SELECT * FROM auth_rate_limits WHERE rate_key = $1 FOR UPDATE`,
        [key]
      );
      let row = rows[0];

      if (!row || (Date.parse(row.window_start) + windowMs <= nowMs && (!row.locked_until || Date.parse(row.locked_until) <= nowMs))) {
        const nextAttempts = increment ? 1 : 0;
        const locked = increment && nextAttempts >= maxAttempts ? new Date(nowMs + lockoutMs).toISOString() : null;
        await client.query(
          `INSERT INTO auth_rate_limits (rate_key, attempts, window_start, locked_until, updated_at)
           VALUES ($1, $2, $3, $4, $3)
           ON CONFLICT (rate_key) DO UPDATE SET
             attempts = EXCLUDED.attempts,
             window_start = EXCLUDED.window_start,
             locked_until = EXCLUDED.locked_until,
             updated_at = EXCLUDED.updated_at`,
          [key, nextAttempts, nowIso, locked]
        );
        if (locked) {
          return { allowed: false, attemptsLeft: 0, remainingSec: Math.ceil(lockoutMs / 1000) };
        }
        return { allowed: true, attemptsLeft: Math.max(0, maxAttempts - nextAttempts), remainingSec: 0 };
      }

      if (row.locked_until && Date.parse(row.locked_until) > nowMs) {
        return {
          allowed: false,
          attemptsLeft: 0,
          remainingSec: Math.max(1, Math.ceil((Date.parse(row.locked_until) - nowMs) / 1000)),
        };
      }

      if (!increment) {
        return {
          allowed: true,
          attemptsLeft: Math.max(0, maxAttempts - Number(row.attempts || 0)),
          remainingSec: 0,
        };
      }

      const nextAttempts = Number(row.attempts || 0) + 1;
      const locked = nextAttempts >= maxAttempts ? new Date(nowMs + lockoutMs).toISOString() : null;
      await client.query(
        `UPDATE auth_rate_limits SET attempts = $2, locked_until = $3, updated_at = $4 WHERE rate_key = $1`,
        [key, nextAttempts, locked, nowIso]
      );
      if (locked) {
        return { allowed: false, attemptsLeft: 0, remainingSec: Math.ceil(lockoutMs / 1000) };
      }
      return { allowed: true, attemptsLeft: Math.max(0, maxAttempts - nextAttempts), remainingSec: 0 };
    },
    () => {
      const db = loadUsersJson();
      const row = db.rateLimits[key];
      if (!row || (Date.parse(row.window_start) + windowMs <= nowMs && (!row.locked_until || Date.parse(row.locked_until) <= nowMs))) {
        const nextAttempts = increment ? 1 : 0;
        const locked = increment && nextAttempts >= maxAttempts ? new Date(nowMs + lockoutMs).toISOString() : null;
        db.rateLimits[key] = {
          rate_key: key,
          attempts: nextAttempts,
          window_start: nowIso,
          locked_until: locked,
          updated_at: nowIso,
        };
        saveUsersJson(db);
        if (locked) return { allowed: false, attemptsLeft: 0, remainingSec: Math.ceil(lockoutMs / 1000) };
        return { allowed: true, attemptsLeft: Math.max(0, maxAttempts - nextAttempts), remainingSec: 0 };
      }

      if (row.locked_until && Date.parse(row.locked_until) > nowMs) {
        return {
          allowed: false,
          attemptsLeft: 0,
          remainingSec: Math.max(1, Math.ceil((Date.parse(row.locked_until) - nowMs) / 1000)),
        };
      }

      if (!increment) {
        return { allowed: true, attemptsLeft: Math.max(0, maxAttempts - Number(row.attempts || 0)), remainingSec: 0 };
      }

      row.attempts = Number(row.attempts || 0) + 1;
      row.locked_until = row.attempts >= maxAttempts ? new Date(nowMs + lockoutMs).toISOString() : null;
      row.updated_at = nowIso;
      saveUsersJson(db);
      if (row.locked_until) return { allowed: false, attemptsLeft: 0, remainingSec: Math.ceil(lockoutMs / 1000) };
      return { allowed: true, attemptsLeft: Math.max(0, maxAttempts - row.attempts), remainingSec: 0 };
    }
  );
}

export async function clearPersistentRateLimit(rateKey) {
  const key = String(rateKey || '').slice(0, 180);
  if (!key) return;
  await pool.exec(
    `DELETE FROM auth_rate_limits WHERE rate_key = $1`,
    [key],
    () => {
      const db = loadUsersJson();
      delete db.rateLimits[key];
      saveUsersJson(db);
      return { rows: [], rowCount: 1 };
    }
  );
}

/**
 * Émet un jeton éphémère à usage unique (côté serveur uniquement) après validation OTP Supabase type=recovery.
 * Aucun jeton d'accès utilisateur ou billet n'est remis au navigateur avant la saisie du nouveau mot de passe.
 */
export async function issuePasswordResetGrant({ supabaseUserId, email, recoveryAccessToken }) {
  const cleanEmail = normalizeEmail(email);
  const rawResetToken = crypto.randomBytes(32).toString('hex');
  const grantHash = hashSecret(`reset_grant:${rawResetToken}`);
  const encryptedRecovery = encryptRecoveryToken(recoveryAccessToken);
  const now = Date.now();
  const expiresAt = new Date(now + RESET_GRANT_TTL_MS).toISOString();
  const createdAt = new Date(now).toISOString();

  await pool.exec(
    `WITH invalidated AS (
       UPDATE password_reset_grants SET used = true WHERE LOWER(email) = LOWER($1) AND used = false
     )
     INSERT INTO password_reset_grants (grant_hash, supabase_user_id, email, supabase_access_token_enc, used, expires_at, created_at)
     VALUES ($2, $3::uuid, $1, $4, false, $5, $6)`,
    [cleanEmail, grantHash, supabaseUserId, encryptedRecovery, expiresAt, createdAt],
    () => {
      const db = loadUsersJson();
      for (const g of Object.values(db.resetGrants)) {
        if (g && normalizeEmail(g.email) === cleanEmail && !g.used) g.used = true;
      }
      db.resetGrants[grantHash] = {
        grant_hash: grantHash,
        supabase_user_id: supabaseUserId,
        email: cleanEmail,
        supabase_access_token_enc: encryptedRecovery,
        used: false,
        expires_at: expiresAt,
        created_at: createdAt,
      };
      saveUsersJson(db);
      return { rows: [], rowCount: 1 };
    }
  );

  return {
    resetToken: rawResetToken,
    expiresAt,
    expiresInSeconds: Math.floor(RESET_GRANT_TTL_MS / 1000),
  };
}

export async function consumePasswordResetGrant(rawResetToken) {
  const clean = String(rawResetToken || '').trim();
  if (clean.length < 32) return null;
  const grantHash = hashSecret(`reset_grant:${clean}`);

  const { rows } = await pool.exec(
    `UPDATE password_reset_grants
     SET used = true
     WHERE grant_hash = $1 AND used = false AND expires_at > now()
     RETURNING *`,
    [grantHash],
    () => {
      const db = loadUsersJson();
      const g = db.resetGrants[grantHash];
      if (!g || g.used || Date.parse(g.expires_at) <= Date.now()) {
        return { rows: [], rowCount: 0 };
      }
      g.used = true;
      saveUsersJson(db);
      return { rows: [g], rowCount: 1 };
    }
  );

  const row = rows[0];
  if (!row) return null;
  const recoveryAccessToken = decryptRecoveryToken(row.supabase_access_token_enc);
  if (!recoveryAccessToken) return null;
  return {
    supabaseUserId: row.supabase_user_id,
    email: row.email,
    recoveryAccessToken,
  };
}

export async function updateUserProfile({ userId, prenom, nom, telephone }) {
  const cleanPrenom = String(prenom || '').trim();
  const cleanNom = String(nom || '').trim();
  const cleanTel = String(telephone || '').trim();
  if (cleanPrenom.length < 2 || cleanNom.length < 2) {
    const err = new Error('Le nom et le prénom doivent contenir au moins 2 caractères.');
    err.status = 400;
    throw err;
  }

  const raw = await getUserRawByAnyId(userId);
  if (!raw) {
    const err = new Error('Compte introuvable.');
    err.status = 404;
    throw err;
  }

  const nowIso = new Date().toISOString();
  const { rows } = await pool.exec(
    `UPDATE users SET prenom = $2, nom = $3, telephone = $4, updated_at = $5 WHERE id = $1 RETURNING *`,
    [raw.id, cleanPrenom, cleanNom, cleanTel, nowIso],
    () => {
      const db = loadUsersJson();
      const u = db.users[raw.id];
      if (!u) return { rows: [], rowCount: 0 };
      u.prenom = cleanPrenom;
      u.nom = cleanNom;
      u.telephone = cleanTel;
      u.updated_at = nowIso;
      saveUsersJson(db);
      return { rows: [u], rowCount: 1 };
    }
  );
  if (rows[0]) await upsertProfileMirror(rows[0]);
  return sanitizeUser(rows[0]);
}

function sanitizeTransferRecord(tr, viewerOwnerIds = []) {
  if (!tr) return null;
  const ownerSet = Array.isArray(viewerOwnerIds) ? viewerOwnerIds : [viewerOwnerIds].filter(Boolean);
  let direction = null;
  if (ownerSet.length) {
    if (ownerSet.includes(tr.from_user_id)) direction = 'sortant';
    else if (ownerSet.includes(tr.to_user_id)) direction = 'entrant';
  }
  return {
    id: tr.id,
    oldReference: tr.old_reference,
    newReference: tr.new_reference,
    commandeId: tr.commande_id || tr.old_reference,
    eventId: tr.event_id,
    eventNom: tr.event_nom,
    eventDate: tr.event_date,
    categorie: tr.categorie || 'Standard Navette',
    fromUserId: tr.from_user_id,
    fromName: tr.from_name,
    fromEmail: tr.from_email,
    toUserId: tr.to_user_id || null,
    toName: tr.to_name || tr.to_email,
    toEmail: tr.to_email,
    statut: tr.statut || 'complete',
    direction,
    createdAt: tr.created_at,
    claimedAt: tr.claimed_at || null,
  };
}

export async function attachPendingTransfersForVerifiedUser(userRow) {
  if (!userRow) return [];
  const isVerified = Boolean(userRow.email_verified || userRow.emailVerified);
  if (!isVerified) return [];

  const canonicalId = userRow.supabaseId || userRow.supabase_id || userRow.id;
  const verifiedEmail = normalizeEmail(userRow.email);
  const fullName = `${userRow.prenom || ''} ${userRow.nom || ''}`.trim() || verifiedEmail;
  const nowIso = new Date().toISOString();

  return pool.withTransaction(
    async (client) => {
      const { rows: pendingTickets } = await client.query(
        `SELECT reference FROM reservations
         WHERE LOWER(email) = LOWER($1)
           AND transferred_from IS NOT NULL
           AND statut = 'valide'
           AND (user_id IS NULL OR user_id = '')
         FOR UPDATE`,
        [verifiedEmail]
      );
      if (!pendingTickets.length) return [];
      const refs = pendingTickets.map((r) => r.reference);

      await client.query(
        `UPDATE reservations
         SET user_id = $1, prenom = $2, nom = $3, telephone = $4
         WHERE reference = ANY($5::text[]) AND (user_id IS NULL OR user_id = '')`,
        [canonicalId, userRow.prenom || 'Client', userRow.nom || '', userRow.telephone || '', refs]
      );
      await client.query(
        `UPDATE ticket_transfers
         SET to_user_id = $1, to_name = $2, pending_recipient_claim = false, statut = 'reclame', claimed_at = $3
         WHERE new_reference = ANY($4::text[]) AND pending_recipient_claim = true`,
        [canonicalId, fullName, nowIso, refs]
      );
      return refs;
    },
    () => {
      const db = loadReservationsJson();
      const matchedRefs = [];
      for (const r of Object.values(db)) {
        if (
          r &&
          normalizeEmail(r.email) === verifiedEmail &&
          r.transferred_from &&
          r.statut === 'valide' &&
          (!r.user_id || r.user_id === '')
        ) {
          r.user_id = canonicalId;
          r.prenom = userRow.prenom || 'Client';
          r.nom = userRow.nom || '';
          r.telephone = userRow.telephone || '';
          matchedRefs.push(r.reference);
        }
      }
      if (!matchedRefs.length) return [];
      saveReservationsJson(db);

      const transfers = loadTransfersJson();
      let changed = false;
      for (const tr of transfers) {
        if (tr && matchedRefs.includes(tr.new_reference) && tr.pending_recipient_claim) {
          tr.to_user_id = canonicalId;
          tr.to_name = fullName;
          tr.pending_recipient_claim = false;
          tr.statut = 'reclame';
          tr.claimed_at = nowIso;
          changed = true;
        }
      }
      if (changed) saveTransfersJson(transfers);
      return matchedRefs;
    }
  );
}

export async function getUserDashboard(userOrId, fallbackOrigin) {
  const userId = typeof userOrId === 'string' ? userOrId : (userOrId && userOrId.id);
  const userRow = await getUserRawByAnyId(userId);
  const sanitized = userRow ? sanitizeUser(userRow) : (typeof userOrId === 'object' ? userOrId : null);
  const ownerIds = extractOwnerIds(userOrId, userRow);

  if (sanitized && sanitized.emailVerified) {
    await attachPendingTransfersForVerifiedUser(sanitized);
  }

  const cfg = getTransferConfig();
  const { rows } = ownerIds.length
    ? await pool.query(
        `SELECT * FROM reservations WHERE user_id = ANY($1::text[]) ORDER BY cree_le DESC`,
        [ownerIds]
      )
    : { rows: [] };

  const ownedRows = (rows || []).filter((r) => r.statut !== 'transfere');
  const tickets = ownedRows.map((r) => mapReservationToTicket(r, fallbackOrigin, cfg));
  const activeTickets = tickets.filter((t) => t.statut === 'valide' || t.statut === 'en_attente');
  const usedTickets = tickets.filter((t) => t.statut === 'utilise' || t.statut === 'annule');

  const orderMap = new Map();
  for (const t of tickets) {
    const cid = t.commandeId || t.reference;
    if (!orderMap.has(cid)) {
      orderMap.set(cid, {
        commandeId: cid,
        creeLe: t.creeLe,
        eventNom: t.eventNom,
        eventDate: t.eventDate,
        pointRelais: t.pointRelais,
        zone: t.zone,
        modePaiement: t.modePaiement,
        quantite: 0,
        montantTotal: 0,
        tickets: [],
      });
    }
    const ord = orderMap.get(cid);
    ord.tickets.push(t);
    ord.quantite += 1;
    ord.montantTotal += Number(t.montant) || 0;
    if (String(t.creeLe) > String(ord.creeLe)) ord.creeLe = t.creeLe;
  }

  const orders = [...orderMap.values()].sort((a, b) => String(b.creeLe).localeCompare(String(a.creeLe)));

  const { rows: transferRows } = ownerIds.length
    ? await pool.exec(
        `SELECT * FROM ticket_transfers WHERE from_user_id = ANY($1::text[]) OR to_user_id = ANY($1::text[]) ORDER BY created_at DESC`,
        [ownerIds],
        () => {
          const all = loadTransfersJson();
          const matched = all
            .filter((tr) => tr && (ownerIds.includes(tr.from_user_id) || ownerIds.includes(tr.to_user_id)))
            .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
          return { rows: matched, rowCount: matched.length };
        }
      )
    : { rows: [] };

  const transfers = (transferRows || []).map((tr) => sanitizeTransferRecord(tr, ownerIds));
  const outgoingTransfersUsed = transfers.filter((tr) => ownerIds.includes(tr.fromUserId) && tr.statut !== 'annule').length;

  return {
    stats: {
      totalBillets: tickets.length,
      billetsActifs: activeTickets.length,
      billetsUtilises: tickets.filter((t) => t.statut === 'utilise').length,
      billetsAnnules: tickets.filter((t) => t.statut === 'annule').length,
      billetsEnAttente: tickets.filter((t) => t.statut === 'en_attente').length,
      totalCommandes: orders.length,
      totalTransferts: transfers.length,
      outgoingTransfersUsed,
      montantTotal: tickets
        .filter((t) => t.statut !== 'annule')
        .reduce((acc, t) => acc + (Number(t.montant) || 0), 0),
    },
    transferPolicy: {
      ...cfg,
      outgoingTransfersUsed,
      remainingUserTransfers: Math.max(0, Number(cfg.maxTransfersPerUser ?? 5) - outgoingTransfersUsed),
    },
    activeTickets,
    usedTickets,
    orders,
    transfers,
  };
}

export async function getUserTicketByReference(userOrId, reference, fallbackOrigin) {
  const ref = String(reference || '').trim().toUpperCase();
  if (!ref || !userOrId) return null;
  const userId = typeof userOrId === 'string' ? userOrId : userOrId.id;
  const userRaw = await getUserRawByAnyId(userId);
  const ownerIds = extractOwnerIds(userOrId, userRaw);
  if (!ownerIds.length) return null;

  const { rows } = await pool.query(
    `SELECT * FROM reservations WHERE reference = $1 LIMIT 1`,
    [ref]
  );
  const row = rows[0];
  if (!row || !ownerIds.includes(row.user_id)) return null;
  if (row.statut === 'transfere' || row.statut === 'annule') return { invalidated: true, statut: row.statut };
  return mapReservationToTicket(row, fallbackOrigin);
}

export async function getGuestTicketsByAccessToken(rawToken, fallbackOrigin) {
  const clean = String(rawToken || '').trim();
  if (clean.length < 16) return [];
  const accessHash = hashSecret(clean);
  const { rows } = await pool.query(
    `SELECT * FROM reservations WHERE guest_access_hash = $1 ORDER BY cree_le ASC`,
    [accessHash]
  );
  return (rows || [])
    .filter((r) => r.statut === 'valide' || r.statut === 'utilise')
    .map((r) => mapReservationToTicket(r, fallbackOrigin));
}

function makeTxError(status, code, message) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

/**
 * Transfère de façon atomique un billet actif exclusivement vers une adresse e-mail.
 * - Invalide l'ancien billet + ancien QR code (statut = 'transfere', qr_text = NULL)
 * - Génère une nouvelle référence unique et un nouveau QR code sécurisé
 * - Rattache directement au compte destinataire si son e-mail est déjà vérifié, sinon en attente via lien sécurisé
 */
export async function transferTicket({ fromUserId, reference, recipientEmail, baseOrigin = 'https://tickway.netlify.app' }) {
  const ref = String(reference || '').trim().toUpperCase();
  const cleanRecipientEmail = normalizeEmail(recipientEmail);
  const origin = String(baseOrigin || 'https://tickway.netlify.app').replace(/\/$/, '');

  if (!fromUserId) {
    throw makeTxError(401, 'UNAUTHORIZED', 'Authentification requise pour transférer un billet.');
  }
  if (!/^TW-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(ref)) {
    throw makeTxError(400, 'INVALID_REFERENCE', 'Référence de billet invalide.');
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(cleanRecipientEmail)) {
    throw makeTxError(400, 'INVALID_RECIPIENT_EMAIL', 'Adresse e-mail du destinataire invalide.');
  }

  const fromUserRaw = await getUserRawByAnyId(fromUserId);
  if (!fromUserRaw) {
    throw makeTxError(401, 'USER_NOT_FOUND', 'Compte propriétaire introuvable.');
  }
  const fromCanonicalId = fromUserRaw.supabase_id || fromUserRaw.id;
  const fromOwnerIds = extractOwnerIds(fromUserId, fromUserRaw);

  if (cleanRecipientEmail === normalizeEmail(fromUserRaw.email)) {
    throw makeTxError(400, 'SELF_TRANSFER', 'Vous ne pouvez pas transférer un billet vers votre propre adresse e-mail.');
  }

  const cfg = getTransferConfig();
  if (!cfg.enabled) {
    throw makeTxError(403, 'TRANSFERS_DISABLED', 'Le transfert de billets est temporairement désactivé par l’administrateur.');
  }

  const newRef = await generateReference();
  const qrNonce = crypto.randomBytes(8).toString('hex');
  const newQrText = `${origin}/#controle?c=${encodeURIComponent(newRef)}&q=${qrNonce}`;
  const transferAccessToken = crypto.randomBytes(24).toString('base64url');
  const transferAccessHash = hashSecret(transferAccessToken);
  const transferId = 'trf_' + crypto.randomBytes(10).toString('hex');
  const nowIso = new Date().toISOString();
  const fromName = `${fromUserRaw.prenom || ''} ${fromUserRaw.nom || ''}`.trim() || fromUserRaw.email;

  const outcome = await pool.withTransaction(
    async (client) => {
      await client.query(`SELECT id FROM users WHERE id = $1 FOR UPDATE`, [fromUserRaw.id]);

      const { rows: ticketRows } = await client.query(
        `SELECT * FROM reservations WHERE reference = $1 FOR UPDATE`,
        [ref]
      );
      const oldRow = ticketRows[0];
      if (!oldRow) {
        throw makeTxError(404, 'TICKET_NOT_FOUND', 'Billet introuvable.');
      }
      if (!fromOwnerIds.includes(oldRow.user_id)) {
        throw makeTxError(403, 'NOT_OWNER', 'Seul le propriétaire actuel du billet peut le transférer.');
      }
      if (oldRow.statut === 'utilise') {
        throw makeTxError(409, 'TICKET_USED', 'Impossible de transférer un billet déjà utilisé.');
      }
      if (oldRow.statut === 'annule') {
        throw makeTxError(409, 'TICKET_CANCELLED', 'Impossible de transférer un billet annulé.');
      }
      if (oldRow.statut === 'transfere') {
        throw makeTxError(409, 'ALREADY_TRANSFERRED', 'Ce billet a déjà été transféré et son ancien QR code est invalidé.');
      }
      if (oldRow.statut !== 'valide') {
        throw makeTxError(409, 'TICKET_NOT_ACTIVE', 'Seul un billet actif et payé peut être transféré.');
      }
      if (isEventExpired(oldRow.event_id)) {
        throw makeTxError(400, 'TICKET_EXPIRED', 'Impossible de transférer un billet pour un événement expiré.');
      }

      const currentCount = Number(oldRow.transfer_count) || 0;
      if (currentCount >= Number(cfg.maxTransfersPerTicket ?? 1)) {
        throw makeTxError(
          403,
          'TRANSFER_LIMIT_TICKET',
          `Limite atteinte : un billet ne peut être transféré que ${cfg.maxTransfersPerTicket} fois maximum.`
        );
      }

      const { rows: countRows } = await client.query(
        `SELECT COUNT(*)::int AS cnt FROM ticket_transfers WHERE from_user_id = ANY($1::text[]) AND statut != 'annule'`,
        [fromOwnerIds]
      );
      const userOutCount = Number(countRows[0] && countRows[0].cnt) || 0;
      if (userOutCount >= Number(cfg.maxTransfersPerUser ?? 5)) {
        throw makeTxError(
          403,
          'TRANSFER_LIMIT_USER',
          `Vous avez atteint votre limite maximale de ${cfg.maxTransfersPerUser} transfert(s) autorisé(s).`
        );
      }

      const { rows: recipRows } = await client.query(
        `SELECT * FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1`,
        [cleanRecipientEmail]
      );
      const recipUser = recipRows[0] || null;
      const hasVerifiedAccount = Boolean(recipUser && recipUser.email_verified);

      const toUserId = hasVerifiedAccount ? (recipUser.supabase_id || recipUser.id) : null;
      const toPrenom = hasVerifiedAccount ? recipUser.prenom : 'Bénéficiaire';
      const toNom = hasVerifiedAccount ? recipUser.nom : cleanRecipientEmail;
      const toTel = hasVerifiedAccount ? (recipUser.telephone || '') : '';
      const toName = hasVerifiedAccount ? `${recipUser.prenom} ${recipUser.nom}`.trim() : cleanRecipientEmail;
      const pendingClaim = !hasVerifiedAccount;
      const transferStatut = hasVerifiedAccount ? 'complete' : 'en_attente_compte';

      const { rowCount: invCount } = await client.query(
        `UPDATE reservations
         SET statut = 'transfere', transferred_to = $2, transferred_at = $3, qr_text = NULL, guest_access_hash = NULL
         WHERE reference = $1 AND user_id = ANY($4::text[]) AND statut = 'valide'`,
        [ref, newRef, nowIso, fromOwnerIds]
      );
      if (invCount !== 1) {
        throw makeTxError(409, 'CONCURRENT_TRANSFER', 'Conflit détecté : ce billet n’est plus transférable.');
      }

      const { rows: insertedRows } = await client.query(
        `INSERT INTO reservations
          (reference, commande_id, user_id, prenom, nom, telephone, email, localite, categorie,
           event_id, event_nom, event_date,
           zone, point_relais, montant, mode_paiement, quantite, statut, frais_transaction,
           qr_text, guest_access_hash, transfer_count, transferred_from, cree_le)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)
         RETURNING *`,
        [
          newRef,
          oldRow.commande_id || oldRow.reference,
          toUserId,
          toPrenom,
          toNom,
          toTel,
          cleanRecipientEmail,
          oldRow.localite || 'Localité non renseignée',
          oldRow.categorie || 'Standard Navette',
          oldRow.event_id,
          oldRow.event_nom,
          oldRow.event_date,
          oldRow.zone,
          oldRow.point_relais,
          Number(oldRow.montant) || 6000,
          oldRow.mode_paiement || 'Wave',
          1,
          'valide',
          Number(oldRow.frais_transaction) || 0,
          newQrText,
          transferAccessHash,
          currentCount + 1,
          oldRow.reference,
          nowIso,
        ]
      );

      const { rows: trRows } = await client.query(
        `INSERT INTO ticket_transfers
          (id, old_reference, new_reference, commande_id, event_id, event_nom, event_date, categorie,
           from_user_id, from_name, from_email, to_user_id, to_name, to_email,
           access_token_hash, pending_recipient_claim, statut, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
         RETURNING *`,
        [
          transferId,
          oldRow.reference,
          newRef,
          oldRow.commande_id || oldRow.reference,
          oldRow.event_id,
          oldRow.event_nom,
          oldRow.event_date,
          oldRow.categorie || 'Standard Navette',
          fromCanonicalId,
          fromName,
          normalizeEmail(fromUserRaw.email),
          toUserId,
          toName,
          cleanRecipientEmail,
          transferAccessHash,
          pendingClaim,
          transferStatut,
          nowIso,
        ]
      );

      return {
        newRow: insertedRows[0],
        trRow: trRows[0],
        hasVerifiedAccount,
      };
    },
    () => {
      const db = loadReservationsJson();
      const usersDb = loadUsersJson();
      const transfers = loadTransfersJson();

      const oldRow = db[ref];
      if (!oldRow) {
        throw makeTxError(404, 'TICKET_NOT_FOUND', 'Billet introuvable.');
      }
      if (!fromOwnerIds.includes(oldRow.user_id)) {
        throw makeTxError(403, 'NOT_OWNER', 'Seul le propriétaire actuel du billet peut le transférer.');
      }
      if (oldRow.statut === 'utilise') {
        throw makeTxError(409, 'TICKET_USED', 'Impossible de transférer un billet déjà utilisé.');
      }
      if (oldRow.statut === 'annule') {
        throw makeTxError(409, 'TICKET_CANCELLED', 'Impossible de transférer un billet annulé.');
      }
      if (oldRow.statut === 'transfere') {
        throw makeTxError(409, 'ALREADY_TRANSFERRED', 'Ce billet a déjà été transféré et son ancien QR code est invalidé.');
      }
      if (oldRow.statut !== 'valide') {
        throw makeTxError(409, 'TICKET_NOT_ACTIVE', 'Seul un billet actif et payé peut être transféré.');
      }
      if (isEventExpired(oldRow.event_id)) {
        throw makeTxError(400, 'TICKET_EXPIRED', 'Impossible de transférer un billet pour un événement expiré.');
      }

      const currentCount = Number(oldRow.transfer_count) || 0;
      if (currentCount >= Number(cfg.maxTransfersPerTicket ?? 1)) {
        throw makeTxError(
          403,
          'TRANSFER_LIMIT_TICKET',
          `Limite atteinte : un billet ne peut être transféré que ${cfg.maxTransfersPerTicket} fois maximum.`
        );
      }

      const userOutCount = transfers.filter((tr) => tr && fromOwnerIds.includes(tr.from_user_id) && tr.statut !== 'annule').length;
      if (userOutCount >= Number(cfg.maxTransfersPerUser ?? 5)) {
        throw makeTxError(
          403,
          'TRANSFER_LIMIT_USER',
          `Vous avez atteint votre limite maximale de ${cfg.maxTransfersPerUser} transfert(s) autorisé(s).`
        );
      }

      const recipUser = findUserInJsonByEmail(usersDb, cleanRecipientEmail);
      const hasVerifiedAccount = Boolean(recipUser && recipUser.email_verified);
      const toUserId = hasVerifiedAccount ? (recipUser.supabase_id || recipUser.id) : null;
      const toPrenom = hasVerifiedAccount ? recipUser.prenom : 'Bénéficiaire';
      const toNom = hasVerifiedAccount ? recipUser.nom : cleanRecipientEmail;
      const toTel = hasVerifiedAccount ? (recipUser.telephone || '') : '';
      const toName = hasVerifiedAccount ? `${recipUser.prenom} ${recipUser.nom}`.trim() : cleanRecipientEmail;
      const pendingClaim = !hasVerifiedAccount;
      const transferStatut = hasVerifiedAccount ? 'complete' : 'en_attente_compte';

      oldRow.statut = 'transfere';
      oldRow.transferred_to = newRef;
      oldRow.transferred_at = nowIso;
      oldRow.qr_text = null;
      oldRow.guest_access_hash = null;

      const newRow = {
        reference: newRef,
        commande_id: oldRow.commande_id || oldRow.reference,
        user_id: toUserId,
        prenom: toPrenom,
        nom: toNom,
        telephone: toTel,
        email: cleanRecipientEmail,
        localite: oldRow.localite || 'Localité non renseignée',
        categorie: oldRow.categorie || 'Standard Navette',
        event_id: oldRow.event_id,
        event_nom: oldRow.event_nom,
        event_date: oldRow.event_date,
        zone: oldRow.zone,
        point_relais: oldRow.point_relais,
        montant: Number(oldRow.montant) || 6000,
        frais_transaction: Number(oldRow.frais_transaction) || 0,
        mode_paiement: oldRow.mode_paiement || 'Wave',
        quantite: 1,
        statut: 'valide',
        qr_text: newQrText,
        guest_access_hash: transferAccessHash,
        transfer_count: currentCount + 1,
        transferred_from: oldRow.reference,
        transferred_to: null,
        transferred_at: null,
        cree_le: nowIso,
        utilise_le: null,
        agent_id: null,
        equipe_id: null,
        equipe_nom: null,
      };
      db[newRef] = newRow;
      saveReservationsJson(db);

      const trRow = {
        id: transferId,
        old_reference: oldRow.reference,
        new_reference: newRef,
        commande_id: oldRow.commande_id || oldRow.reference,
        event_id: oldRow.event_id,
        event_nom: oldRow.event_nom,
        event_date: oldRow.event_date,
        categorie: oldRow.categorie || 'Standard Navette',
        from_user_id: fromCanonicalId,
        from_name: fromName,
        from_email: normalizeEmail(fromUserRaw.email),
        to_user_id: toUserId,
        to_name: toName,
        to_email: cleanRecipientEmail,
        access_token_hash: transferAccessHash,
        pending_recipient_claim: pendingClaim,
        statut: transferStatut,
        created_at: nowIso,
        claimed_at: null,
      };
      transfers.unshift(trRow);
      saveTransfersJson(transfers);

      return { newRow, trRow, hasVerifiedAccount };
    }
  );

  const ticketsUrl = `${origin}/#tickets?k=${encodeURIComponent(transferAccessToken)}`;
  const registerUrl = `${origin}/#compte?mode=register`;

  return {
    ok: true,
    oldReference: ref,
    newReference: newRef,
    transferAccessToken,
    ticketsUrl,
    registerUrl,
    hasVerifiedAccount: outcome.hasVerifiedAccount,
    fromUser: sanitizeUser(fromUserRaw),
    newTicket: mapReservationToTicket(outcome.newRow, origin, cfg),
    transfer: sanitizeTransferRecord(outcome.trRow, fromOwnerIds),
  };
}

export async function getAdminTransfersReport() {
  const cfg = getTransferConfig();
  const { rows } = await pool.exec(
    `SELECT * FROM ticket_transfers ORDER BY created_at DESC LIMIT 500`,
    [],
    () => {
      const list = loadTransfersJson()
        .slice()
        .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))
        .slice(0, 500);
      return { rows: list, rowCount: list.length };
    }
  );

  const transfers = (rows || []).map((tr) => sanitizeTransferRecord(tr, []));
  const stats = {
    total: transfers.length,
    completes: transfers.filter((t) => t.statut === 'complete').length,
    reclames: transfers.filter((t) => t.statut === 'reclame').length,
    enAttente: transfers.filter((t) => t.statut === 'en_attente_compte').length,
  };
  return { config: cfg, stats, transfers };
}
