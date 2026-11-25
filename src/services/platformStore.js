// src/services/platformStore.js — Stockage persistant & sécurité (Équipes, Scans, Fondateur, Capacités, Dépenses)
import crypto from 'node:crypto';
import fs from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EVENTS } from './events.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
function getPlatformDbPath() {
  return join(process.env.TICKWAY_DATA_DIR || join(__dirname, '..', '..', 'data'), 'platform.json');
}

const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const SESSION_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes d'inactivité maximum
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS = 5 * 60 * 1000; // 5 minutes de blocage après 5 échecs

function hashKeySha256(rawKey, salt = 'TICKWAY_TEAM_SALT_2026') {
  return crypto.createHmac('sha256', salt).update(String(rawKey).trim()).digest('hex');
}

function hashPasswordScrypt(password, saltHex) {
  const salt = saltHex || crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(String(password), salt, 100000, 64, 'sha256').toString('hex');
  return { salt, hash };
}

function verifyPasswordScrypt(password, salt, expectedHash) {
  if (!salt || !expectedHash) return false;
  const computed = crypto.pbkdf2Sync(String(password), salt, 100000, 64, 'sha256');
  const expected = Buffer.from(expectedHash, 'hex');
  if (computed.length !== expected.length) return false;
  return crypto.timingSafeEqual(computed, expected);
}

