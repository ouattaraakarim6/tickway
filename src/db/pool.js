// src/db/pool.js — Pool MySQL unique (Laragon en local). MySQL est l'unique source de vérité.
import mysql from 'mysql2/promise';

const DEFAULT_URL = 'mysql://root:@127.0.0.1:3306/tickway';

export function getDatabaseUrl() {
  return String(process.env.DATABASE_URL || DEFAULT_URL).trim();
}

export function getDatabaseName() {
  const name = new URL(getDatabaseUrl()).pathname.replace(/^\//, '');
  if (!/^[A-Za-z0-9_]+$/.test(name)) {
    throw new Error(`Nom de base invalide dans DATABASE_URL : "${name}"`);
  }
  return name;
}

const BASE_OPTIONS = {
  timezone: 'Z',             // toutes les dates sont stockées et relues en UTC
  charset: 'utf8mb4',
  dateStrings: false,
  decimalNumbers: true,
  supportBigNumbers: true,
  bigNumberStrings: false,
  multipleStatements: false, // empêche l'empilement de requêtes (défense anti-injection)
  connectionLimit: 10,
  waitForConnections: true,
};

let mysqlPool = null;
function getPool() {
  if (!mysqlPool) {
    mysqlPool = mysql.createPool({ uri: getDatabaseUrl(), ...BASE_OPTIONS });
  }
  return mysqlPool;
}

/**
 * Convertit les placeholders positionnels style PostgreSQL ($1, $2, … éventuellement répétés)
 * en placeholders MySQL "?" et réordonne les paramètres en conséquence.
 */
export function toMysql(sql, params = []) {
  if (!/\$\d+/.test(sql)) return { sql, params };
  const ordered = [];
  const out = sql.replace(/\$(\d+)/g, (_, n) => {
    const idx = Number(n) - 1;
    if (idx < 0 || idx >= params.length) {
      throw new Error(`Paramètre SQL $${n} manquant.`);
    }
    ordered.push(params[idx]);
    return '?';
  });
  return { sql: out, params: ordered };
}

function normalizeResult([result]) {
  if (Array.isArray(result)) {
    return { rows: result, rowCount: result.length };
  }
  return {
    rows: [],
    rowCount: result.affectedRows || 0,
    insertId: result.insertId,
    changedRows: result.changedRows,
  };
}

async function runQuery(executor, sql, params = []) {
  const q = toMysql(sql, params);
  return normalizeResult(await executor.query(q.sql, q.params));
}

function wrapDbError(err) {
  if (err && ['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'PROTOCOL_CONNECTION_LOST'].includes(err.code)) {
    const wrapped = new Error('Base MySQL injoignable : démarrez MySQL dans Laragon puis relancez le serveur.');
    wrapped.cause = err;
    wrapped.code = 'DB_UNAVAILABLE';
    return wrapped;
  }
  return err;
}

const pool = {
  async query(sql, params) {
    try {
      return await runQuery(getPool(), sql, params);
    } catch (err) {
      throw wrapDbError(err);
    }
  },

  /** Exécute le callback dans une transaction ; client.query a la même signature que pool.query. */
  async withTransaction(callback) {
    let conn;
    try {
      conn = await getPool().getConnection();
    } catch (err) {
      throw wrapDbError(err);
    }
    const client = { query: (sql, params) => runQuery(conn, sql, params) };
    try {
      await conn.beginTransaction();
      const res = await callback(client);
      await conn.commit();
      return res;
    } catch (err) {
      try { await conn.rollback(); } catch { /* ignore */ }
      throw err;
    } finally {
      conn.release();
    }
  },

  async end() {
    if (mysqlPool) {
      await mysqlPool.end();
      mysqlPool = null;
    }
  },
};

/** Connexion ponctuelle sans base sélectionnée (création de la base au premier lancement). */
export async function createServerConnection() {
  const url = new URL(getDatabaseUrl());
  url.pathname = '/';
  const { connectionLimit, waitForConnections, ...connOptions } = BASE_OPTIONS;
  return mysql.createConnection({ uri: url.toString(), ...connOptions });
}

export default pool;
