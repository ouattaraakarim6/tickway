// src/db/init.js — Crée la base et les tables TickWay (MySQL 8 / MariaDB 10.5+), idempotent.
import 'dotenv/config';
import pool, { createServerConnection, getDatabaseName } from './pool.js';
import { EVENTS } from '../services/events.js';
import { assertSecretsConfigured } from '../services/secrets.js';

const TABLE_OPTS = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci';

export const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS reservations (
    reference          VARCHAR(32)  NOT NULL PRIMARY KEY,
    commande_id        VARCHAR(32)  NULL,
    user_id            VARCHAR(64)  NULL,
    prenom             VARCHAR(100) NOT NULL,
    nom                VARCHAR(150) NOT NULL,
    telephone          VARCHAR(40)  NOT NULL,
    email              VARCHAR(255) NOT NULL,
    localite           VARCHAR(150) NOT NULL DEFAULT 'Localité non renseignée',
    categorie          VARCHAR(100) NOT NULL DEFAULT 'Standard Navette',
    event_id           VARCHAR(32)  NOT NULL,
    event_nom          VARCHAR(255) NOT NULL,
    event_date         VARCHAR(100) NOT NULL,
    zone               VARCHAR(100) NOT NULL,
    point_relais       VARCHAR(255) NOT NULL,
    montant            INT          NOT NULL,
    frais_transaction  INT          NOT NULL DEFAULT 0,
    mode_paiement      VARCHAR(100) NOT NULL,
    quantite           INT          NOT NULL DEFAULT 1,
    statut             VARCHAR(20)  NOT NULL DEFAULT 'valide',
    qr_text            TEXT         NULL,
    guest_access_hash  CHAR(64)     NULL,
    transfer_count     INT          NOT NULL DEFAULT 0,
    transferred_from   VARCHAR(32)  NULL,
    transferred_to     VARCHAR(32)  NULL,
    transferred_at     DATETIME(3)  NULL,
    cree_le            DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    utilise_le         DATETIME(3)  NULL,
    agent_id           VARCHAR(64)  NULL,
    equipe_id          VARCHAR(64)  NULL,
    equipe_nom         VARCHAR(150) NULL,
    CONSTRAINT chk_reservations_quantite CHECK (quantite BETWEEN 1 AND 5),
    CONSTRAINT chk_reservations_statut CHECK (statut IN ('valide', 'en_attente', 'utilise', 'annule', 'transfere')),
    INDEX idx_reservations_statut (statut),
    INDEX idx_reservations_email (email),
    INDEX idx_reservations_user_id (user_id),
    INDEX idx_reservations_event_id (event_id),
    INDEX idx_reservations_commande_id (commande_id),
    INDEX idx_reservations_guest_access (guest_access_hash),
    INDEX idx_reservations_cree_le (cree_le)
  ) ${TABLE_OPTS}`,

  `CREATE TABLE IF NOT EXISTS payment_transactions (
    commande_id          VARCHAR(32)  NOT NULL PRIMARY KEY,
    provider             VARCHAR(32)  NOT NULL DEFAULT 'paysecurehub',
    code_paiement        VARCHAR(64)  NOT NULL,
    provider_token       TEXT         NULL,
    payment_url          TEXT         NULL,
    transaction_ref      VARCHAR(128) NULL,
    pm_id                VARCHAR(64)  NULL,
    provider_service     VARCHAR(100) NULL,
    amount               INT          NOT NULL,
    fees                 INT          NOT NULL DEFAULT 0,
    currency             VARCHAR(8)   NOT NULL DEFAULT 'XOF',
    statut               VARCHAR(20)  NOT NULL DEFAULT 'en_attente',
    email_sent           TINYINT(1)   NOT NULL DEFAULT 0,
    access_token_enc     TEXT         NULL,
    last_webhook_payload LONGTEXT     NULL,
    last_status_payload  LONGTEXT     NULL,
    paid_at              DATETIME(3)  NULL,
    created_at           DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at           DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    UNIQUE KEY uq_payment_code (code_paiement),
    CONSTRAINT chk_payment_statut CHECK (statut IN ('en_attente', 'paye', 'echoue', 'annule')),
    INDEX idx_payment_tx_statut (statut)
  ) ${TABLE_OPTS}`,

  `CREATE TABLE IF NOT EXISTS ticket_transfers (
    id                      VARCHAR(64)  NOT NULL PRIMARY KEY,
    old_reference           VARCHAR(32)  NOT NULL,
    new_reference           VARCHAR(32)  NOT NULL,
    commande_id             VARCHAR(32)  NULL,
    event_id                VARCHAR(32)  NOT NULL,
    event_nom               VARCHAR(255) NOT NULL,
    event_date              VARCHAR(100) NOT NULL,
    categorie               VARCHAR(100) NOT NULL DEFAULT 'Standard Navette',
    from_user_id            VARCHAR(64)  NOT NULL,
    from_name               VARCHAR(255) NOT NULL,
    from_email              VARCHAR(255) NOT NULL,
    to_user_id              VARCHAR(64)  NULL,
    to_name                 VARCHAR(255) NULL,
    to_email                VARCHAR(255) NOT NULL,
    access_token_hash       CHAR(64)     NULL,
    pending_recipient_claim TINYINT(1)   NOT NULL DEFAULT 0,
    statut                  VARCHAR(20)  NOT NULL DEFAULT 'complete',
    created_at              DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    claimed_at              DATETIME(3)  NULL,
    UNIQUE KEY uq_transfers_new_ref (new_reference),
    CONSTRAINT chk_transfers_statut CHECK (statut IN ('complete', 'en_attente_compte', 'reclame', 'annule')),
    INDEX idx_ticket_transfers_old_ref (old_reference),
    INDEX idx_ticket_transfers_created (created_at)
  ) ${TABLE_OPTS}`,

  `CREATE TABLE IF NOT EXISTS equipes (
    id        VARCHAR(64)  NOT NULL PRIMARY KEY,
    nom       VARCHAR(150) NOT NULL,
    cle_hash  CHAR(64)     NOT NULL,
    cle_hint  VARCHAR(40)  NOT NULL,
    event_ids LONGTEXT     NOT NULL,
    actif     TINYINT(1)   NOT NULL DEFAULT 1,
    cree_le   DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    UNIQUE KEY uq_equipes_cle_hash (cle_hash)
  ) ${TABLE_OPTS}`,

  `CREATE TABLE IF NOT EXISTS scans_log (
    id         VARCHAR(64)  NOT NULL PRIMARY KEY,
    reference  VARCHAR(64)  NOT NULL,
    passager   VARCHAR(255) NOT NULL DEFAULT '—',
    event_id   VARCHAR(32)  NULL,
    event_nom  VARCHAR(255) NOT NULL DEFAULT '—',
    resultat   VARCHAR(20)  NOT NULL,
    raison     VARCHAR(255) NOT NULL DEFAULT '',
    agent_id   VARCHAR(64)  NOT NULL,
    equipe_id  VARCHAR(64)  NOT NULL,
    equipe_nom VARCHAR(150) NOT NULL,
    scanne_le  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    INDEX idx_scans_equipe_date (equipe_id, scanne_le),
    INDEX idx_scans_date (scanne_le)
  ) ${TABLE_OPTS}`,

  `CREATE TABLE IF NOT EXISTS event_capacities (
    event_id VARCHAR(32) NOT NULL PRIMARY KEY,
    capacite INT         NOT NULL DEFAULT 500
  ) ${TABLE_OPTS}`,

  `CREATE TABLE IF NOT EXISTS expenses (
    id       VARCHAR(64)  NOT NULL PRIMARY KEY,
    libelle  VARCHAR(255) NOT NULL,
    montant  INT          NOT NULL,
    event_id VARCHAR(32)  NOT NULL DEFAULT '*',
    date     DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    INDEX idx_expenses_date (date)
  ) ${TABLE_OPTS}`,

  `CREATE TABLE IF NOT EXISTS platform_settings (
    cle    VARCHAR(64) NOT NULL PRIMARY KEY,
    valeur LONGTEXT    NOT NULL
  ) ${TABLE_OPTS}`,

  // Sessions persistées : survivent aux redémarrages / multi-processus de Passenger (o2switch)
  `CREATE TABLE IF NOT EXISTS admin_sessions (
    token_hash     CHAR(64)    NOT NULL PRIMARY KEY,
    kind           VARCHAR(10) NOT NULL,
    equipe_id      VARCHAR(64) NULL,
    agent_id       VARCHAR(64) NULL,
    ip             VARCHAR(64) NULL,
    created_at     DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    last_active_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    CONSTRAINT chk_sessions_kind CHECK (kind IN ('founder', 'team')),
    INDEX idx_sessions_equipe (equipe_id),
    INDEX idx_sessions_activity (last_active_at)
  ) ${TABLE_OPTS}`,

  `CREATE TABLE IF NOT EXISTS login_attempts (
    bucket       VARCHAR(128) NOT NULL PRIMARY KEY,
    count        INT          NOT NULL DEFAULT 0,
    locked_until DATETIME(3)  NULL,
    updated_at   DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
  ) ${TABLE_OPTS}`,
];

async function seedDefaults() {
  // Lazy import pour éviter une dépendance circulaire avec platformStore
  const { hashKeySha256, maskKey, hashPasswordPbkdf2 } = await import('../services/platformStore.js');

  // 1. Mot de passe fondateur — lu uniquement depuis l'environnement (rien dans le code) :
  //    - FOUNDER_AUTH_SALT + FOUNDER_AUTH_HASH : hash PBKDF2 existant (conserve le mot de passe fondateur actuel)
  //    - ou FOUNDER_PASSWORD : nouveau mot de passe en clair, haché à l'initialisation
  //    Appliqué seulement si aucun mot de passe n'est encore enregistré (un changement fait depuis le dashboard est conservé).
  const founderSalt = String(process.env.FOUNDER_AUTH_SALT || '').trim();
  const founderHash = String(process.env.FOUNDER_AUTH_HASH || '').trim();
  const founderPwd = String(process.env.FOUNDER_PASSWORD || '').trim();
  let founderAuth = null;
  if (/^[0-9a-f]{16,}$/i.test(founderSalt) && /^[0-9a-f]{128}$/i.test(founderHash)) {
    founderAuth = { salt: founderSalt, hash: founderHash.toLowerCase(), updatedAt: new Date().toISOString() };
  } else if (founderPwd.length >= 8) {
    const { salt, hash } = hashPasswordPbkdf2(founderPwd);
    founderAuth = { salt, hash, updatedAt: new Date().toISOString() };
  }
  if (founderAuth) {
    await pool.query(
      `INSERT IGNORE INTO platform_settings (cle, valeur) VALUES ('founder', ?)`,
      [JSON.stringify(founderAuth)]
    );
  }

  // 2. Paramètres par défaut
  await pool.query(`INSERT IGNORE INTO platform_settings (cle, valeur) VALUES ('frais_taux_pct', '0')`);
  await pool.query(
    `INSERT IGNORE INTO platform_settings (cle, valeur) VALUES ('transfer_config', ?)`,
    [JSON.stringify({ enabled: true, maxTransfersPerTicket: 1, maxTransfersPerUser: 5 })]
  );

  // 3. Capacités par événement
  for (const ev of EVENTS) {
    await pool.query(`INSERT IGNORE INTO event_capacities (event_id, capacite) VALUES (?, 500)`, [ev.id]);
  }

  // 4. Équipe terrain principale (uniquement si aucune équipe n'existe)
  const { rows } = await pool.query('SELECT COUNT(*) AS cnt FROM equipes');
  if (Number(rows[0].cnt) === 0) {
    const teamKey = String(process.env.VALIDATE_API_KEY || '').trim();
    if (teamKey.length >= 16) {
      await pool.query(
        `INSERT IGNORE INTO equipes (id, nom, cle_hash, cle_hint, event_ids, actif) VALUES (?, ?, ?, ?, ?, 1)`,
        ['team-principale', 'Équipe Terrain Principale', hashKeySha256(teamKey), maskKey(teamKey), JSON.stringify(['*'])]
      );
    } else {
      console.warn('[DB] Aucune équipe créée : définissez VALIDATE_API_KEY (16+ caractères) ou créez une équipe depuis le dashboard fondateur.');
    }
  }

  // 5. Avertissements de configuration sensibles
  const { rows: fRows } = await pool.query(`SELECT valeur FROM platform_settings WHERE cle = 'founder'`);
  if (!fRows.length) {
    console.warn('[SÉCURITÉ] Mot de passe fondateur non configuré : définissez FOUNDER_AUTH_SALT/FOUNDER_AUTH_HASH (ou FOUNDER_PASSWORD) puis redémarrez.');
  }
}

/** Crée la base (si les droits le permettent), les tables et les données par défaut. */
export async function initDb() {
  assertSecretsConfigured();
  const dbName = getDatabaseName();
  try {
    const conn = await createServerConnection();
    try {
      await conn.query(`CREATE DATABASE IF NOT EXISTS \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    } finally {
      await conn.end();
    }
  } catch (err) {
    // Sur un hébergement mutualisé (cPanel/o2switch), la base est créée depuis le panneau : on continue.
    if (['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT'].includes(err.code)) {
      throw new Error('Base MySQL injoignable : démarrez MySQL dans Laragon (ou vérifiez DATABASE_URL).');
    }
  }

  for (const stmt of SCHEMA) {
    await pool.query(stmt);
  }
  await seedDefaults();
}

// Exécution directe : npm run db:init
if (process.argv[1] && process.argv[1].endsWith('init.js')) {
  try {
    await initDb();
    console.log(`✅  Base MySQL "${getDatabaseName()}" prête (reservations, payment_transactions, ticket_transfers, equipes, scans_log, event_capacities, expenses, platform_settings, admin_sessions, login_attempts).`);
  } catch (err) {
    console.error("❌  Erreur lors de l'initialisation :", err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