function maskKey(k) {
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

function defaultPlatformState() {
  const defaultTeamKey = (process.env.VALIDATE_API_KEY || 'cle_secrete_equipe_terrain_2026').trim();
  const defaultCapacities = {};
  for (const ev of EVENTS) {
    defaultCapacities[ev.id] = 500;
  }

  // Hash PBKDF2-HMAC-SHA256 (100 000 itérations) du code fondateur configuré (aucun mot de passe en clair)
  let founderAuth = {
    salt: '9f4c8e2a1b7d6035e8a4c1f290b3d7e6',
    hash: '5034e62568b34311e25812a72e8c4730e35f21538ddd6a40af26a5c4c1eb8f62aed0093fce3e658f65168b81b01ed8d4c930f381bfa90f38929e5703666ed231',
    updatedAt: '2026-11-19T23:10:34.000Z',
  };
  if (process.env.FOUNDER_PASSWORD && process.env.FOUNDER_PASSWORD.trim().length >= 8) {
    const { salt, hash } = hashPasswordScrypt(process.env.FOUNDER_PASSWORD.trim());
    founderAuth = { salt, hash, updatedAt: new Date().toISOString() };
  }

  return {
    founder: founderAuth,
    equipes: [
      {
        id: 'team-principale',
        nom: 'Équipe Terrain Principale',
        cle_hash: hashKeySha256(defaultTeamKey),
        cle_hint: maskKey(defaultTeamKey),
        event_ids: ['*'],
        actif: true,
        cree_le: new Date().toISOString(),
      },
    ],
    scans_log: [],
    capacities: defaultCapacities,
    expenses: [],
    frais_taux_pct: 0,
    transfer_config: {
      enabled: true,
      maxTransfersPerTicket: 1,
      maxTransfersPerUser: 5,
    },
  };
}

function loadState() {
  const dbPath = getPlatformDbPath();
  try {
    if (!fs.existsSync(dbPath)) {
      const init = defaultPlatformState();
      saveState(init);
      return init;
    }
    const raw = JSON.parse(fs.readFileSync(dbPath, 'utf8') || '{}');
    const def = defaultPlatformState();
    const rawTc = raw.transfer_config && typeof raw.transfer_config === 'object' ? raw.transfer_config : {};
    return {
      founder: raw.founder || def.founder,
      equipes: Array.isArray(raw.equipes) && raw.equipes.length ? raw.equipes : def.equipes,
      scans_log: Array.isArray(raw.scans_log) ? raw.scans_log : [],
      capacities: { ...def.capacities, ...(raw.capacities || {}) },
      expenses: Array.isArray(raw.expenses) ? raw.expenses : [],
      frais_taux_pct: Number(raw.frais_taux_pct) || 0,
      transfer_config: {
        enabled: rawTc.enabled !== undefined ? Boolean(rawTc.enabled) : true,
        maxTransfersPerTicket: Number.isFinite(Number(rawTc.maxTransfersPerTicket))
          ? Math.max(0, Math.min(10, Math.floor(Number(rawTc.maxTransfersPerTicket))))
          : 1,
        maxTransfersPerUser: Number.isFinite(Number(rawTc.maxTransfersPerUser))
          ? Math.max(0, Math.min(50, Math.floor(Number(rawTc.maxTransfersPerUser))))
          : 5,
      },
    };
  } catch {
    return defaultPlatformState();
  }
}

function saveState(state) {
  const dbPath = getPlatformDbPath();
  fs.mkdirSync(dirname(dbPath), { recursive: true });
  fs.writeFileSync(dbPath, JSON.stringify(state, null, 2), 'utf8');
}

// ── Sessions en mémoire (Équipes & Fondateur) + Protection anti-force-brute ──
const founderSessions = new Map(); // token -> { createdAt, lastActiveAt, ip }
const teamSessions = new Map();    // token -> { equipeId, agentId, createdAt, lastActiveAt }
const loginAttempts = new Map();   // key (ip) -> { count, lockedUntil }

export function checkRateLockout(bucketKey) {
  const rec = loginAttempts.get(bucketKey);
  if (!rec) return { locked: false };
  if (rec.lockedUntil && Date.now() < rec.lockedUntil) {
    const remainingSec = Math.ceil((rec.lockedUntil - Date.now()) / 1000);
    return { locked: true, remainingSec };
  }
  if (rec.lockedUntil && Date.now() >= rec.lockedUntil) {
    loginAttempts.delete(bucketKey);
  }
  return { locked: false };
}

export function recordFailedAttempt(bucketKey) {
  const rec = loginAttempts.get(bucketKey) || { count: 0, lockedUntil: 0 };
  rec.count += 1;
  if (rec.count >= MAX_FAILED_ATTEMPTS) {
    rec.lockedUntil = Date.now() + LOCKOUT_DURATION_MS;
  }
  loginAttempts.set(bucketKey, rec);
  return {
    attemptsLeft: Math.max(0, MAX_FAILED_ATTEMPTS - rec.count),
    locked: rec.count >= MAX_FAILED_ATTEMPTS,
  };
}

export function clearFailedAttempts(bucketKey) {
  loginAttempts.delete(bucketKey);
}

// ── Authentification & Gestion des Équipes ──
export function findTeamByKey(rawKey) {
  if (!rawKey) return null;
  const targetHash = hashKeySha256(rawKey);
  const bTarget = Buffer.from(targetHash, 'hex');
  const state = loadState();
  for (const eq of state.equipes) {
    if (!eq.cle_hash) continue;
    const bEq = Buffer.from(eq.cle_hash, 'hex');
    if (bEq.length === bTarget.length && crypto.timingSafeEqual(bEq, bTarget)) {
      return eq;
    }
  }
  return null;
}

export function findTeamById(equipeId) {
  const state = loadState();
  return state.equipes.find((e) => e.id === equipeId) || null;
}

export function createTeamSession(equipe, agentId) {
  const token = crypto.randomBytes(24).toString('hex');
  const cleanAgent = String(agentId || 'Agent Terrain').trim().slice(0, 40) || 'Agent Terrain';
  teamSessions.set(token, {
    equipeId: equipe.id,
    agentId: cleanAgent,
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
  });
  return { token, agentId: cleanAgent };
}

export function resolveTeamAuth(req) {
  const sessionToken = String(req.headers['x-team-token'] || '').trim();
  const rawKey = String(req.headers['x-api-key'] || '').trim();
  const headerAgent = String(req.headers['x-agent-id'] || '').trim();

  if (sessionToken && teamSessions.has(sessionToken)) {
    const sess = teamSessions.get(sessionToken);
    const eq = findTeamById(sess.equipeId);
    if (eq && eq.actif) {
      sess.lastActiveAt = Date.now();
      return { equipe: eq, agentId: headerAgent || sess.agentId || 'Agent Terrain' };
    }
  }
  if (rawKey) {
    const eq = findTeamByKey(rawKey);
    if (eq && eq.actif) {
      return { equipe: eq, agentId: headerAgent || 'Agent Terrain' };
    }
  }
  return null;
}

export function createTeam({ nom, eventIds }) {
  const state = loadState();
  const cleanNom = String(nom || '').trim();
  if (!cleanNom) throw new Error("Le nom de l'équipe est requis.");
  const plainKey = generateTeamKeyString();
  const assigned = Array.isArray(eventIds) && eventIds.length ? eventIds : ['*'];
  const team = {
    id: 'team-' + crypto.randomBytes(4).toString('hex'),
    nom: cleanNom,
    cle_hash: hashKeySha256(plainKey),
    cle_hint: maskKey(plainKey),
    event_ids: assigned,
    actif: true,
    cree_le: new Date().toISOString(),
  };
  state.equipes.push(team);
  saveState(state);
  return { team, plainKey };
}

export function updateTeam(equipeId, { nom, eventIds, actif }) {
  const state = loadState();
  const team = state.equipes.find((e) => e.id === equipeId);
  if (!team) return null;
  if (nom !== undefined && String(nom).trim()) team.nom = String(nom).trim();
  if (Array.isArray(eventIds) && eventIds.length) team.event_ids = eventIds;
  if (typeof actif === 'boolean') {
    team.actif = actif;
    if (!actif) {
      for (const [tok, sess] of teamSessions.entries()) {
        if (sess.equipeId === equipeId) teamSessions.delete(tok);
      }
    }
  }
  saveState(state);
  return team;
}

export function resetTeamKey(equipeId) {
  const state = loadState();
  const team = state.equipes.find((e) => e.id === equipeId);
  if (!team) return null;
  const plainKey = generateTeamKeyString();
  team.cle_hash = hashKeySha256(plainKey);
  team.cle_hint = maskKey(plainKey);
  for (const [tok, sess] of teamSessions.entries()) {
    if (sess.equipeId === equipeId) teamSessions.delete(tok);
  }
  saveState(state);
  return { team, plainKey };
}

export function deleteTeam(equipeId) {
  const state = loadState();
  if (state.equipes.length <= 1) {
    throw new Error('Impossible de supprimer la dernière équipe.');
  }
  const idx = state.equipes.findIndex((e) => e.id === equipeId);
  if (idx < 0) return false;
  state.equipes.splice(idx, 1);
  for (const [tok, sess] of teamSessions.entries()) {
    if (sess.equipeId === equipeId) teamSessions.delete(tok);
  }
  saveState(state);
  return true;
}

// ── Journalisation des scans & Statistiques Agents (sans données financières) ──
export function recordScanLog({ reference, passager, eventId, eventNom, resultat, raison, agentId, equipeId, equipeNom }) {
  const state = loadState();
  const entry = {
    id: 'sc-' + Date.now() + '-' + crypto.randomBytes(2).toString('hex'),
    reference: String(reference || '').toUpperCase(),
    passager: passager || '—',
    event_id: eventId || null,
    event_nom: eventNom || '—',
    resultat, // 'valide' | 'deja_utilise' | 'invalide'
    raison: raison || '',
    agent_id: agentId || 'Agent Terrain',
    equipe_id: equipeId || 'team-principale',
    equipe_nom: equipeNom || 'Équipe Terrain',
    scanne_le: new Date().toISOString(),
  };
  state.scans_log.unshift(entry);
  if (state.scans_log.length > 1000) state.scans_log.length = 1000;
  saveState(state);
  return entry;
}

export function getTeamStats(equipeId) {
  const state = loadState();
  const logs = state.scans_log.filter((l) => l.equipe_id === equipeId);
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
export function isFounderConfigured() {
  const state = loadState();
  return !!(state.founder && state.founder.hash && state.founder.salt);
}

export function setupFounderPassword(newPassword) {
  const state = loadState();
  if (state.founder && state.founder.hash) {
    throw new Error('Le mot de passe fondateur est déjà configuré.');
  }
  const clean = String(newPassword || '');
  if (clean.length < 8) {
    throw new Error('Le mot de passe fondateur doit contenir au moins 8 caractères.');
  }
  const { salt, hash } = hashPasswordScrypt(clean);
  state.founder = { salt, hash, updatedAt: new Date().toISOString() };
  saveState(state);
  return true;
}

export function verifyFounderPassword(password) {
  const state = loadState();
  if (!state.founder || !state.founder.hash || !state.founder.salt) return false;
  return verifyPasswordScrypt(password, state.founder.salt, state.founder.hash);
}

export function changeFounderPassword(currentPassword, newPassword) {
  if (!verifyFounderPassword(currentPassword)) {
    throw new Error('Mot de passe actuel incorrect.');
  }
  if (String(newPassword || '').length < 8) {
    throw new Error('Le nouveau mot de passe doit contenir au moins 8 caractères.');
  }
  const state = loadState();
  const { salt, hash } = hashPasswordScrypt(newPassword);
  state.founder = { salt, hash, updatedAt: new Date().toISOString() };
  saveState(state);
  return true;
}

export function createFounderSession(ip) {
  const token = crypto.randomBytes(32).toString('hex');
  founderSessions.set(token, {
    ip,
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
  });
  return { token, timeoutMs: SESSION_TIMEOUT_MS };
}

export function verifyFounderSessionToken(token) {
  if (!token || !founderSessions.has(token)) return { valid: false, reason: 'non_connecte' };
  const sess = founderSessions.get(token);
  if (Date.now() - sess.lastActiveAt > SESSION_TIMEOUT_MS) {
    founderSessions.delete(token);
    return { valid: false, reason: 'expiree' };
  }
  sess.lastActiveAt = Date.now();
  return { valid: true };
}

export function revokeFounderSession(token) {
  if (token) founderSessions.delete(token);
}

// ── Capacités événements & Dépenses financières ──
export function getPlatformConfig() {
  return loadState();
}

export function updateEventCapacity(eventId, capacity) {
  const state = loadState();
  const cap = Math.max(1, Math.floor(Number(capacity) || 500));
  state.capacities[eventId] = cap;
  saveState(state);
  return state.capacities;
}

export function addExpense({ libelle, montant, eventId }) {
  const state = loadState();
  const cleanLib = String(libelle || '').trim();
  const amt = Math.max(0, Math.round(Number(montant) || 0));
  if (!cleanLib || amt <= 0) throw new Error('Libellé et montant positif requis.');
  const exp = {
    id: 'exp-' + Date.now() + '-' + crypto.randomBytes(2).toString('hex'),
    libelle: cleanLib,
    montant: amt,
    event_id: eventId || '*',
    date: new Date().toISOString(),
  };
  state.expenses.unshift(exp);
  saveState(state);
  return state.expenses;
}

export function deleteExpense(expenseId) {
  const state = loadState();
  state.expenses = state.expenses.filter((e) => e.id !== expenseId);
  saveState(state);
  return state.expenses;
}

export function updateTransactionFeeRate(pct) {
  const state = loadState();
  state.frais_taux_pct = Math.max(0, Math.min(25, Number(pct) || 0));
  saveState(state);
  return state.frais_taux_pct;
}

// ── Configuration des transferts de billets par l'administrateur ──
export function getTransferConfig() {
  const state = loadState();
  return state.transfer_config || { enabled: true, maxTransfersPerTicket: 1, maxTransfersPerUser: 5 };
}

export function updateTransferConfig({ enabled, maxTransfersPerTicket, maxTransfersPerUser }) {
  const state = loadState();
  const cur = state.transfer_config || { enabled: true, maxTransfersPerTicket: 1, maxTransfersPerUser: 5 };
  state.transfer_config = {
    enabled: typeof enabled === 'boolean' ? enabled : cur.enabled,
    maxTransfersPerTicket: maxTransfersPerTicket !== undefined
      ? Math.max(0, Math.min(10, Math.floor(Number(maxTransfersPerTicket) || 0)))
      : cur.maxTransfersPerTicket,
    maxTransfersPerUser: maxTransfersPerUser !== undefined
      ? Math.max(0, Math.min(50, Math.floor(Number(maxTransfersPerUser) || 0)))
      : cur.maxTransfersPerUser,
  };
  saveState(state);
  return state.transfer_config;
}
