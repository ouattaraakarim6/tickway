# 🚐 TickWay — Backend & Intégration Front-end

Système de réservation et de validation de billets de navette pour les concerts d'Abidjan.

---

## 🛠 Architecture & Stack

- **Frontend** : HTML / CSS / JavaScript vanilla, page unique `public/index.html` servie par Express
- **Backend** : Node.js (≥ 18, ES Modules) + Express
- **Base de données** : **MySQL 8** / MariaDB 10.5+ via `mysql2` (Laragon en local, o2switch en production) — unique source de vérité
- **Paiement** : PaySecureHub (page hébergée + IPN serveur-à-serveur, statut toujours re-vérifié côté serveur)
- **QR Code** : `qrcode` ; **E-mails** : SMTP de la messagerie o2switch via `nodemailer`
- **Sécurité** : `helmet`, `cors`, `express-rate-limit`, sessions et anti-force-brute persistés en base
- **Tests** : Playwright (`tests/e2e/`) avec un faux PaySecureHub local

## 📁 Structure du projet

```text
tickway/
├── app.cjs                  # Point d'entrée Passenger (o2switch « Setup Node.js App »)
├── .env.example             # Gabarit des variables d'environnement (aucune valeur secrète)
├── playwright.config.js     # Configuration des tests de bout en bout
├── src/
│   ├── server.js            # Serveur Express, rate-limits, routes, gestion d'erreurs
│   ├── db/
│   │   ├── pool.js          # Pool MySQL (mysql2) + transactions
│   │   └── init.js          # Création idempotente de la base, des tables et des données initiales
│   ├── middleware/          # auth.js (équipe / fondateur), validate.js (saisies)
│   ├── routes/              # payments, reservations, validate, resend, team, founder
│   └── services/            # platformStore (équipes, scans, fondateur…), ticketStore, secrets, email, qr…
├── public/index.html        # Front-end complet
└── tests/e2e/               # Tests Playwright + mock PaySecureHub
```

## ⚙️ Installation locale (Laragon)

1. Démarrer **MySQL** dans Laragon (port 3306, utilisateur `root` sans mot de passe par défaut).
2. `npm install`
3. `cp .env.example .env` puis renseigner au minimum :
   - `DATABASE_URL=mysql://root:@127.0.0.1:3306/tickway`
   - `FOUNDER_AUTH_SALT` / `FOUNDER_AUTH_HASH` : hash du mot de passe fondateur existant (ou `FOUNDER_PASSWORD` pour un nouveau)
   - `APP_SECRET`, `VALIDATE_API_KEY` : valeurs aléatoires générées avec
     `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
4. `npm run db:init` — crée la base `tickway` et les tables (relançable sans risque).
5. `npm run dev` puis ouvrir http://localhost:3000
6. Tests : `npx playwright install chromium` (une fois) puis `npm run test:e2e`

> 🔐 **Aucun secret n'est écrit dans le code** : mots de passe, clés équipe, clés PaySecureHub, identifiants SMTP
> et `APP_SECRET` viennent exclusivement des variables d'environnement. Le fichier `.env` n'est jamais versionné.

## 🗄 Base de données MySQL

Tables (InnoDB, utf8mb4) créées par `src/db/init.js` :

| Table | Rôle |
|---|---|
| `reservations` | Billets (référence `TW-XXXX-XXXX`, statut `valide` / `en_attente` / `utilise` / `annule` / `transfere`) |
| `payment_transactions` | Commandes PaySecureHub, statut de paiement, jeton invité chiffré |
| `ticket_transfers` | Historique des transferts de billets |
| `equipes` | Équipes terrain (clé stockée sous forme de HMAC uniquement) |
| `scans_log` | Journal des 1000 derniers contrôles |
| `event_capacities`, `expenses`, `platform_settings` | Capacités, dépenses, réglages (frais, transferts, mot de passe fondateur haché PBKDF2) |
| `admin_sessions`, `login_attempts` | Sessions fondateur / équipe (hash du jeton) et verrouillage anti-force-brute |

## 🌍 Production (o2switch)

- Base : créer la base + l'utilisateur dans cPanel › *Bases de données MySQL*, puis
  `DATABASE_URL=mysql://<user>:<mot_de_passe_encodé>@localhost:3306/<base>`
