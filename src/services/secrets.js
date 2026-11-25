// src/services/secrets.js — Secrets applicatifs lus EXCLUSIVEMENT depuis les variables d'environnement.
// Aucun secret ni valeur de repli n'est écrit dans le code source.
import crypto from 'node:crypto';

const MIN_SECRET_LENGTH = 32;

/** Secret maître (APP_SECRET, ou l'ancien nom TICKWAY_RESET_SECRET). */
function getMasterSecret() {
  const secret = String(process.env.APP_SECRET || process.env.TICKWAY_RESET_SECRET || '').trim();
  if (secret.length < MIN_SECRET_LENGTH) {
    const err = new Error(
      `APP_SECRET manquant ou trop court (${MIN_SECRET_LENGTH}+ caractères requis). `
      + 'Générez-le avec : node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
    );
    err.code = 'MISSING_APP_SECRET';
    throw err;
  }
  return secret;
}

/** Dérive une sous-clé de 32 octets dédiée à un usage précis (séparation des clés). */
export function deriveKey(purpose) {
  return crypto.createHmac('sha256', getMasterSecret()).update(`tickway:${purpose}:v1`).digest();
}

/** Vérifie au démarrage que les secrets indispensables sont présents. */
export function assertSecretsConfigured() {
  getMasterSecret();
}
