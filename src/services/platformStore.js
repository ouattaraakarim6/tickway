// src/services/platformStore.js — Équipes, scans, fondateur, capacités, dépenses & sessions (MySQL)
import crypto from 'node:crypto';
import pool from '../db/pool.js';
import { EVENTS } from './events.js';
import { deriveKey } from './secrets.js';

const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const SESSION_TIMEOUT_MS = 15 * 60 * 1000;        // Fondateur : 15 min d'inactivité maximum
const TEAM_SESSION_TIMEOUT_MS = 12 * 60 * 60 * 1000; // Équipe terrain : 12 h d'inactivité maximum
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS = 5 * 60 * 1000;          // 5 minutes de blocage après 5 échecs
const MAX_SCAN_LOGS = 1000;
const DEFAULT_TRANSFER_CONFIG = { enabled: true, maxTransfersPerTicket: 1, maxTransfersPerUser: 5 };

// ── Utilitaires cryptographiques ──
export function hashKeySha256(rawKey) {
  // HMAC-SHA256 avec une clé dérivée de APP_SECRET : une fuite de la base ne suffit pas à tester des clés hors ligne
  return crypto.createHmac('sha256', deriveKey('team-key')).update(String(rawKey).trim()).digest('hex');
}

function sha256(raw) {
  return crypto.createHash('sha256').update(String(raw)).digest('hex');
}

export function hashPasswordPbkdf2(password, saltHex) {
  const salt = saltHex || crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(String(password), salt, 100000, 64, 'sha256').toString('hex');
  return { salt, hash };
}

function verifyPasswordPbkdf2(password, salt, expectedHash) {
  if (!salt || !expectedHash) return false;
  const computed = crypto.pbkdf2Sync(String(password), salt, 100000, 64, 'sha256');
  const expected = Buffer.from(expectedHash, 'hex');
  if (computed.length !== expected.length) return false;
  return crypto.timingSafeEqual(computed, expected);
}

export function maskKey(k) {
  const s = String(k || '').trim();
  if (s.length <= 8) return '••••••••';
  return `${s.slice(0, 6)}••••${s.slice(-4)}`;
}

export function generateTeamKeyString() {
  const bytes = crypto.randomBytes(8);
  let code = '';
  for (const b of bytes) code += ALPHABET[b % 32];
  return `TW-TEAM-${code.slice(0, 4)}-${code.slice(4, 8)}`;
}

function parseJson(value, fallback) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function toIso(d) {
  if (!d) return null;
  return d instanceof Date ? d.toISOString() : String(d);
}

function mapTeam(row) {
  if (!row) return null;
  return {
    id: row.id,
    nom: row.nom,
    cle_hash: row.cle_hash,
    cle_hint: row.cle_hint,
    event_ids: parseJson(row.event_ids, ['*']),
    actif: Boolean(row.actif),
    cree_le: toIso(row.cree_le),
  };
}

// ── Paramètres clé/valeur ──
async function getSetting(cle, fallback) {
  const { rows } = await pool.query('SELECT valeur FROM platform_settings WHERE cle = ?', [cle]);
  return rows.length ? parseJson(rows[0].valeur, fallback) : fallback;
}

async function setSetting(cle, value) {
  await pool.query(
    'INSERT INTO platform_settings (cle, valeur) VALUES (?, ?) ON DUPLICATE KEY UPDATE valeur = VALUES(valeur)',
    [cle, JSON.stringify(value)]
  );
}

// ── Protection anti-force-brute (persistée en base, partagée entre processus) ──
export async function checkRateLockout(bucketKey) {
  const { rows } = await pool.query('SELECT count, locked_until FROM login_attempts WHERE bucket = ?', [bucketKey]);
  const rec = rows[0];
  if (!rec || !rec.locked_until) return { locked: false };
  const until = new Date(rec.locked_until).getTime();
  if (Date.now() < until) {
    return { locked: true, remainingSec: Math.ceil((until - Date.now()) / 1000) };
  }
  await pool.query('DELETE FROM login_attempts WHERE bucket = ?', [bucketKey]);
  return { locked: false };
}

