# TickWay : reste à faire

*Mis à jour le 25/11/2026. Point de reprise après la migration MySQL, le passage à la messagerie o2switch et la préparation du déploiement.*

## Fait (rappel)
- Base **MySQL** (Laragon en local) : 10 tables, `npm run db:init`. PostgreSQL, Supabase et Docker sont retirés.
- Sécurité :
  - aucun secret dans le code ;
  - faille `/api/resend` corrigée ;
  - clés et hashs retirés du front ;
  - HTML échappé dans les e-mails ;
  - CORS strict ;
  - `npm audit` sans vulnérabilité.
- Mot de passe fondateur d'origine conservé (hash dans `.env` : `FOUNDER_AUTH_SALT` / `FOUNDER_AUTH_HASH`).
- PaySecureHub configuré dans le `.env` local.
- E-mails : **SMTP o2switch** (nodemailer) à la place d'EmailJS. Test d'envoi : `npm run mail:test -- adresse`.
- Redirections `http://`, `www.` et `https://www.` vers **https://tick-way.com** (`.htaccess` + Express), HSTS.
- Outils de déploiement : `deploy/deploy.ps1`, `deploy/push-env.mjs`, `deploy/o2switch-deploy.sh`, `deploy/install-redirects.sh`.
- Guide pas à pas pour Claude Desktop : `deploy/PROMPT-CLAUDE-DESKTOP.md`.
- Tests Playwright : `npm run test:e2e` (4/4), sur une base séparée `tickway_e2e`.

## Reste à faire

### 1. Versionner le travail
- [x] Travail commité et poussé sur `main` (commit `73eaba6`, dépôt `ouattaraakarim6/tickway`).
- [ ] ⚠️ Le dépôt GitHub est **PUBLIC**. Le code ne contient aucun secret, mais l'historique git contient le **hash du mot de passe fondateur actuel**, attaquable hors ligne. Passer le dépôt en **privé** (GitHub › Settings › General › Danger Zone › Change visibility), et envisager à terme de changer le mot de passe fondateur.

### 2. Déploiement o2switch (via Claude Desktop + `deploy/PROMPT-CLAUDE-DESKTOP.md`)
- [ ] Accès SSH : autoriser l'IP dans cPanel, clé `~/.ssh/o2switch_tickway`, alias `o2switch-tickway`.
- [ ] Gestionnaire de fichiers : créer `/home/<identifiant>/tickway-plateforme`. Clé de déploiement GitHub, puis clone du dépôt dans ce dossier.
- [ ] MySQL : base et utilisateur `<identifiant>_tickway` (tous privilèges).
- [ ] Messagerie : créer la boîte `billets@tick-way.com`, relever le serveur SMTP (port 465), vérifier **SPF + DKIM** (Délivrabilité des e-mails).
- [ ] Domaine : racine web sur `tickway-plateforme/public` (ou `public_html` si c'est le domaine principal). **Jamais** sur `tickway-plateforme` lui-même.
- [ ] DNS de `tick-way.com` **et** `www.tick-way.com`. Certificat SSL couvrant les deux noms. Ne pas activer la redirection HTTPS de cPanel.
- [ ] Setup Node.js App : racine `tickway-plateforme`, URL `tick-way.com`, démarrage `app.cjs`, mode Production, Node ≥ 20.
- [ ] Créer `.env.production` (local, non versionné) avec le `DATABASE_URL` o2switch.
- [ ] Lancer `node deploy/push-env.mjs --dry-run`, puis `node deploy/push-env.mjs`.
- [ ] Premier déploiement : `powershell -ExecutionPolicy Bypass -File deploy\deploy.ps1`.
- [ ] Vérifier en ligne :
  - le site et `/api/founder/status` ;
  - les 4 redirections ;
  - `/.env` non exposé ;
  - la connexion au dashboard fondateur ;
  - `npm run mail:test` depuis le serveur.

### 3. Configuration locale
- [ ] Après création de la boîte o2switch, remplir `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS` et `MAIL_FROM` dans le `.env` local. Tester avec `npm run mail:test -- ton@adresse.com`. `push-env.mjs` refuse d'envoyer la configuration de production tant que ces valeurs sont vides.

### 4. Paiement
- [ ] Dans le tableau de bord PaySecureHub, renseigner si nécessaire l'URL de callback `https://tick-way.com/api/payments/paysecurehub/webhook`.
- [ ] Faire un vrai paiement de bout en bout en ligne. En local, la confirmation automatique ne fonctionne pas : il faut cliquer sur « Vérifier mon paiement ».

### 5. Améliorations optionnelles (à décider)
- [ ] CSP (politique de sécurité du contenu) encore désactivée : le front contient beaucoup de scripts intégrés.
- [ ] Limitation de débit (rate limit) comptée par processus Passenger ; à passer en base si besoin.
- [ ] `/api/resend` répond « E-mail renvoyé » même si le SMTP n'est pas configuré.
- [ ] Restes de l'ancien hébergement Netlify : `index.html` et `_redirects` à la racine, et le « mode local » du front (`loadLocalPlatform`). À supprimer si Netlify n'est plus utilisé.
- [ ] L'historique git contient d'anciennes valeurs : clé équipe par défaut (plus utilisée), identifiants EmailJS (plus utilisés) et hash du mot de passe fondateur actuel.
- [ ] Le compte EmailJS peut être fermé ou son modèle supprimé, puisqu'il n'est plus utilisé.

## Commandes utiles
| Action | Commande |
|---|---|
| Lancer l'app en local (MySQL Laragon démarré) | `npm run dev` puis http://localhost:3000 |
| (Re)créer les tables | `npm run db:init` |
| Tests de bout en bout | `npm run test:e2e` |
| Tester l'envoi d'e-mail | `npm run mail:test -- adresse@exemple.com` |
| Prévisualiser les variables de production | `node deploy/push-env.mjs --dry-run` |
| Déployer | `powershell -ExecutionPolicy Bypass -File deploy\deploy.ps1` |
