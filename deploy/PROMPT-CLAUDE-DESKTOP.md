# Mission : déployer TickWay sur o2switch (tick-way.com) avec un déploiement automatique

Tu es mon ingénieur de déploiement. Tu utilises Claude Desktop avec Cowork : le terminal de mon PC (Windows) et le navigateur Chrome, où ma session cPanel o2switch est déjà ouverte. Objectif : rendre l'application **TickWay** fonctionnelle sur **https://tick-way.com**, connectée à une base **MySQL o2switch**. Ensuite, chaque fois que je dirai **« déploie »**, tu publieras automatiquement la dernière version via GitHub et SSH.

## Le projet (déjà prêt, ne modifie pas le code applicatif)
- Dossier local : `D:\PROJET-TICKWAY\tickway`. Dépôt GitHub : `https://github.com/ouattaraakarim6/tickway`, branche `main`.
- Stack : Node.js ≥ 18 (ES Modules) + Express. Le front est `public/index.html`, servi par Express. Base **MySQL** via `mysql2`.
- Point d'entrée Passenger (cPanel « Setup Node.js App ») : **`app.cjs`**.
- `npm run db:init` crée les tables. Il est idempotent et relançable sans risque. Sur o2switch, la base elle-même se crée dans cPanel.
- `deploy/o2switch-deploy.sh` s'exécute **sur le serveur** : git pull, `npm install --omit=dev`, `db:init`, redémarrage Passenger, healthcheck.
- `deploy/push-env.mjs` s'exécute **sur mon PC** : il génère le `.env` de production à partir de mon `.env` local, puis l'écrit sur le serveur via SSH (`chmod 600`). Les valeurs ne s'affichent jamais, et `--dry-run` liste seulement les noms des variables.
- `deploy/deploy.ps1` s'exécute **sur mon PC** : vérifications, `git push`, synchronisation du `.env` de production, lancement du script serveur en SSH, puis contrôle du site.
- `.env.example` liste toutes les variables d'environnement. Lis-le en entier avant de commencer.

## Règles impératives
1. **Secrets** : n'affiche jamais en clair dans le chat un mot de passe, une clé ou un contenu de `.env`. Ne commite jamais `.env` ni `.env.production`.
2. **Les valeurs de production sont celles de mon `.env` local.** Ne les modifie pas et n'en génère pas d'autres. Cela vaut en particulier pour les clés PaySecureHub, le mot de passe fondateur (`FOUNDER_AUTH_SALT` / `FOUNDER_AUTH_HASH`), `APP_SECRET` et `VALIDATE_API_KEY`. Seule exception : les identifiants SMTP, encore vides, que tu renseignes à l'étape 4 bis. `deploy/push-env.mjs` les reprend automatiquement. Seules les valeurs propres au serveur, comme la base o2switch, vont dans `.env.production`.
3. Avant toute action destructive ou irréversible, **demande-moi confirmation**. Exemples : supprimer une base, un domaine ou une application cPanel, faire un `git push --force`, écraser un dossier existant sur le serveur.
4. Dans Chrome, travaille uniquement dans l'onglet cPanel o2switch déjà ouvert et sur github.com. Si une page demande un mot de passe, une 2FA ou un captcha, arrête-toi et demande-moi de le faire.
5. Si une étape échoue, montre-moi l'erreur exacte (sans secrets), explique la cause probable et propose la correction. Ne contourne pas en silence.
6. Note au fur et à mesure les valeurs **non secrètes** dont j'aurai besoin : identifiant cPanel, hôte SSH, nom de la base, chemin de l'app.

## Étape 1 : envoyer le code sur GitHub
1. Dans `D:\PROJET-TICKWAY\tickway`, lance `git status`. Vérifie que `.env` n'apparaît pas et qu'il figure bien dans `.gitignore`.
2. Montre-moi la liste des fichiers modifiés et propose un message de commit. Après mon accord, commite et `git push origin main`.
3. Vérifie sur github.com que le dépôt est **privé**. S'il est public, signale-le-moi avant de continuer.

## Étape 2 : accès SSH à o2switch depuis mon PC
1. Récupère dans cPanel l'identifiant cPanel et le nom d'hôte du serveur.
2. o2switch exige d'autoriser l'adresse IP. Dans cPanel, ouvre l'outil **« Autorisation SSH »** (whitelist SSH) et ajoute l'IP publique actuelle de mon PC.
3. Sur mon PC, crée la clé `~/.ssh/o2switch_tickway` (ed25519, pour moi seul) si elle n'existe pas. Importe la clé publique dans cPanel › **Accès SSH › Gérer les clés SSH**, puis **autorise-la**.
4. Ajoute dans `~/.ssh/config` l'alias suivant :
   ```
   Host o2switch-tickway
     HostName <hôte o2switch>
     User <identifiant cPanel>
     Port 22
     IdentityFile ~/.ssh/o2switch_tickway
     IdentitiesOnly yes
   ```