export async function recordFailedAttempt(bucketKey) {
  await pool.query(
    `INSERT INTO login_attempts (bucket, count, updated_at) VALUES (?, 1, UTC_TIMESTAMP(3))
     ON DUPLICATE KEY UPDATE count = count + 1, updated_at = UTC_TIMESTAMP(3)`,
    [bucketKey]
  );
  const { rows } = await pool.query('SELECT count FROM login_attempts WHERE bucket = ?', [bucketKey]);
  const count = Number(rows[0] && rows[0].count) || 1;
  const locked = count >= MAX_FAILED_ATTEMPTS;
  if (locked) {
    await pool.query('UPDATE login_attempts SET locked_until = ? WHERE bucket = ?', [
      new Date(Date.now() + LOCKOUT_DURATION_MS),
      bucketKey,
    ]);
  }
  return { attemptsLeft: Math.max(0, MAX_FAILED_ATTEMPTS - count), locked };
}

export async function clearFailedAttempts(bucketKey) {
  await pool.query('DELETE FROM login_attempts WHERE bucket = ?', [bucketKey]);
}

// ── Sessions (seul le hash SHA-256 du jeton est stocké) ──
async function createSession({ kind, equipeId = null, agentId = null, ip = null }) {
  const token = crypto.randomBytes(kind === 'founder' ? 32 : 24).toString('hex');
  await pool.query(
    `INSERT INTO admin_sessions (token_hash, kind, equipe_id, agent_id, ip, created_at, last_active_at)
     VALUES (?, ?, ?, ?, ?, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))`,
    [sha256(token), kind, equipeId, agentId, ip ? String(ip).slice(0, 64) : null]
  );
  // Purge opportuniste des sessions expirées
  await pool.query(
    `DELETE FROM admin_sessions
     WHERE (kind = 'founder' AND last_active_at < ?) OR (kind = 'team' AND last_active_at < ?)`,
    [new Date(Date.now() - SESSION_TIMEOUT_MS), new Date(Date.now() - TEAM_SESSION_TIMEOUT_MS)]
  );
  return token;
}

async function touchSession(token, kind, timeoutMs) {
  if (!token) return { valid: false, reason: 'non_connecte' };
  const tokenHash = sha256(token);
  const { rows } = await pool.query(
    'SELECT * FROM admin_sessions WHERE token_hash = ? AND kind = ? LIMIT 1',
    [tokenHash, kind]
  );
  const sess = rows[0];
  if (!sess) return { valid: false, reason: 'non_connecte' };
  if (Date.now() - new Date(sess.last_active_at).getTime() > timeoutMs) {
    await pool.query('DELETE FROM admin_sessions WHERE token_hash = ?', [tokenHash]);
    return { valid: false, reason: 'expiree' };
  }
  await pool.query('UPDATE admin_sessions SET last_active_at = UTC_TIMESTAMP(3) WHERE token_hash = ?', [tokenHash]);
  return { valid: true, session: sess };
}

async function revokeTeamSessions(equipeId) {
  await pool.query(`DELETE FROM admin_sessions WHERE kind = 'team' AND equipe_id = ?`, [equipeId]);
}

// ── Authentification & Gestion des Équipes ──
export async function findTeamByKey(rawKey) {
  if (!rawKey) return null;
  const { rows } = await pool.query('SELECT * FROM equipes WHERE cle_hash = ? LIMIT 1', [hashKeySha256(rawKey)]);
  return mapTeam(rows[0]);
}

export async function findTeamById(equipeId) {
  const { rows } = await pool.query('SELECT * FROM equipes WHERE id = ? LIMIT 1', [equipeId]);
  return mapTeam(rows[0]);
}

export async function listTeams() {
  const { rows } = await pool.query('SELECT * FROM equipes ORDER BY cree_le ASC');
  return rows.map(mapTeam);
}

export async function createTeamSession(equipe, agentId) {
  const cleanAgent = String(agentId || 'Agent Terrain').trim().slice(0, 40) || 'Agent Terrain';
  const token = await createSession({ kind: 'team', equipeId: equipe.id, agentId: cleanAgent });
  return { token, agentId: cleanAgent };
}

export async function resolveTeamAuth(req) {
  const sessionToken = String(req.headers['x-team-token'] || '').trim();
  const rawKey = String(req.headers['x-api-key'] || '').trim();
  const headerAgent = String(req.headers['x-agent-id'] || '').trim().slice(0, 40);

  if (sessionToken) {
    const check = await touchSession(sessionToken, 'team', TEAM_SESSION_TIMEOUT_MS);
    if (check.valid) {
      const eq = await findTeamById(check.session.equipe_id);
      if (eq && eq.actif) {
        return { equipe: eq, agentId: headerAgent || check.session.agent_id || 'Agent Terrain' };
      }
    }
  }
  if (rawKey) {
    const eq = await findTeamByKey(rawKey);
    if (eq && eq.actif) {
      return { equipe: eq, agentId: headerAgent || 'Agent Terrain' };
    }
  }
  return null;
}

