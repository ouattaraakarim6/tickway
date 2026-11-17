# 🚐 TickWay — Backend & Intégration Front-end

Système backend de réservation et validation de billets de transport pour les concerts d'Abidjan.

---

## 📋 Table des matières

1. [Architecture & Stack](#-architecture--stack)
2. [Structure du projet](#-structure-du-projet)
3. [Installation & Configuration](#-installation--configuration)
4. [Base de données PostgreSQL](#-base-de-données-postgresql)
5. [Endpoints API](#-endpoints-api)
6. [Sécurité & Atomicité](#-sécurité--atomicité)
7. [Front-end connecté](#-front-end-connecté)

---

## 🛠 Architecture & Stack

- **Runtime** : Node.js (ES Modules)
- **Framework HTTP** : Express
- **Base de données** : PostgreSQL (compatible Supabase, Neon, Railway, Docker, local)
- **QR Code** : `qrcode` (PNG haute résolution + Data URL pour le front et les e-mails)
- **E-mails transactionnels** : **EmailJS** (API REST officielle, sans dépendance lourde)
- **Sécurité** : `helmet`, `cors`, `express-rate-limit`, `crypto.randomBytes`

---

## 📁 Structure du projet

```text
tickway-backend/
├── .env.example              # Gabarit des variables d'environnement
├── .gitignore
├── package.json              # Dépendances et scripts
├── README.md
├── src/
│   ├── server.js             # Serveur Express, rate-limits, routing et statiques
│   ├── db/
│   │   ├── pool.js           # Pool PostgreSQL unique
│   │   └── init.js           # Script idempotent de création de table et index
│   ├── middleware/
│   │   ├── auth.js           # Protection de /api/validate par X-Api-Key
│   │   └── validate.js       # Validation stricte des données de réservation
│   ├── routes/
│   │   ├── reservations.js   # POST /api/reservations & GET /:ref/qr.png
│   │   ├── validate.js       # POST /api/validate (atomicité PostgreSQL)
│   │   └── resend.js         # POST /api/resend (renvoi d'email de confirmation)
│   └── services/
│       ├── email.js          # Template HTML/texte + envoi avec QR en CID
│       ├── events.js         # Événements et points relais (source de vérité)
│       ├── qr.js             # Génération QR code côté serveur
│       └── reference.js      # Génération sécurisée TW-XXXX-XXXX
└── public/
    └── index.html            # Front-end complet connecté à l'API
```

---

## ⚙️ Installation & Configuration

### 1. Prérequis
- Node.js >= 18
- Une instance PostgreSQL (locale ou hébergée chez Supabase, Neon, Railway)

### 2. Installation des dépendances
```bash
cd /Users/karim/.gemini/antigravity/scratch/tickway-backend
npm install
```

### 3. Variables d'environnement
Copiez le fichier `.env.example` en `.env` et ajustez les paramètres :

```bash
cp .env.example .env
```

Contenu type de `.env` :
```env
DATABASE_URL=postgresql://postgres:mot_de_passe@localhost:5432/tickway
PORT=3000
NODE_ENV=development

# Clé secrète pour le scan/contrôle des billets par l'équipe terrain
VALIDATE_API_KEY=cle_secrete_equipe_terrain_2026

# Configuration EmailJS (https://dashboard.emailjs.com/)
EMAILJS_SERVICE_ID=service_xxxxxxx
EMAILJS_TEMPLATE_ID=template_xxxxxxx
EMAILJS_PUBLIC_KEY=votre_cle_publique_ou_user_id
EMAILJS_PRIVATE_KEY=votre_cle_privee

# URL publique de l'application (optionnel, pour l'affichage du QR dans le mail)
APP_URL=http://localhost:3000

# Domaines autorisés pour CORS (séparés par virgules)
CORS_ORIGINS=http://localhost:3000,http://127.0.0.1:5500
```

### 4. Initialisation de la table PostgreSQL
```bash
npm run db:init
```

---

## 🗄 Base de données PostgreSQL

La table `reservations` applique des contraintes strictes et des index de performance :

```sql
CREATE TABLE IF NOT EXISTS reservations (
  reference     TEXT PRIMARY KEY,                     -- Ex: TW-7K9A-4B2E
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
  statut        TEXT        NOT NULL DEFAULT 'valide'
                            CHECK (statut IN ('valide', 'utilise')),
  cree_le       TIMESTAMPTZ NOT NULL DEFAULT now(),
  utilise_le    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_reservations_statut ON reservations (statut);
CREATE INDEX IF NOT EXISTS idx_reservations_email  ON reservations (email);
```

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

1. **Atomicité des scans simultanés** :
   La validation s'appuie sur une requête SQL atomique :
   ```sql
   UPDATE reservations
   SET statut = 'utilise', utilise_le = now()
   WHERE reference = $1 AND statut = 'valide'
   RETURNING *;
   ```
   PostgreSQL pose un verrou de ligne exclusif (`row-level exclusive lock`). Si deux agents scannent la même référence à la milliseconde près, une seule transaction modifiera `rowCount = 1` ; la seconde obtiendra `rowCount = 0` et renverra immédiatement `statut: 'deja_utilise'`.

2. **Génération côté serveur de la référence** :
   Utilise `crypto.randomBytes(8)` mappé sur un alphabet sans ambiguïté (`23456789ABCDEFGHJKLMNPQRSTUVWXYZ`), vérifié en base.

3. **Protection de l'espace équipe** :
   L'endpoint `/api/validate` exige l'en-tête `X-Api-Key` vérifié via variable d'environnement (`VALIDATE_API_KEY`).

4. **Anti-abus (Rate Limiting)** :
   - `/api/reservations` : 5 requêtes par minute par IP.
   - `/api/validate` : 60 requêtes par minute par IP.

5. **E-mails transactionnels sécurisés via EmailJS** :
   Les e-mails sont expédiés côté serveur via l'API REST officielle d'EmailJS avec vérification de la clé privée (`accessToken`), empêchant toute falsification depuis le navigateur client.

---

## ✉️ Configuration du Template EmailJS

Dans votre tableau de bord [EmailJS](https://dashboard.emailjs.com/) :

### 1. Variables disponibles dans votre Template
Le backend transmet automatiquement toutes les variables suivantes :

| Variable | Description | Exemple |
| :--- | :--- | :--- |
| `{{to_email}}` | E-mail du passager | `awa@exemple.ci` |
| `{{to_name}}` | Nom complet du passager | `Awa Koné` |
| `{{reference}}` | Référence unique du billet | `TW-8M3P-9K2L` |
| `{{event_nom}}` | Nom de l'événement | `Kiff No Beat` |
| `{{event_date}}` | Date et heure de l'événement | `Sam. 21 novembre 2026, 19 h 00` |
| `{{zone}}` | Zone de transport | `Abidjan Nord` |
| `{{point_relais}}` | Point de ramassage | `Abobo, Mairie d'Abobo` |
| `{{montant}}` | Montant formaté | `5 000 FCFA` |
| `{{mode_paiement}}`| Moyen de paiement | `Wave` |
| `{{qr_code_url}}` | **Lien vers l'image QR** | URL d'image insérable dans `<img src="{{qr_code_url}}" />` |

### 2. Exemple de corps HTML anti-spam pour votre template EmailJS
Dans **EmailJS > Email Templates > `template_kkd54a6`** :
- **Subject** : `Confirmation de votre réservation TickWay ({{reference}})`
- **From Name** : `TickWay` (cochez **Use Default Email Address**)
- **Reply To** : Laissez **vide** (ou mettez votre propre adresse Gmail d'envoi — **ne mettez jamais** `{{email}}` ni un domaine non configuré comme `contact@tickway.ci`).

Collez ce code HTML (optimisé avec un bon ratio texte/image pour passer dans la boîte principale) dans l'éditeur HTML de votre template EmailJS :

```html
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif; background-color: #f4f6f9; padding: 24px; color: #252a31; line-height: 1.6;">
  <div style="max-width: 560px; margin: 0 auto; background: #ffffff; border-radius: 12px; overflow: hidden; border: 1px solid #e3e8ee;">
    <div style="background: #0a74b8; padding: 20px 24px; color: #ffffff;">
      <h2 style="margin: 0; font-size: 20px;">Tick<span style="color: #e0a526;">Way</span> — Confirmation de trajet</h2>
    </div>
    <div style="padding: 24px;">
      <p style="font-size: 16px; margin-top: 0;">Bonjour <strong>{{to_name}}</strong>,</p>
      <p style="color: #4a5568;">Nous vous confirmons l'enregistrement de votre place à bord de la navette dédiée TickWay pour l'événement <strong>{{event_nom}}</strong>. Vous trouverez ci-dessous le récapitulatif de votre trajet ainsi que votre code d'accès personnel.</p>
      
      <table style="width: 100%; border-collapse: collapse; margin: 20px 0; border: 1px solid #e3e8ee; border-radius: 8px;">
        <tr><td style="padding: 10px 12px; color: #64748b; border-bottom: 1px solid #f1f5f9;">Référence dossier</td><td style="padding: 10px 12px; font-weight: 600; color: #0a74b8; border-bottom: 1px solid #f1f5f9;">{{reference}}</td></tr>
        <tr><td style="padding: 10px 12px; color: #64748b; border-bottom: 1px solid #f1f5f9;">Événement</td><td style="padding: 10px 12px; font-weight: 600; border-bottom: 1px solid #f1f5f9;">{{event_nom}}</td></tr>
        <tr><td style="padding: 10px 12px; color: #64748b; border-bottom: 1px solid #f1f5f9;">Date et départ</td><td style="padding: 10px 12px; font-weight: 600; border-bottom: 1px solid #f1f5f9;">{{event_date}}</td></tr>
        <tr><td style="padding: 10px 12px; color: #64748b; border-bottom: 1px solid #f1f5f9;">Point relais</td><td style="padding: 10px 12px; font-weight: 600; border-bottom: 1px solid #f1f5f9;">{{point_relais}} ({{zone}})</td></tr>
        <tr><td style="padding: 10px 12px; color: #64748b;"> Participation réglée</td><td style="padding: 10px 12px; font-weight: 600;">{{montant}} ({{mode_paiement}})</td></tr>
      </table>

      <div style="margin-top: 20px;">
        {{{qr_html}}}
      </div>

      <p style="font-size: 13px; color: #64748b; margin-top: 24px; margin-bottom: 0;">Merci de vous présenter à votre point relais 15 minutes avant l'heure indiquée. Bon concert avec TickWay !</p>
    </div>
    <div style="background: #f8fafc; padding: 14px 24px; border-top: 1px solid #e3e8ee; font-size: 12px; color: #94a3b8; text-align: center;">
      Cet e-mail de service fait suite à votre réservation sur TickWay · Abidjan, Côte d'Ivoire.
    </div>
  </div>
</div>
```

---

## 💻 Front-end connecté

Le fichier [public/index.html](file:///Users/karim/.gemini/antigravity/scratch/tickway-backend/public/index.html) (et sa copie sur votre bureau [index (2).html](file:///Users/karim/Desktop/index%20(2).html)) conserve **100% du design, des polices, du CSS et des animations** du fichier original.

Les modifications portent uniquement sur :
- Remplacement du `localStorage` (`db`, `dbSave`, `genRef`) par les appels `fetch()` vers `/api/reservations`.
- Remplacement du QR code client par l'affichage direct du QR code renvoyé par le serveur (`qrDataUrl`).
- Ajout de la gestion du renvoi d'email via `/api/resend`.
- Connexion de l'Espace Équipe (`#controle`) à `/api/validate` avec mémorisation sécurisée de la clé d'API dans le navigateur de l'agent.