5. Teste la connexion avec `ssh o2switch-tickway "echo ok && node -v || true"`.

## Étape 3 : dossier `tickway-plateforme` et dépôt GitHub sur le serveur
Les fichiers de l'application sont déposés dans le dossier dédié **`/home/<identifiant>/tickway-plateforme`**.
1. Dans cPanel › **Gestionnaire de fichiers**, crée à la racine de mon compte (`/home/<identifiant>`) le dossier **`tickway-plateforme`**. Il doit être vide.
2. Sur le serveur (via SSH), génère une clé dédiée : `ssh-keygen -t ed25519 -f ~/.ssh/github_tickway -N ""`. Ajoute un bloc `Host github.com` dans `~/.ssh/config` côté serveur qui utilise cette clé.
3. Ajoute sa clé **publique** comme **Deploy key en lecture seule** sur le dépôt GitHub (Settings › Deploy keys, ou `gh repo deploy-key add` depuis mon PC).
4. Dans cPanel › **Git™ Version Control**, crée le dépôt en clonant `git@github.com:ouattaraakarim6/tickway.git` dans **`/home/<identifiant>/tickway-plateforme`**. Si l'interface échoue, clone en SSH dans ce même dossier (`git clone git@github.com:ouattaraakarim6/tickway.git ~/tickway-plateforme`), puis enregistre-le dans Git Version Control comme dépôt existant.
5. Vérifie dans le Gestionnaire de fichiers que `tickway-plateforme` contient `app.cjs`, `package.json`, `src/`, `public/` et `deploy/`. Puis lance `ssh o2switch-tickway "cd ~/tickway-plateforme && git log --oneline -1"`, qui doit afficher le dernier commit de GitHub.

## Étape 4 : base MySQL sur o2switch
1. Dans cPanel › **Bases de données MySQL**, crée la base `<identifiant>_tickway`.
2. Crée l'utilisateur `<identifiant>_tickway` avec un mot de passe fort généré, sans l'afficher. Associe-le à la base avec **TOUS LES PRIVILÈGES**.
3. L'hôte MySQL est `localhost`. La chaîne de connexion sera `mysql://<identifiant>_tickway:<mot_de_passe_encodé_URL>@localhost:3306/<identifiant>_tickway`. Encode les caractères spéciaux : `@` → `%40`, `#` → `%23`, `/` → `%2F`, `:` → `%3A`.
4. Les tables sont créées automatiquement par le déploiement (`npm run db:init`). Ne les crée pas à la main.

## Étape 4 bis : boîte e-mail d'envoi des billets (SMTP o2switch)
Les billets sont envoyés par le serveur via la messagerie o2switch (nodemailer). EmailJS n'est plus utilisé.
1. Dans cPanel › **Comptes de messagerie**, crée la boîte **`billets@tick-way.com`**. Demande-moi si je préfère une autre adresse.
2. Mot de passe : demande-moi si je veux le choisir. Sinon, génère-le, fort, sans l'afficher. Tu me le donneras une seule fois dans le rapport final.
3. Ouvre « **Connecter les appareils** » (Connect Devices) pour cette boîte et relève le **serveur SMTP sortant** (souvent `xxxx.o2switch.net` ou `mail.tick-way.com`) et le port **SSL/TLS 465**.
4. Écris ces valeurs dans mon **`.env` local** (`D:\PROJET-TICKWAY\tickway\.env`), sans les afficher :
   ```
   SMTP_HOST=<serveur SMTP sortant>
   SMTP_PORT=465
   SMTP_USER=billets@tick-way.com
   SMTP_PASS=<mot de passe de la boîte>
   MAIL_FROM=TickWay <billets@tick-way.com>
   MAIL_REPLY_TO=
   ```
   `push-env.mjs` les reportera ensuite automatiquement en production.
5. Dans cPanel › **Délivrabilité des e-mails**, vérifie que **SPF** et **DKIM** sont « valides » pour `tick-way.com`, et applique les corrections proposées si besoin. Sans cela, les billets risquent d'arriver en spam.
6. Test depuis mon PC : `npm run mail:test -- <mon adresse e-mail>`. Demande-moi l'adresse, puis confirme avec moi la réception d'un « Billet de test » avec son QR code.

## Étape 5 : domaine, DNS et HTTPS
1. **Racine web du domaine** (cPanel › **Domaines**) :
   - Si tick-way.com est un **domaine additionnel**, règle sa racine (document root) sur **`tickway-plateforme/public`**.
   - S'il est le **domaine principal** du compte, sa racine est `public_html` et ne peut pas changer : laisse-la ainsi.
   - ⚠️ Ne fais **jamais** pointer la racine web sur `tickway-plateforme` lui-même. Apache servirait alors directement `.env` et le code source.