function sanitizeEventIds(eventIds) {
  if (!Array.isArray(eventIds) || !eventIds.length) return ['*'];
  const known = new Set(EVENTS.map((e) => e.id));
  const clean = eventIds.map((e) => String(e)).filter((e) => e === '*' || known.has(e));
  return clean.length ? clean : ['*'];
}

export async function createTeam({ nom, eventIds }) {
  const cleanNom = String(nom || '').trim().slice(0, 150);
  if (!cleanNom) throw new Error("Le nom de l'équipe est requis.");
  const plainKey = generateTeamKeyString();
  const team = {
    id: 'team-' + crypto.randomBytes(4).toString('hex'),
    nom: cleanNom,
    cle_hash: hashKeySha256(plainKey),
    cle_hint: maskKey(plainKey),
    event_ids: sanitizeEventIds(eventIds),
    actif: true,
    cree_le: new Date().toISOString(),
  };
  await pool.query(
    'INSERT INTO equipes (id, nom, cle_hash, cle_hint, event_ids, actif, cree_le) VALUES (?, ?, ?, ?, ?, 1, ?)',
    [team.id, team.nom, team.cle_hash, team.cle_hint, JSON.stringify(team.event_ids), new Date(team.cree_le)]
  );
  return { team, plainKey };
}

export async function updateTeam(equipeId, { nom, eventIds, actif }) {
  const team = await findTeamById(equipeId);
  if (!team) return null;
  if (nom !== undefined && String(nom).trim()) team.nom = String(nom).trim().slice(0, 150);
  if (Array.isArray(eventIds) && eventIds.length) team.event_ids = sanitizeEventIds(eventIds);
  if (typeof actif === 'boolean') team.actif = actif;
  await pool.query('UPDATE equipes SET nom = ?, event_ids = ?, actif = ? WHERE id = ?', [
    team.nom, JSON.stringify(team.event_ids), team.actif ? 1 : 0, equipeId,
  ]);
  if (team.actif === false) await revokeTeamSessions(equipeId);
  return team;
}

export async function resetTeamKey(equipeId) {
  const team = await findTeamById(equipeId);
  if (!team) return null;
  const plainKey = generateTeamKeyString();
  team.cle_hash = hashKeySha256(plainKey);
  team.cle_hint = maskKey(plainKey);
  await pool.query('UPDATE equipes SET cle_hash = ?, cle_hint = ? WHERE id = ?', [team.cle_hash, team.cle_hint, equipeId]);
  await revokeTeamSessions(equipeId);
  return { team, plainKey };
}

export async function deleteTeam(equipeId) {
  const { rows } = await pool.query('SELECT COUNT(*) AS cnt FROM equipes');
  if (Number(rows[0].cnt) <= 1) {
    throw new Error('Impossible de supprimer la dernière équipe.');
  }
  const { rowCount } = await pool.query('DELETE FROM equipes WHERE id = ?', [equipeId]);
  if (!rowCount) return false;
  await revokeTeamSessions(equipeId);
  return true;
}

// ── Journalisation des scans & Statistiques Agents (sans données financières) ──
function mapScan(row) {
  return { ...row, scanne_le: toIso(row.scanne_le) };
}

