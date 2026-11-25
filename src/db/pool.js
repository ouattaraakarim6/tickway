// src/db/pool.js — Pool PostgreSQL avec bascule automatique sur fichier JSON local (data/reservations.json)
import pg from 'pg';
import fs from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const { Pool } = pg;
const __dirname = dirname(fileURLToPath(import.meta.url));
function resolveJsonDbPath() {
  return join(process.env.TICKWAY_DATA_DIR || join(__dirname, '..', '..', 'data'), 'reservations.json');
}

const dbUrl = process.env.DATABASE_URL || '';
const isPlaceholderUrl = !dbUrl || dbUrl.includes('user:password@localhost');

let pgPool = null;
if (!isPlaceholderUrl) {
  const needsSsl = dbUrl.includes('render.com') || process.env.NODE_ENV === 'production' || process.env.PGSSLMODE === 'require';
  pgPool = new Pool({
    connectionString: dbUrl,
    ssl: needsSsl ? { rejectUnauthorized: false } : undefined,
  });
  pgPool.on('error', (err) => {
    console.error('[DB] Erreur inattendue sur le pool PostgreSQL :', err.message);
  });
}

function loadJsonDb() {
  const dbPath = resolveJsonDbPath();
  try {
    if (!fs.existsSync(dbPath)) {
      fs.mkdirSync(dirname(dbPath), { recursive: true });
      fs.writeFileSync(dbPath, JSON.stringify({}, null, 2), 'utf8');
      return {};
    }
    return JSON.parse(fs.readFileSync(dbPath, 'utf8') || '{}');
  } catch {
    return {};
  }
}

function saveJsonDb(db) {
  const dbPath = resolveJsonDbPath();
  fs.mkdirSync(dirname(dbPath), { recursive: true });
  fs.writeFileSync(dbPath, JSON.stringify(db, null, 2), 'utf8');
}

// Verrou mémoire pour garantir l'atomicité stricte des validations, transferts et écritures concurrentes en mode JSON
let validationLock = Promise.resolve();

function withLock(fn) {
  const run = () => Promise.resolve().then(fn);
  validationLock = validationLock.then(run, run);
  return validationLock;
}

function getJsonDataDir() {
  return dirname(resolveJsonDbPath());
}

function resolvePaymentsJsonPath() {
  return join(getJsonDataDir(), 'payments.json');
}

function loadPaymentsJson() {
  const p = resolvePaymentsJsonPath();
  try {
    if (!fs.existsSync(p)) {
      fs.mkdirSync(dirname(p), { recursive: true });
      fs.writeFileSync(p, JSON.stringify({}, null, 2), 'utf8');
      return {};
    }
    return JSON.parse(fs.readFileSync(p, 'utf8') || '{}');
  } catch {
    return {};
  }
}

