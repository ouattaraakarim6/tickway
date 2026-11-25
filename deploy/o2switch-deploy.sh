#!/usr/bin/env bash
# deploy/o2switch-deploy.sh — Déploiement TickWay sur o2switch (à exécuter SUR le serveur, via SSH).
#
# Usage :  bash ~/tickway-plateforme/deploy/o2switch-deploy.sh
# Variables optionnelles :
#   APP_DIR      Dossier de l'application (clone git)        défaut : $HOME/tickway-plateforme
#   BRANCH       Branche à déployer                            défaut : main
#   NODE_VERSION Version Node choisie dans « Setup Node.js App » défaut : détectée dans ~/nodevenv
#   CANONICAL_HOST  Domaine canonique (redirections http/www)   défaut : tick-way.com
#   HTACCESS_PATH   .htaccess du domaine à modifier             défaut : détecté via PassengerAppRoot
#   HEALTHCHECK_URL URL qui doit répondre 200 après déploiement (sinon le .htaccess est restauré)
#
# Le fichier .env de production vit uniquement sur le serveur (jamais dans git).
set -euo pipefail

APP_DIR="${APP_DIR:-$HOME/tickway-plateforme}"
BRANCH="${BRANCH:-main}"
APP_NAME="$(basename "$APP_DIR")"

log() { printf '\n\033[1;34m▶ %s\033[0m\n' "$*"; }
fail() { printf '\n\033[1;31m✖ %s\033[0m\n' "$*" >&2; exit 1; }

[ -d "$APP_DIR/.git" ] || fail "Dépôt git introuvable dans $APP_DIR"
cd "$APP_DIR"
[ -f .env ] || fail "Fichier $APP_DIR/.env absent : créez-le (chmod 600) avant de déployer."

# 1. Environnement Node créé par cPanel « Setup Node.js App » (CloudLinux nodevenv)
if [ -z "${NODE_VERSION:-}" ]; then
  NODE_VERSION="$(ls -1 "$HOME/nodevenv/$APP_NAME" 2>/dev/null | sort -V | tail -n1 || true)"
fi
VENV="$HOME/nodevenv/$APP_NAME/$NODE_VERSION/bin/activate"
[ -n "$NODE_VERSION" ] && [ -f "$VENV" ] || fail "Environnement Node introuvable ($VENV). Créez l'application dans cPanel > Setup Node.js App."
# shellcheck disable=SC1090
source "$VENV"
log "Node $(node -v) / npm $(npm -v)"

# 2. Récupération de la dernière version depuis GitHub
log "Mise à jour du code ($BRANCH)"
PREV_COMMIT="$(git rev-parse HEAD)"
git fetch --prune origin "$BRANCH"
git checkout -q "$BRANCH"
git reset --hard "origin/$BRANCH"
NEW_COMMIT="$(git rev-parse HEAD)"
echo "Commit : ${PREV_COMMIT:0:7} → ${NEW_COMMIT:0:7}"

# 3. Dépendances de production uniquement
# (pas de « npm ci » : sur CloudLinux, node_modules est un lien symbolique vers le nodevenv et ne doit pas être supprimé)
log "Installation des dépendances"
npm install --omit=dev --no-audit --no-fund

# 4. Schéma MySQL (idempotent)
log "Initialisation / migration de la base"
npm run db:init

# 5. Redirections canoniques (http / www → https://CANONICAL_HOST) dans le .htaccess du domaine
log "Redirections HTTPS / www → https://${CANONICAL_HOST:-tick-way.com}"
APP_DIR="$APP_DIR" CANONICAL_HOST="${CANONICAL_HOST:-tick-way.com}" bash "$APP_DIR/deploy/install-redirects.sh"

restore_htaccess() {
  # Annule la modification du .htaccess si le site ne répond plus après l'installation des redirections
  local f
  while IFS= read -r f; do
    [ -f "$f.bak" ] && cp -p "$f.bak" "$f" && echo "↩ .htaccess restauré : $f"
  done < <(find "$HOME" -maxdepth 3 -type f -name .htaccess 2>/dev/null | xargs -r grep -lF "BEGIN TICKWAY REDIRECTS" 2>/dev/null || true)
}

# 6. Redémarrage de l'application Passenger
log "Redémarrage de l'application"
mkdir -p tmp
touch tmp/restart.txt

# 7. Vérification : l'adresse canonique doit répondre 200 (pas de redirection, pas de boucle)
if [ -n "${HEALTHCHECK_URL:-}" ]; then
  log "Vérification $HEALTHCHECK_URL"
  sleep 3
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$HEALTHCHECK_URL" || echo 000)"
  if [ "$code" != "200" ]; then
    restore_htaccess
    fail "Le site répond $code au lieu de 200 sur $HEALTHCHECK_URL (redirections annulées, voir stderr.log)."
  fi
  echo "HTTP 200 ✔"

  # Garde-fou : les fichiers de l'application (.env, src/…) ne doivent jamais être servis par Apache
  for leak in ".env" "package.json" "src/server.js"; do
    leak_code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "https://${CANONICAL_HOST:-tick-way.com}/$leak" || echo 000)"
    body="$(curl -s --max-time 20 "https://${CANONICAL_HOST:-tick-way.com}/$leak" | head -c 300 || true)"
    # Une réponse 200 n'est une fuite que si ce n'est pas la page d'accueil (fallback SPA) qui est renvoyée
    if [ "$leak_code" = "200" ] && ! printf '%s' "$body" | grep -qi '<!doctype html'; then
      fail "FUITE : https://${CANONICAL_HOST:-tick-way.com}/$leak est accessible publiquement. La racine web du domaine doit être $APP_DIR/public (cPanel > Domaines), jamais $APP_DIR."
    fi
  done
  echo "Aucun fichier sensible exposé ✔"
fi

log "Déploiement terminé (${NEW_COMMIT:0:7})"