- Dossier serveur : **`/home/<user>/tickway-plateforme`** (clone GitHub, `.env`, `app.cjs`) ; racine web du domaine : **`tickway-plateforme/public`** (jamais le dossier de l'app lui-même, pour ne pas exposer `.env`)
- Application : cPanel › *Setup Node.js App*, racine `tickway-plateforme`, fichier de démarrage **`app.cjs`**, `NODE_ENV=production`
- Adresse unique **https://tick-way.com** : `http://`, `www.` et `https://www.` sont redirigés en 301 (bloc `TICKWAY REDIRECTS` du `.htaccess`, installé par `deploy/install-redirects.sh`, + filet de sécurité dans Express) ; HSTS activé
- En production, la configuration du mot de passe fondateur via l'interface est désactivée : il est défini par `FOUNDER_AUTH_SALT`/`FOUNDER_AUTH_HASH` (ou `FOUNDER_PASSWORD`).
- Variables de production : `node deploy/push-env.mjs` génère le `.env` du serveur à partir du `.env` local (+ `.env.production` pour la base o2switch, fichier non versionné) et l'envoie en SSH.
- Déploiement : `deploy/deploy.ps1` (depuis le PC : push GitHub + SSH) qui exécute `deploy/o2switch-deploy.sh` sur le serveur. Pas de Docker.
- Guide pas à pas pour Claude Desktop : `deploy/PROMPT-CLAUDE-DESKTOP.md`.

---

## 🚀 Endpoints API

### 1. Créer une réservation
- **Méthode** : `POST`
- **URL** : `/api/reservations`
- **Corps (JSON)** :
  ```json
  {
    "prenom": "Awa",
    "nom": "Koné",
    "telephone": "0700000000",
    "email": "awa@exemple.ci",
    "eventId": "k",
    "zone": 0,
    "pointRelaisIndex": 1,
    "modePaiement": "wv"
  }
  ```
- **Réponse succès (201 Created)** :
  ```json
  {
    "statut": "ok",
    "reference": "TW-8M3P-9K2L",
    "qrDataUrl": "data:image/png;base64,...",
    "reservation": {
      "prenom": "Awa",
      "nom": "Koné",
      "telephone": "0700000000",
      "email": "awa@exemple.ci",
      "evenement": "Kiff No Beat",
      "date": "Sam. 21 novembre 2026, 19 h 00",
      "zone": "Abidjan Nord",
      "pointRelais": "Abobo, Mairie d'Abobo",
      "montant": 5000,
      "modePaiement": "Wave"
    }
  }
  ```

---

### 2. Valider un billet (Scan équipe)
- **Méthode** : `POST`
- **URL** : `/api/validate`
- **En-têtes** :
  - `Content-Type: application/json`
  - `X-Api-Key: <VOTRE_VALIDATE_API_KEY>`
- **Corps (JSON)** :
  ```json
  {
    "reference": "TW-8M3P-9K2L"
  }
  ```
- **Cas 1 : Billet validé avec succès (200 OK)** :
  ```json
  {
    "statut": "valide_maintenant",
    "reference": "TW-8M3P-9K2L",
    "passager": "Awa Koné",
    "evenement": "Kiff No Beat",
    "date": "Sam. 21 novembre 2026, 19 h 00",
    "zone": "Abidjan Nord",
    "pointRelais": "Abobo, Mairie d'Abobo",
    "montant": 5000,
    "modePaiement": "Wave",
    "utiliseLe": "2026-11-21T18:45:00.000Z"
  }
  ```
- **Cas 2 : Billet déjà utilisé (409 Conflict)** :
  ```json
  {
    "statut": "deja_utilise",
    "reference": "TW-8M3P-9K2L",
    "passager": "Awa Koné",
    "evenement": "Kiff No Beat",
    "utiliseLe": "2026-11-21T18:45:00.000Z"
  }
  ```
- **Cas 3 : Billet introuvable (404 Not Found)** :
  ```json
  {
    "statut": "introuvable",
    "reference": "TW-0000-0000"
  }
  ```

---

### 3. Renvoyer l'e-mail du billet
- **Méthode** : `POST`
- **URL** : `/api/resend`
- **Corps (JSON)** :
  ```json
  {
    "reference": "TW-8M3P-9K2L"
  }
  ```
- **Réponse (200 OK)** :
  ```json
  {
    "statut": "ok",
    "message": "E-mail renvoyé à awa@exemple.ci."
  }
  ```

---

### 4. Image QR Code directe
- **Méthode** : `GET`
- **URL** : `/api/reservations/:reference/qr.png`
- Renvoie directement le flux binaire PNG du QR Code (utile si besoin de télécharger le badge ou l'imprimer).

---

## 🔒 Sécurité & Atomicité

1. **Atomicité des scans simultanés** : `UPDATE reservations SET statut = 'utilise' … WHERE reference = ? AND statut = 'valide'`.
   InnoDB verrouille la ligne : si plusieurs agents scannent le même billet en même temps, un seul obtient `affectedRows = 1` (VERT), les autres reçoivent `deja_utilise` (ORANGE). Vérifié par un test de 8 scans concurrents.
2. **Paiements** : le statut « payé » est toujours re-vérifié auprès de PaySecureHub (jamais sur la seule foi du webhook), avec contrôle anti-sous-paiement et verrou `SELECT … FOR UPDATE` contre les doubles envois d'e-mail.
3. **Secrets** : uniquement dans les variables d'environnement. Clés équipe stockées en HMAC (clé dérivée de `APP_SECRET`), mot de passe fondateur en PBKDF2 (100 000 itérations), jetons de session stockés hachés.
4. **Authentification** : sessions persistées en base (15 min d'inactivité côté fondateur, 12 h côté équipe), verrouillage 5 min après 5 échecs, aucune vérification d'identifiant côté navigateur.
5. **Renvoi d'e-mail** (`/api/resend`) : seuls les billets actifs de la même commande sont renvoyés, à l'adresse de la commande ; l'adresse est masquée dans la réponse.
6. **Anti-abus** : `/api/reservations` et `/api/resend` 10 req/min/IP, validation & espaces équipe/fondateur 120 req/min/IP, corps JSON limité à 32 ko.
7. **Injection SQL** : requêtes paramétrées uniquement, `multipleStatements` désactivé.

---

## ✉️ E-mails des billets (SMTP o2switch)

Les billets sont envoyés par le serveur via la messagerie o2switch (bibliothèque `nodemailer`, sans service tiers) :
- cPanel › **Comptes de messagerie** : créer la boîte d'envoi (ex. `billets@tick-way.com`) ;
- renseigner `SMTP_HOST` (serveur indiqué dans « Connecter les appareils »), `SMTP_PORT=465`, `SMTP_USER`, `SMTP_PASS` et éventuellement `MAIL_FROM` / `MAIL_REPLY_TO` dans le `.env` ;
- cPanel › **Délivrabilité des e-mails** : vérifier que **SPF** et **DKIM** sont valides pour `tick-way.com` (sinon les billets risquent d'arriver en spam) ;
- tester : `npm run mail:test -- votre@adresse.com`.

Le gabarit HTML est intégré à `src/services/email.js` ; les QR codes sont générés par le serveur et joints au message (images intégrées), un lien « Afficher mes billets » permet aussi de les retrouver en ligne.
Sans configuration SMTP (développement, tests), aucun e-mail n'est envoyé et un avertissement est journalisé.

---

## 💻 Front-end connecté

`public/index.html` est servi par Express et appelle l'API (`/api/payments`, `/api/reservations`, `/api/validate`, `/api/team`, `/api/founder`, `/api/resend`).
Le paiement passe exclusivement par PaySecureHub ; la création directe via `POST /api/reservations` est refusée (403).