export async function recordScanLog({ reference, passager, eventId, eventNom, resultat, raison, agentId, equipeId, equipeNom }) {
  const entry = {
    id: 'sc-' + Date.now() + '-' + crypto.randomBytes(3).toString('hex'),
    reference: String(reference || '').toUpperCase().slice(0, 64),
    passager: String(passager || '—').slice(0, 255),
    event_id: eventId || null,
    event_nom: String(eventNom || '—').slice(0, 255),
    resultat, // 'valide' | 'deja_utilise' | 'invalide'
    raison: String(raison || '').slice(0, 255),
    agent_id: String(agentId || 'Agent Terrain').slice(0, 64),
    equipe_id: equipeId || 'team-principale',
    equipe_nom: String(equipeNom || 'Équipe Terrain').slice(0, 150),
    scanne_le: new Date().toISOString(),
  };
  await pool.query(
    `INSERT INTO scans_log (id, reference, passager, event_id, event_nom, resultat, raison, agent_id, equipe_id, equipe_nom, scanne_le)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [entry.id, entry.reference, entry.passager, entry.event_id, entry.event_nom, entry.resultat, entry.raison,
      entry.agent_id, entry.equipe_id, entry.equipe_nom, new Date(entry.scanne_le)]
  );
  // Conserver uniquement les 1000 scans les plus récents (comme l'ancien stockage JSON)
  const { rows } = await pool.query(
    `SELECT scanne_le FROM scans_log ORDER BY scanne_le DESC LIMIT 1 OFFSET ${MAX_SCAN_LOGS - 1}`
  );
  if (rows.length) {
    await pool.query('DELETE FROM scans_log WHERE scanne_le < ?', [rows[0].scanne_le]);
  }
  return entry;
}

export async function getRecentScans(limit = 100) {
  const safeLimit = Math.max(1, Math.min(1000, Math.floor(Number(limit) || 100)));
  const { rows } = await pool.query(`SELECT * FROM scans_log ORDER BY scanne_le DESC LIMIT ${safeLimit}`);
  return rows.map(mapScan);
}

export async function getTeamStats(equipeId) {
  const { rows } = await pool.query(
    'SELECT * FROM scans_log WHERE equipe_id = ? ORDER BY scanne_le DESC',
    [equipeId]
  );
  const logs = rows.map(mapScan);
  let valides = 0;
  let dejaUtilises = 0;
  let invalides = 0;
  const agentsMap = new Map();

  for (const l of logs) {
    if (l.resultat === 'valide') valides += 1;
    else if (l.resultat === 'deja_utilise') dejaUtilises += 1;
    else invalides += 1;

    const ag = l.agent_id || 'Agent Terrain';
    if (!agentsMap.has(ag)) {
      agentsMap.set(ag, { agentId: ag, controles: 0, valides: 0, refuses: 0, dernierScan: l.scanne_le });
    }
    const aStat = agentsMap.get(ag);
    aStat.controles += 1;
    if (l.resultat === 'valide') aStat.valides += 1;
    else aStat.refuses += 1;
  }

  return {
    controles: logs.length,
    valides,
    refuses: dejaUtilises + invalides,
    dejaUtilises,
    invalides,
    history: logs.slice(0, 60),
    agents: [...agentsMap.values()],
  };
}

// ── Authentification Fondateur ──
async function getFounderAuth() {
  const auth = await getSetting('founder', null);
  return auth && auth.hash && auth.salt ? auth : null;
}

export async function isFounderConfigured() {
  return Boolean(await getFounderAuth());
}

/** La configuration initiale via l'API n'est autorisée qu'hors production (en prod : FOUNDER_PASSWORD). */
export function isFounderSetupAllowed() {
  return process.env.NODE_ENV !== 'production';
}

export async function setupFounderPassword(newPassword) {
  if (await isFounderConfigured()) {
    throw new Error('Le mot de passe fondateur est déjà configuré.');
  }
  const clean = String(newPassword || '');
  if (clean.length < 8) {
    throw new Error('Le mot de passe fondateur doit contenir au moins 8 caractères.');
  }
  const { salt, hash } = hashPasswordPbkdf2(clean);
  // INSERT (et non upsert) : en cas de requêtes concurrentes, une seule configuration réussit
  const { rowCount } = await pool.query(
    `INSERT IGNORE INTO platform_settings (cle, valeur) VALUES ('founder', ?)`,
    [JSON.stringify({ salt, hash, updatedAt: new Date().toISOString() })]
  );
  if (!rowCount) throw new Error('Le mot de passe fondateur est déjà configuré.');
  return true;
}

export async function verifyFounderPassword(password) {
  const auth = await getFounderAuth();
  if (!auth) return false;
  return verifyPasswordPbkdf2(password, auth.salt, auth.hash);
}

export async function changeFounderPassword(currentPassword, newPassword) {
  if (!(await verifyFounderPassword(currentPassword))) {
    throw new Error('Mot de passe actuel incorrect.');
  }
  if (String(newPassword || '').length < 8) {
    throw new Error('Le nouveau mot de passe doit contenir au moins 8 caractères.');
  }
  const { salt, hash } = hashPasswordPbkdf2(newPassword);
  await setSetting('founder', { salt, hash, updatedAt: new Date().toISOString() });
  return true;
}

export async function createFounderSession(ip) {
  const token = await createSession({ kind: 'founder', ip });
  return { token, timeoutMs: SESSION_TIMEOUT_MS };
}

export async function verifyFounderSessionToken(token) {
  const check = await touchSession(token, 'founder', SESSION_TIMEOUT_MS);
  return check.valid ? { valid: true } : { valid: false, reason: check.reason };
}

export async function revokeFounderSession(token) {
  if (token) await pool.query(`DELETE FROM admin_sessions WHERE token_hash = ? AND kind = 'founder'`, [sha256(token)]);
}

// ── Capacités événements & Dépenses financières ──
async function getCapacities() {
  const capacities = {};
  for (const ev of EVENTS) capacities[ev.id] = 500;
  const { rows } = await pool.query('SELECT event_id, capacite FROM event_capacities');
  for (const r of rows) capacities[r.event_id] = Number(r.capacite) || 500;
  return capacities;
}

async function getExpenses() {
  const { rows } = await pool.query('SELECT * FROM expenses ORDER BY date DESC');
  return rows.map((r) => ({ ...r, montant: Number(r.montant) || 0, date: toIso(r.date) }));
}

export async function getTransactionFeeRate() {
  return Number(await getSetting('frais_taux_pct', 0)) || 0;
}

/** Vue agrégée équivalente à l'ancien état platform.json (sans données d'authentification). */
export async function getPlatformConfig() {
  const [equipes, capacities, expenses, fraisTauxPct, transferConfig] = await Promise.all([
    listTeams(),
    getCapacities(),
    getExpenses(),
    getTransactionFeeRate(),
    getTransferConfig(),
  ]);
  return {
    equipes,
    capacities,
    expenses,
    frais_taux_pct: fraisTauxPct,
    transfer_config: transferConfig,
  };
}

export async function updateEventCapacity(eventId, capacity) {
  if (!EVENTS.some((e) => e.id === eventId)) throw new Error('Événement inconnu.');
  const cap = Math.max(1, Math.min(100000, Math.floor(Number(capacity) || 500)));
  await pool.query(
    'INSERT INTO event_capacities (event_id, capacite) VALUES (?, ?) ON DUPLICATE KEY UPDATE capacite = VALUES(capacite)',
    [eventId, cap]
  );
  return getCapacities();
}

export async function addExpense({ libelle, montant, eventId }) {
  const cleanLib = String(libelle || '').trim().slice(0, 255);
  const amt = Math.max(0, Math.round(Number(montant) || 0));
  if (!cleanLib || amt <= 0) throw new Error('Libellé et montant positif requis.');
  const evId = eventId && EVENTS.some((e) => e.id === eventId) ? eventId : '*';
  await pool.query(
    'INSERT INTO expenses (id, libelle, montant, event_id, date) VALUES (?, ?, ?, ?, UTC_TIMESTAMP(3))',
    ['exp-' + Date.now() + '-' + crypto.randomBytes(3).toString('hex'), cleanLib, amt, evId]
  );
  return getExpenses();
}

export async function deleteExpense(expenseId) {
  await pool.query('DELETE FROM expenses WHERE id = ?', [String(expenseId || '')]);
  return getExpenses();
}

export async function updateTransactionFeeRate(pct) {
  const val = Math.max(0, Math.min(25, Number(pct) || 0));
  await setSetting('frais_taux_pct', val);
  return val;
}

// ── Configuration des transferts de billets par l'administrateur ──
export async function getTransferConfig() {
  const cfg = await getSetting('transfer_config', DEFAULT_TRANSFER_CONFIG);
  return { ...DEFAULT_TRANSFER_CONFIG, ...(cfg || {}) };
}

export async function updateTransferConfig({ enabled, maxTransfersPerTicket, maxTransfersPerUser }) {
  const cur = await getTransferConfig();
  const next = {
    enabled: typeof enabled === 'boolean' ? enabled : cur.enabled,
    maxTransfersPerTicket: maxTransfersPerTicket !== undefined
      ? Math.max(0, Math.min(10, Math.floor(Number(maxTransfersPerTicket) || 0)))
      : cur.maxTransfersPerTicket,
    maxTransfersPerUser: maxTransfersPerUser !== undefined
      ? Math.max(0, Math.min(50, Math.floor(Number(maxTransfersPerUser) || 0)))
      : cur.maxTransfersPerUser,
  };
  await setSetting('transfer_config', next);
  return next;
}