2. **DNS** : `tick-way.com` **et `www.tick-way.com`** doivent pointer vers o2switch (pour `www` : un CNAME vers `tick-way.com` ou un enregistrement A vers l'IP o2switch). Sinon, dis-moi quoi changer chez le registrar.
3. **SSL** : active un certificat Let's Encrypt / AutoSSL couvrant **`tick-way.com` ET `www.tick-way.com`**, et vérifie que les deux noms y figurent. Sans certificat pour `www`, le navigateur bloque `https://www.tick-way.com` avant toute redirection.
4. **Redirections** : n'active **pas** la « redirection HTTPS forcée » de cPanel ni d'autres règles www. Le déploiement installe lui-même le bloc `TICKWAY REDIRECTS` dans le `.htaccess` ; des règles en double provoqueraient des boucles. Résultat attendu : `http://tick-way.com`, `www.tick-way.com`, `http://www.tick-way.com` et `https://www.tick-way.com` redirigent tous (301) vers **`https://tick-way.com`**, en conservant le chemin et les paramètres.

## Étape 6 : créer l'application Node.js
Dans cPanel › **Setup Node.js App** › *Create Application* :
- **Node.js version** : la plus récente disponible (≥ 20).
- **Application mode** : Production.
- **Application root** : **`tickway-plateforme`**. C'est le dossier du clone git, qui contient `app.cjs` et le `.env`.
- **Application URL** : `tick-way.com`.
- **Application startup file** : **`app.cjs`**.

Enregistre, puis vérifie :
- le chemin d'activation affiché doit être `source /home/<identifiant>/nodevenv/tickway-plateforme/<version>/bin/activate` ;
- dans le Gestionnaire de fichiers, le `.htaccess` de la racine web (`tickway-plateforme/public/.htaccess` ou `public_html/.htaccess`) doit contenir `PassengerAppRoot "/home/<identifiant>/tickway-plateforme"` et `PassengerStartupFile app.cjs` ;
- cPanel ne doit pas avoir créé un `app.js` par défaut à la place d'`app.cjs`. S'il en a créé un, supprime-le, sans toucher à `app.cjs`.

## Étape 7 : variables d'environnement de production (automatique)
1. Sur mon PC, crée le fichier **`D:\PROJET-TICKWAY\tickway\.env.production`**. Il est ignoré par git ; vérifie-le avec `git check-ignore .env.production`. Il ne contient que ce qui diffère du local :
   ```
   DATABASE_URL=mysql://<identifiant>_tickway:<mot_de_passe_encodé_URL>@localhost:3306/<identifiant>_tickway
   ```
   Utilise le mot de passe MySQL créé à l'étape 4. Écris-le directement dans le fichier, sans l'afficher.
2. Contrôle avec `node deploy/push-env.mjs --dry-run`. La cible doit être `~/tickway-plateforme/.env`, et la liste doit afficher `NODE_ENV=production`, `APP_URL=https://tick-way.com` et toutes les clés renseignées ; les valeurs secrètes restent masquées.
3. Envoie avec `node deploy/push-env.mjs`. Le script écrit **`~/tickway-plateforme/.env`** en `chmod 600`. Ce fichier est hors de la racine web, donc jamais accessible depuis Internet. Le script reprend les valeurs du `.env` local (SMTP o2switch, PaySecureHub, hash fondateur, `APP_SECRET`, `VALIDATE_API_KEY`), fixe les valeurs de production (`NODE_ENV`, `APP_URL`, `API_PUBLIC_URL`, `CORS_ORIGINS`) puis applique `.env.production`. Il refuse d'envoyer la base Laragon locale.
4. Vérifie la présence des clés, sans les valeurs : `ssh o2switch-tickway "cut -d= -f1 ~/tickway-plateforme/.env"`.

Ensuite, `deploy.ps1` resynchronise ce `.env` à chaque déploiement. Toute valeur modifiée dans mon `.env` local est donc reportée automatiquement en production.

## Étape 8 : premier déploiement et vérifications
1. Lance `ssh o2switch-tickway "HEALTHCHECK_URL=https://tick-way.com/api/founder/status CANONICAL_HOST=tick-way.com bash ~/tickway-plateforme/deploy/o2switch-deploy.sh"`. Le script :
   - installe les dépendances ;
   - crée les tables MySQL ;
   - installe les redirections dans le `.htaccess` ;
   - redémarre l'app ;
   - vérifie que le site répond 200 et qu'aucun fichier sensible n'est exposé.
2. Vérifie :
   - `https://tick-way.com` affiche le site, et `https://tick-way.com/api/founder/status` renvoie `{"statut":"ok","configured":true}`.
   - Les redirections fonctionnent (code et destination, sans suivre la redirection) :

     | URL | Attendu |
     |---|---|
     | `http://tick-way.com/` | 301 → `https://tick-way.com/` |
     | `http://www.tick-way.com/` | 301 → `https://tick-way.com/` |
     | `https://www.tick-way.com/` | 301 → `https://tick-way.com/` |
     | `http://www.tick-way.com/paiement-retour?cmd=X` | 301 → `https://tick-way.com/paiement-retour?cmd=X` |

   - **Aucune fuite** : `https://tick-way.com/.env` ne doit jamais renvoyer le contenu du fichier (la page d'accueil ou une 404 sont normales).
   - **E-mail** : `ssh o2switch-tickway "cd ~/tickway-plateforme && source ~/nodevenv/tickway-plateforme/*/bin/activate && npm run mail:test -- <mon adresse>"` envoie bien un billet de test depuis le serveur.
   - La sortie de `npm run db:init` liste les 10 tables. Dans phpMyAdmin, les tables `reservations`, `payment_transactions`, `equipes`, etc. existent.
   - La connexion au dashboard fondateur (`https://tick-way.com/#fondateur`) fonctionne avec mon mot de passe fondateur habituel. Demande-moi de le saisir moi-même.
3. En cas d'erreur 503 ou d'application qui ne démarre pas, consulte le journal `~/tickway-plateforme/stderr.log` (ou les logs indiqués par cPanel) et corrige. Si le site ne répond plus après l'installation des redirections, le script a déjà restauré `.htaccess.bak`.

## Étape 9 : déploiement automatique à la demande
Quand je dirai **« déploie »**, exécute depuis `D:\PROJET-TICKWAY\tickway` :
```
powershell -ExecutionPolicy Bypass -File deploy\deploy.ps1
```
Ce script vérifie qu'il n'y a pas de modifications non commitées et que ni `.env` ni `.env.production` ne sont suivis par git. Il pousse sur GitHub, régénère et envoie le `.env` de production, se connecte en SSH (`o2switch-tickway`) pour récupérer la dernière version et relancer l'app, puis contrôle le site.
- S'il y a des modifications non commitées, montre-les-moi et propose un commit avant de relancer.
- Si le SSH est refusé (IP changée), ré-autorise mon IP actuelle dans cPanel › Autorisation SSH, puis recommence.
- Après chaque déploiement, résume : commit déployé, résultat du healthcheck, éventuelles erreurs.

Remarque : n'utilise pas GitHub Actions pour pousser vers o2switch. Les IP des runners GitHub changent sans cesse et o2switch bloque le SSH des IP non autorisées. Le déploiement part donc de mon PC.

## Mémo déploiement (à retrouver dans le Gestionnaire de fichiers cPanel)
| Élément | Emplacement |
|---|---|
| Code de l'application (clone GitHub) | `/home/<identifiant>/tickway-plateforme` |
| Racine web du domaine tick-way.com | `/home/<identifiant>/tickway-plateforme/public` (ou `public_html` si domaine principal) |
| Fichier de démarrage Node.js | `tickway-plateforme/app.cjs` |
| Variables de production | `tickway-plateforme/.env` (chmod 600, généré par `deploy/push-env.mjs`, ne pas éditer à la main) |
| Environnement Node (cPanel) | `/home/<identifiant>/nodevenv/tickway-plateforme/<version>` |
| Journal d'erreurs | `tickway-plateforme/stderr.log` |
| Redémarrage manuel | toucher `tickway-plateforme/tmp/restart.txt` (ou « Restart » dans Setup Node.js App) |
| Redirections http/www → https | bloc `TICKWAY REDIRECTS` en tête du `.htaccess` de la racine web (sauvegarde `.htaccess.bak`) |
| Base de données | `<identifiant>_tickway` sur `localhost` (phpMyAdmin) |
| Boîte d'envoi des billets | `billets@tick-way.com` (cPanel › Comptes de messagerie ; SMTP port 465) |
| Test d'envoi e-mail | `npm run mail:test -- <adresse>` dans `tickway-plateforme` |
| Script de déploiement serveur | `tickway-plateforme/deploy/o2switch-deploy.sh` |

## Rapport final attendu
Fais une liste courte de ce qui a été fait, avec les valeurs non secrètes : identifiant cPanel, hôte, base, version de Node, URL, racine web retenue, et le résultat des contrôles de redirection et d'absence de fuite. Si tu as généré le mot de passe de la boîte `billets@tick-way.com`, donne-le-moi une seule fois à la fin, en me demandant de le conserver dans mon gestionnaire de mots de passe. Ajoute ce qui reste à faire de mon côté, par exemple : configurer l'URL de callback PaySecureHub si leur tableau de bord l'exige (`https://tick-way.com/api/payments/paysecurehub/webhook`).
