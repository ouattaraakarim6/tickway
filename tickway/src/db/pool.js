// src/db/pool.js — Pool PostgreSQL avec bascule automatique sur fichier JSON local (si PostgreSQL non installé)
import pg from 'pg';
import fs from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const { Pool } = pg;
const __dirname = dirname(fileURLToPath(import.meta.url));
const JSON_DB_PATH = join(__dirname, '..', '..', 'data', 'reservations.json');

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
  try {
    if (!fs.existsSync(JSON_DB_PATH)) {
      fs.mkdirSync(dirname(JSON_DB_PATH), { recursive: true });
      const seed = {
        'TW-9KGY-RDUC': {
          reference: 'TW-9KGY-RDUC',
          prenom: 'Karim',
          nom: 'Ouattara',
          telephone: '0700000000',
          email: 'ouattaraakarim6@gmail.com',
          event_id: 'k',
          event_nom: 'Kiff No Beat',
          event_date: 'Sam. 21 novembre 2026, 19 h 00',
          zone: 'Abidjan Nord',
          point_relais: 'Yopougon, Cosmos',
          montant: 6000,
          mode_paiement: 'Wave',
          quantite: 1,
          statut: 'valide',
          cree_le: new Date().toISOString(),
          utilise_le: null,
        },
      };
      fs.writeFileSync(JSON_DB_PATH, JSON.stringify(seed, null, 2), 'utf8');
      return seed;
    }
    return JSON.parse(fs.readFileSync(JSON_DB_PATH, 'utf8') || '{}');
  } catch {
    return {};
  }
}

function saveJsonDb(db) {
  fs.mkdirSync(dirname(JSON_DB_PATH), { recursive: true });
  fs.writeFileSync(JSON_DB_PATH, JSON.stringify(db, null, 2), 'utf8');
}

function runJsonQuery(sql, params = []) {
  const q = sql.replace(/\s+/g, ' ').trim().toUpperCase();
  const db = loadJsonDb();

  // 1. Vérification d'existence (SELECT 1 FROM reservations WHERE reference = $1)
  if (q.startsWith('SELECT 1 FROM RESERVATIONS')) {
    const ref = params[0];
    return { rows: db[ref] ? [{ '?column?': 1 }] : [], rowCount: db[ref] ? 1 : 0 };
  }

  // 2. Insertion (INSERT INTO reservations ...)
  if (q.startsWith('INSERT INTO RESERVATIONS')) {
    const [
      reference, prenom, nom, telephone, email,
      event_id, event_nom, event_date,
      zone, point_relais, montant, mode_paiement, quantite,
    ] = params;
    db[reference] = {
      reference, prenom, nom, telephone, email,
      event_id, event_nom, event_date,
      zone, point_relais, montant, mode_paiement,
      quantite: quantite || 1,
      statut: 'valide',
      cree_le: new Date().toISOString(),
      utilise_le: null,
    };
    saveJsonDb(db);
    return { rows: [db[reference]], rowCount: 1 };
  }

  // 3. Validation atomique (UPDATE reservations SET statut = 'utilise' ...)
  if (q.startsWith('UPDATE RESERVATIONS')) {
    const ref = params[0];
    const row = db[ref];
    if (row && row.statut === 'valide') {
      row.statut = 'utilise';
      row.utilise_le = new Date().toISOString();
      saveJsonDb(db);
      return { rows: [row], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }

  // 4. Lecture d'une réservation (SELECT ... FROM reservations WHERE reference = $1)
  if (q.startsWith('SELECT') && q.includes('FROM RESERVATIONS WHERE REFERENCE = $1')) {
    const ref = params[0];
    const row = db[ref];
    return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
  }

  return { rows: [], rowCount: 0 };
}

const pool = {
  async query(sql, params) {
    if (pgPool) {
      try {
        return await pgPool.query(sql, params);
      } catch (err) {
        console.warn('[DB] PostgreSQL indisponible, bascule sur la base locale JSON :', err.message);
      }
    }
    return runJsonQuery(sql, params);
  },
  async end() {
    if (pgPool) {
      await pgPool.end();
    }
  },
};

export default pool;
