#!/usr/bin/env node
// deploy/push-env.mjs — Génère le .env de PRODUCTION à partir du .env local et l'écrit sur le serveur o2switch via SSH.
//
//   node deploy/push-env.mjs            → construit et envoie ~/tickway-plateforme/.env sur le serveur (chmod 600)
//   node deploy/push-env.mjs --dry-run  → affiche uniquement la liste des variables (valeurs masquées), n'envoie rien
//
// Construction (du moins prioritaire au plus prioritaire) :
//   1. .env              — valeurs locales (SMTP o2switch, PaySecureHub, hash fondateur, APP_SECRET, VALIDATE_API_KEY…)
//   2. valeurs de prod    — NODE_ENV=production, APP_URL / API_PUBLIC_URL / CORS_ORIGINS = domaine public
//   3. .env.production    — valeurs propres au serveur (DATABASE_URL o2switch…), fichier local NON versionné
// Les valeurs ne sont jamais affichées : elles transitent uniquement par l'entrée standard de SSH.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const DRY_RUN = args.includes('--dry-run');
const SSH_HOST = opt('host', process.env.DEPLOY_SSH_HOST || 'o2switch-tickway');
const REMOTE_DIR = opt('app-dir', process.env.DEPLOY_APP_DIR || '~/tickway-plateforme');
const SITE_URL = opt('site', process.env.DEPLOY_SITE_URL || 'https://tick-way.com').replace(/\/$/, '');

// Variables propres au poste local ou aux tests : jamais envoyées en production
const LOCAL_ONLY = new Set(['PORT', 'E2E_PORT', 'E2E_DATABASE_URL', 'E2E_FOUNDER_PASSWORD', 'MOCK_PSH_PORT']);
// Variables obligatoires pour que l'application démarre correctement en production
const REQUIRED = ['DATABASE_URL', 'APP_SECRET', 'PAYSECUREHUB_API_KEY', 'PAYSECUREHUB_MERCHANT_ID', 'SMTP_HOST', 'SMTP_USER', 'SMTP_PASS'];

function readEnvFile(file, { required = false } = {}) {
  const full = path.join(ROOT, file);
  if (!fs.existsSync(full)) {
    if (required) throw new Error(`Fichier ${file} introuvable.`);
    return {};
  }
  return dotenv.parse(fs.readFileSync(full));
}

function fail(msg) {
  console.error(`\n✖ ${msg}\n`);
  process.exit(1);
}

// 1 + 2 + 3 : fusion
const local = readEnvFile('.env', { required: true });
const site = new URL(SITE_URL);
const wwwOrigin = site.hostname.startsWith('www.') ? '' : `${site.protocol}//www.${site.hostname}`;
const prodDefaults = {
  NODE_ENV: 'production',
  APP_URL: SITE_URL,
  API_PUBLIC_URL: SITE_URL,
  CORS_ORIGINS: [site.origin, wwwOrigin].filter(Boolean).join(','),
};
const prodOverrides = readEnvFile('.env.production');

const merged = { ...local, ...prodDefaults, ...prodOverrides };
for (const k of LOCAL_ONLY) delete merged[k];

// Garde-fous
for (const k of REQUIRED) {
  if (!String(merged[k] || '').trim()) fail(`Variable ${k} vide : renseignez-la dans .env (ou .env.production).`);
}
const dbUrl = String(merged.DATABASE_URL);
if (/@(127\.0\.0\.1|localhost):3306\/tickway$/.test(dbUrl) && /^mysql:\/\/root:/.test(dbUrl)) {
  fail('DATABASE_URL pointe encore sur la base Laragon locale.\n'
    + '  Créez le fichier .env.production (non versionné) avec la base o2switch :\n'
    + '  DATABASE_URL=mysql://<user>_tickway:<mot_de_passe_encodé>@localhost:3306/<user>_tickway');
}
if (String(merged.APP_SECRET).length < 32) fail('APP_SECRET doit contenir au moins 32 caractères.');
const hasFounder = (merged.FOUNDER_AUTH_SALT && merged.FOUNDER_AUTH_HASH) || String(merged.FOUNDER_PASSWORD || '').length >= 8;
if (!hasFounder) fail('Aucun mot de passe fondateur : FOUNDER_AUTH_SALT/FOUNDER_AUTH_HASH (ou FOUNDER_PASSWORD) requis.');

// Sérialisation sûre (valeurs entre guillemets si nécessaire)
function serialize(value) {
  const v = String(value ?? '');
  if (/^[A-Za-z0-9_@%:/.,+=\-<>]*$/.test(v)) return v;
  return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
}
const keys = Object.keys(merged).sort();
const content = [
  '# .env de production TickWay — généré par deploy/push-env.mjs (ne pas modifier à la main sur le serveur)',
  `# Généré le ${new Date().toISOString()}`,
  ...keys.map((k) => `${k}=${serialize(merged[k])}`),
  '',
].join('\n');

const mask = (k, v) => {
  const s = String(v ?? '');
  if (!s) return '(vide)';
  if (['NODE_ENV', 'APP_URL', 'API_PUBLIC_URL', 'CORS_ORIGINS', 'PAYSECUREHUB_BASE_URL', 'SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'MAIL_FROM', 'MAIL_REPLY_TO'].includes(k)) return s;
  return `•••• (${s.length} car.)`;
};
console.log(`\nVariables de production (${keys.length}) → ${SSH_HOST}:${REMOTE_DIR}/.env`);
for (const k of keys) console.log(`  ${k.padEnd(26)} ${mask(k, merged[k])}`);

if (DRY_RUN) {
  console.log('\n(--dry-run : rien n’a été envoyé)\n');
  process.exit(0);
}

// Écriture atomique côté serveur, permissions 600, sans que les valeurs n'apparaissent dans la ligne de commande
const remoteCmd = `set -e; umask 077; mkdir -p ${REMOTE_DIR}; cat > ${REMOTE_DIR}/.env.tmp; mv ${REMOTE_DIR}/.env.tmp ${REMOTE_DIR}/.env; chmod 600 ${REMOTE_DIR}/.env; echo "ok: $(grep -c '=' ${REMOTE_DIR}/.env) variables"`;
const child = spawn('ssh', [SSH_HOST, remoteCmd], { stdio: ['pipe', 'inherit', 'inherit'] });
child.stdin.end(content, 'utf8');
child.on('close', (code) => {
  if (code !== 0) fail(`Échec de l'envoi via SSH (code ${code}). Vérifiez l'alias « ${SSH_HOST} » et l'autorisation SSH de votre IP dans cPanel.`);
  console.log(`\n✔ .env de production écrit sur le serveur (${REMOTE_DIR}/.env, chmod 600).\n`);
});
