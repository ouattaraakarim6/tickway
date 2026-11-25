// src/db/init.js — Crée et migre de façon additive les tables TickWay + Supabase (idempotent et réversible)
import 'dotenv/config';
import pool from './pool.js';

export const INIT_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id             TEXT PRIMARY KEY,
  supabase_id    UUID UNIQUE,
  prenom         TEXT        NOT NULL,
  nom            TEXT        NOT NULL,
  email          TEXT        NOT NULL UNIQUE,
  telephone      TEXT        NOT NULL DEFAULT '',
  password_salt  TEXT        NOT NULL,
  password_hash  TEXT        NOT NULL,
  email_verified BOOLEAN     NOT NULL DEFAULT false,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE users ADD COLUMN IF NOT EXISTS supabase_id UUID;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_supabase_id ON users (supabase_id) WHERE supabase_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_users_email ON users (LOWER(email));

CREATE TABLE IF NOT EXISTS profiles (
  id             UUID PRIMARY KEY,
  legacy_user_id TEXT UNIQUE,
  prenom         TEXT        NOT NULL,
  nom            TEXT        NOT NULL,
  email          TEXT        NOT NULL UNIQUE,
  telephone      TEXT        NOT NULL DEFAULT '',
  email_verified BOOLEAN     NOT NULL DEFAULT false,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_profiles_email ON profiles (LOWER(email));
CREATE INDEX IF NOT EXISTS idx_profiles_legacy_user_id ON profiles (legacy_user_id) WHERE legacy_user_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS user_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_user_sessions_user_id ON user_sessions (user_id);

CREATE TABLE IF NOT EXISTS user_tokens (
  id         TEXT PRIMARY KEY,
  user_id    TEXT,
  email      TEXT        NOT NULL,
  purpose    TEXT        NOT NULL CHECK (purpose IN ('verify_email', 'reset_password', 'claim_tickets')),
  code_hash  TEXT        NOT NULL,
  token_hash TEXT        NOT NULL,
  attempts   INTEGER     NOT NULL DEFAULT 0,
  used       BOOLEAN     NOT NULL DEFAULT false,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_user_tokens_email_purpose ON user_tokens (LOWER(email), purpose);

CREATE TABLE IF NOT EXISTS password_reset_grants (
  grant_hash                TEXT PRIMARY KEY,
  supabase_user_id          UUID        NOT NULL,
  email                     TEXT        NOT NULL,
  supabase_access_token_enc TEXT        NOT NULL,
  used                      BOOLEAN     NOT NULL DEFAULT false,
  expires_at                TIMESTAMPTZ NOT NULL,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_reset_grants_email ON password_reset_grants (LOWER(email));

CREATE TABLE IF NOT EXISTS auth_rate_limits (
  rate_key     TEXT PRIMARY KEY,
  attempts     INTEGER     NOT NULL DEFAULT 0,
  window_start TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_until TIMESTAMPTZ,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS reservations (
  reference          TEXT PRIMARY KEY,
  commande_id        TEXT,
  user_id            TEXT,
  prenom             TEXT        NOT NULL,
  nom                TEXT        NOT NULL,
  telephone          TEXT        NOT NULL,
  email              TEXT        NOT NULL,
  localite           TEXT        NOT NULL DEFAULT 'Localité non renseignée',
  categorie          TEXT        NOT NULL DEFAULT 'Standard Navette',
  event_id           TEXT        NOT NULL,
  event_nom          TEXT        NOT NULL,
  event_date         TEXT        NOT NULL,
  zone               TEXT        NOT NULL,
  point_relais       TEXT        NOT NULL,
  montant            INTEGER     NOT NULL,
  frais_transaction  INTEGER     NOT NULL DEFAULT 0,
  mode_paiement      TEXT        NOT NULL,
  quantite           INTEGER     NOT NULL DEFAULT 1 CHECK (quantite >= 1 AND quantite <= 5),
  statut             TEXT        NOT NULL DEFAULT 'valide',
  qr_text            TEXT,
  guest_access_hash  TEXT,
  transfer_count     INTEGER     NOT NULL DEFAULT 0,
  transferred_from   TEXT,
  transferred_to     TEXT,
  transferred_at     TIMESTAMPTZ,
  cree_le            TIMESTAMPTZ NOT NULL DEFAULT now(),
  utilise_le         TIMESTAMPTZ,
  agent_id           TEXT,
  equipe_id          TEXT,
  equipe_nom         TEXT
);

ALTER TABLE reservations ADD COLUMN IF NOT EXISTS quantite INTEGER NOT NULL DEFAULT 1;
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS commande_id TEXT;
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS user_id TEXT;
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS localite TEXT NOT NULL DEFAULT 'Localité non renseignée';
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS categorie TEXT NOT NULL DEFAULT 'Standard Navette';
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS frais_transaction INTEGER NOT NULL DEFAULT 0;
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS qr_text TEXT;
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS guest_access_hash TEXT;
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS transfer_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS transferred_from TEXT;
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS transferred_to TEXT;
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS transferred_at TIMESTAMPTZ;
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS agent_id TEXT;
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS equipe_id TEXT;
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS equipe_nom TEXT;

ALTER TABLE reservations DROP CONSTRAINT IF EXISTS reservations_statut_check;
ALTER TABLE reservations ADD CONSTRAINT reservations_statut_check
  CHECK (statut IN ('valide', 'en_attente', 'utilise', 'annule', 'transfere'));

CREATE INDEX IF NOT EXISTS idx_reservations_statut      ON reservations (statut);
CREATE INDEX IF NOT EXISTS idx_reservations_email       ON reservations (LOWER(email));
CREATE INDEX IF NOT EXISTS idx_reservations_user_id     ON reservations (user_id);
CREATE INDEX IF NOT EXISTS idx_reservations_event_id    ON reservations (event_id);
CREATE INDEX IF NOT EXISTS idx_reservations_localite    ON reservations (localite);
CREATE INDEX IF NOT EXISTS idx_reservations_commande_id ON reservations (commande_id);

CREATE TABLE IF NOT EXISTS ticket_transfers (
  id                      TEXT PRIMARY KEY,
  old_reference           TEXT        NOT NULL,
  new_reference           TEXT        NOT NULL UNIQUE,
  commande_id             TEXT,
  event_id                TEXT        NOT NULL,
  event_nom               TEXT        NOT NULL,
  event_date              TEXT        NOT NULL,
  categorie               TEXT        NOT NULL DEFAULT 'Standard Navette',
  from_user_id            TEXT        NOT NULL,
  from_name               TEXT        NOT NULL,
  from_email              TEXT        NOT NULL,
  to_user_id              TEXT,
  to_name                 TEXT,
  to_email                TEXT        NOT NULL,
  access_token_hash       TEXT,
  pending_recipient_claim BOOLEAN     NOT NULL DEFAULT false,
  statut                  TEXT        NOT NULL DEFAULT 'complete' CHECK (statut IN ('complete', 'en_attente_compte', 'reclame', 'annule')),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  claimed_at              TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_ticket_transfers_old_ref   ON ticket_transfers (old_reference);
CREATE INDEX IF NOT EXISTS idx_ticket_transfers_new_ref   ON ticket_transfers (new_reference);
CREATE INDEX IF NOT EXISTS idx_ticket_transfers_from_user ON ticket_transfers (from_user_id);
CREATE INDEX IF NOT EXISTS idx_ticket_transfers_to_email  ON ticket_transfers (LOWER(to_email));

CREATE TABLE IF NOT EXISTS payment_transactions (
  commande_id          TEXT        PRIMARY KEY,
  provider             TEXT        NOT NULL DEFAULT 'paysecurehub',
  code_paiement        TEXT        NOT NULL UNIQUE,
  provider_token       TEXT,
  payment_url          TEXT,
  transaction_ref      TEXT,
  pm_id                TEXT,
  provider_service     TEXT,
  amount               INTEGER     NOT NULL,
  fees                 INTEGER     NOT NULL DEFAULT 0,
  currency             TEXT        NOT NULL DEFAULT 'XOF',
  statut               TEXT        NOT NULL DEFAULT 'en_attente' CHECK (statut IN ('en_attente', 'paye', 'echoue', 'annule')),
  email_sent           BOOLEAN     NOT NULL DEFAULT false,
  access_token_enc     TEXT,
  last_webhook_payload JSONB,
  last_status_payload  JSONB,
  paid_at              TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_payment_tx_statut ON payment_transactions (statut);
`;

if (process.argv[1] && process.argv[1].endsWith('init.js')) {
  try {
    await pool.query(INIT_SQL);
    console.log('✅  Tables TickWay (reservations, payment_transactions, users, profiles, user_sessions, user_tokens, password_reset_grants, auth_rate_limits, ticket_transfers) prêtes.');
  } catch (err) {
    console.error("❌  Erreur lors de l'initialisation :", err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}
