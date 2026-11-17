// src/db/init.js — Crée la table reservations (idempotent avec support multi-tickets jusqu'à 5)
import 'dotenv/config';
import pool from './pool.js';

const SQL = `
CREATE TABLE IF NOT EXISTS reservations (
  reference     TEXT PRIMARY KEY,
  prenom        TEXT        NOT NULL,
  nom           TEXT        NOT NULL,
  telephone     TEXT        NOT NULL,
  email         TEXT        NOT NULL,
  event_id      TEXT        NOT NULL,
  event_nom     TEXT        NOT NULL,
  event_date    TEXT        NOT NULL,
  zone          TEXT        NOT NULL,
  point_relais  TEXT        NOT NULL,
  montant       INTEGER     NOT NULL,
  mode_paiement TEXT        NOT NULL,
  quantite      INTEGER     NOT NULL DEFAULT 1 CHECK (quantite >= 1 AND quantite <= 5),
  statut        TEXT        NOT NULL DEFAULT 'valide'
                            CHECK (statut IN ('valide', 'utilise')),
  cree_le       TIMESTAMPTZ NOT NULL DEFAULT now(),
  utilise_le    TIMESTAMPTZ
);

-- Migration automatique si la colonne quantite n'existait pas encore
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS quantite INTEGER NOT NULL DEFAULT 1;

CREATE INDEX IF NOT EXISTS idx_reservations_statut ON reservations (statut);
CREATE INDEX IF NOT EXISTS idx_reservations_email  ON reservations (email);
`;

try {
  await pool.query(SQL);
  console.log('✅  Table « reservations » prête (avec support jusqu\'à 5 tickets).');
} catch (err) {
  console.error("❌  Erreur lors de l'initialisation :", err.message);
  process.exit(1);
} finally {
  await pool.end();
}
