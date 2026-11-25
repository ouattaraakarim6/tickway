#!/usr/bin/env bash
# deploy/install-redirects.sh — Installe (ou met à jour) les redirections canoniques dans le .htaccess du domaine.
#   http://…, www.…, https://www.…  →  https://<CANONICAL_HOST><chemin>?<paramètres>   (301)
#
# Usage : APP_DIR=$HOME/tickway-plateforme CANONICAL_HOST=tick-way.com bash deploy/install-redirects.sh
#   HTACCESS_PATH=/chemin/.htaccess  force le fichier cible (sinon détection automatique via PassengerAppRoot)
# Idempotent : le bloc « TICKWAY REDIRECTS » est remplacé, jamais dupliqué ; le bloc Passenger de cPanel n'est pas modifié.
set -euo pipefail

APP_DIR="${APP_DIR:-$HOME/tickway-plateforme}"
CANONICAL_HOST="${CANONICAL_HOST:-tick-way.com}"
SEARCH_ROOT="${SEARCH_ROOT:-$HOME}"
BEGIN="# BEGIN TICKWAY REDIRECTS"
END="# END TICKWAY REDIRECTS"

if ! [[ "$CANONICAL_HOST" =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$ ]]; then
  echo "✖ CANONICAL_HOST invalide : $CANONICAL_HOST" >&2
  exit 1
fi

# 1. Fichier(s) cible(s)
targets=()
if [ -n "${HTACCESS_PATH:-}" ]; then
  targets+=("$HTACCESS_PATH")
else
  # .htaccess écrit par cPanel « Setup Node.js App » pour cette application
  while IFS= read -r f; do targets+=("$f"); done < <(
    find "$SEARCH_ROOT" -maxdepth 3 -type f -name .htaccess 2>/dev/null \
      | xargs -r grep -lF -e "PassengerAppRoot \"$APP_DIR\"" -e "PassengerAppRoot $APP_DIR" 2>/dev/null || true
  )
fi
if [ "${#targets[@]}" -eq 0 ]; then
  echo "⚠ Aucun .htaccess avec « PassengerAppRoot $APP_DIR » trouvé : redirections Apache non installées."
  echo "  (Le serveur Node redirige malgré tout www → https://$CANONICAL_HOST.) Indiquez HTACCESS_PATH pour forcer."
  exit 0
fi

# Deux règles séparées :
#  - www.<domaine> (http ou https)  → https://<domaine>
#  - http://<domaine>               → https://<domaine>, sauf si un proxy frontal indique déjà https (évite toute boucle)
# Le renouvellement Let's Encrypt (/.well-known/acme-challenge/) n'est jamais redirigé.
BLOCK="$BEGIN
<IfModule mod_rewrite.c>
RewriteEngine On
RewriteCond %{REQUEST_URI} !^/\\.well-known/acme-challenge/
RewriteCond %{HTTP_HOST} ^www\\. [NC]
RewriteRule ^ https://$CANONICAL_HOST%{REQUEST_URI} [L,R=301]
RewriteCond %{REQUEST_URI} !^/\\.well-known/acme-challenge/
RewriteCond %{HTTPS} !=on
RewriteCond %{HTTP:X-Forwarded-Proto} !https [NC]
RewriteRule ^ https://$CANONICAL_HOST%{REQUEST_URI} [L,R=301]
</IfModule>
$END"

# 2. Installation idempotente en tête de fichier
for f in "${targets[@]}"; do
  [ -f "$f" ] || touch "$f"
  cp -p "$f" "$f.bak"
  tmp="$(mktemp)"
  {
    printf '%s\n\n' "$BLOCK"
    # Contenu existant sans l'ancien bloc TickWay (ni la ligne vide qui le suivait)
    awk -v b="$BEGIN" -v e="$END" '
      $0 == b { skip = 1; next }
      $0 == e { skip = 0; drop_blank = 1; next }
      skip { next }
      drop_blank && $0 == "" { drop_blank = 0; next }
      { drop_blank = 0; print }
    ' "$f"
  } > "$tmp"
  cat "$tmp" > "$f"   # conserve propriétaire et permissions du fichier d'origine
  rm -f "$tmp"
  echo "✔ Redirections vers https://$CANONICAL_HOST installées dans $f (sauvegarde : $f.bak)"
done