function savePaymentsJson(data) {
  const p = resolvePaymentsJsonPath();
  fs.mkdirSync(dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf8');
}

function runJsonQuery(sql, params = []) {
  const q = sql.replace(/\s+/g, ' ').trim().toUpperCase();
  const db = loadJsonDb();

  // 0. DDL (CREATE / ALTER / INDEX)
  if (q.startsWith('CREATE ') || q.startsWith('ALTER ')) {
    return { rows: [], rowCount: 0 };
  }

  // 1. Vérification d'existence (SELECT 1 FROM reservations WHERE reference = $1)
  if (q.startsWith('SELECT 1 FROM RESERVATIONS')) {
    const ref = params[0];
    return { rows: db[ref] ? [{ '?column?': 1 }] : [], rowCount: db[ref] ? 1 : 0 };
  }

  // 2. Insertion (INSERT INTO reservations ...)
  if (q.startsWith('INSERT INTO RESERVATIONS')) {
    const [
      reference, commande_id, user_id, prenom, nom, telephone, email, localite, categorie,
      event_id, event_nom, event_date, zone, point_relais, montant, mode_paiement,
      quantite, statut, frais_transaction, qr_text, guest_access_hash,
    ] = params;
    const nowIso = new Date().toISOString();
    db[reference] = {
      reference,
      commande_id: commande_id || reference,
      user_id: user_id || null,
      prenom,
      nom,
      telephone,
      email,
      localite: (localite && String(localite).trim()) || 'Localité non renseignée',
      categorie: (categorie && String(categorie).trim()) || 'Standard Navette',
      event_id,
      event_nom,
      event_date,
      zone,
      point_relais,
      montant: Number(montant) || 6000,
      frais_transaction: Number(frais_transaction) || 0,
      mode_paiement,
      quantite: Number(quantite) || 1,
      statut: statut || 'valide',
      qr_text: qr_text || null,
      guest_access_hash: guest_access_hash || null,
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
    saveJsonDb(db);
    return { rows: [db[reference]], rowCount: 1 };
  }

  // 3. Validation atomique (UPDATE reservations SET statut = 'utilise' ...)
  if (q.startsWith('UPDATE RESERVATIONS') && q.includes("SET STATUT = 'UTILISE'")) {
    const ref = params[0];
    const agentId = params[1] || null;
    const equipeId = params[2] || null;
    const equipeNom = params[3] || null;
    const row = db[ref];
    if (row && row.statut === 'valide') {
      row.statut = 'utilise';
      row.utilise_le = new Date().toISOString();
      row.agent_id = agentId;
      row.equipe_id = equipeId;
      row.equipe_nom = equipeNom;
      saveJsonDb(db);
      return { rows: [row], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }

  // 3b. Mise à jour statut par référence (dashboard fondateur)
  if (q.startsWith('UPDATE RESERVATIONS') && q.includes('SET STATUT = $2 WHERE REFERENCE = $1')) {
    const [ref, nextStatus] = params;
    const row = db[ref];
    if (!row) return { rows: [], rowCount: 0 };
    row.statut = nextStatus;
    saveJsonDb(db);
    return { rows: [row], rowCount: 1 };
  }

  // 4. Lecture d'une réservation par référence
  if (q.startsWith('SELECT') && q.includes('FROM RESERVATIONS WHERE REFERENCE = $1')) {
    const ref = params[0];
    const row = db[ref];
    return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
  }

  // 4b. Lecture des réservations d'un utilisateur authentifié (ID unique ou liste [supabaseId, legacyId])
  if (q.startsWith('SELECT') && q.includes('FROM RESERVATIONS WHERE USER_ID = ANY($1::TEXT[])')) {
    const ids = Array.isArray(params[0]) ? params[0].filter(Boolean) : [params[0]].filter(Boolean);
    const rows = Object.values(db)
      .filter((r) => ids.includes(r.user_id))
      .sort((a, b) => String(b.cree_le || '').localeCompare(String(a.cree_le || '')));
    return { rows, rowCount: rows.length };
  }

  if (q.startsWith('SELECT') && q.includes('FROM RESERVATIONS WHERE USER_ID = $1')) {
    const userId = params[0];
    const rows = Object.values(db)
      .filter((r) => r.user_id === userId)
      .sort((a, b) => String(b.cree_le || '').localeCompare(String(a.cree_le || '')));
    return { rows, rowCount: rows.length };
  }

  // 4c. Lecture par commande_id
  if (q.startsWith('SELECT') && q.includes('FROM RESERVATIONS WHERE COMMANDE_ID = $1')) {
    const cmdId = params[0];
    const rows = Object.values(db)
      .filter((r) => r.commande_id === cmdId)
      .sort((a, b) => String(a.reference || '').localeCompare(String(b.reference || '')));
    return { rows, rowCount: rows.length };
  }

  // 4d. Lecture par lien d'accès invité (guest_access_hash)
  if (q.startsWith('SELECT') && q.includes('FROM RESERVATIONS WHERE GUEST_ACCESS_HASH = $1')) {
    const accessHash = params[0];
    const rows = Object.values(db)
      .filter((r) => r.guest_access_hash && r.guest_access_hash === accessHash)
      .sort((a, b) => String(a.cree_le || '').localeCompare(String(b.cree_le || '')));
    return { rows, rowCount: rows.length };
  }

  // 5. Lecture de toutes les réservations (pour le dashboard fondateur)
  if (q.startsWith('SELECT') && q.includes('FROM RESERVATIONS')) {
    const rows = Object.values(db).sort((a, b) =>
      String(b.cree_le || '').localeCompare(String(a.cree_le || ''))
    );
    return { rows, rowCount: rows.length };
  }

  return { rows: [], rowCount: 0 };
}

const pool = {
  hasPostgres() {
    return Boolean(pgPool);
  },
  getJsonDataDir,
  loadReservationsJson: loadJsonDb,
  saveReservationsJson: saveJsonDb,
  loadPaymentsJson,
  savePaymentsJson,
  withLock,
  async exec(pgSql, pgParams, jsonHandler) {
    if (pgPool) {
      try {
        return await pgPool.query(pgSql, pgParams);
      } catch (err) {
        if (err && err.status) throw err;
        console.warn('[DB] PostgreSQL indisponible, bascule sur la base locale JSON :', err.message);
      }
    }
    return withLock(() => jsonHandler());
  },
  async withTransaction(pgCallback, jsonCallback) {
    if (pgPool) {
      let client;
      try {
        client = await pgPool.connect();
      } catch (connErr) {
        console.warn('[DB] PostgreSQL indisponible pour transaction, bascule JSON :', connErr.message);
        return withLock(() => jsonCallback());
      }
      try {
        await client.query('BEGIN');
        const res = await pgCallback(client);
        await client.query('COMMIT');
        return res;
      } catch (txErr) {
        try { await client.query('ROLLBACK'); } catch { }
        throw txErr;
      } finally {
        client.release();
      }
    }
    return withLock(() => jsonCallback());
  },
  async query(sql, params) {
    if (pgPool) {
      try {
        return await pgPool.query(sql, params);
      } catch (err) {
        console.warn('[DB] PostgreSQL indisponible, bascule sur la base locale JSON :', err.message);
      }
    }
    // Sérialiser les écritures via validationLock pour empêcher tout double scan concurrent
    return withLock(() => runJsonQuery(sql, params));
  },
  async end() {
    if (pgPool) {
      await pgPool.end();
    }
  },
};

export { loadJsonDb as loadReservationsJson, saveJsonDb as saveReservationsJson, loadPaymentsJson, savePaymentsJson, withLock, getJsonDataDir };
export default pool;
