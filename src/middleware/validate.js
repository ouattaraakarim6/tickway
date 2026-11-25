// src/middleware/validate.js — Validation des champs de la réservation (support 1 à 5 tickets + localité + catégorie)

// Téléphone ivoirien : 01–07 ou 09, 8 chiffres après l'indicatif éventuel
const TEL_RE = /^(?:\+?225)?[0-9]{10}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * Valide les champs d'une requête de réservation.
 * Retourne un objet { valid, errors, sanitized }.
 */
export function validateReservation(body) {
  const errors = {};

  const prenom = (body.prenom || '').trim();
  const nom = (body.nom || '').trim();
  const telephone = (body.telephone || '').replace(/[\s.()-]/g, '');
  const email = (body.email || '').trim();
  const eventId = body.eventId;
  const zone = body.zone;
  const pointRelaisIndex = body.pointRelaisIndex;
  const modePaiement = body.modePaiement;
  const localite = (body.localite || '').trim();
  const categorie = (body.categorie || 'Standard Navette').trim() || 'Standard Navette';

  // Quantité de tickets : 1 à 5 (défaut: 1)
  let quantite = Number(body.quantite);
  if (!quantite || Number.isNaN(quantite)) quantite = 1;
  quantite = Math.floor(quantite);
  if (quantite < 1 || quantite > 5) {
    errors.quantite = 'Vous pouvez réserver entre 1 et 5 tickets maximum.';
  }

  if (!prenom || prenom.length < 2 || prenom.length > 80) errors.prenom = 'Prénom requis (2 à 80 caractères).';
  if (!nom || nom.length < 2 || nom.length > 80) errors.nom = 'Nom requis (2 à 80 caractères).';
  if (email.length > 254) errors.email = 'Adresse e-mail trop longue.';
  if (!TEL_RE.test(telephone)) errors.telephone = 'Numéro de téléphone ivoirien invalide.';
  if (!EMAIL_RE.test(email)) errors.email = 'Adresse e-mail invalide.';
  if (eventId === undefined || eventId === null) errors.eventId = 'Événement requis.';
  if (zone === undefined || zone === null || ![0, 1].includes(Number(zone))) errors.zone = 'Zone invalide (0 ou 1).';
  if (pointRelaisIndex === undefined || pointRelaisIndex === null) errors.pointRelaisIndex = 'Point relais requis.';
  if (!modePaiement) errors.modePaiement = 'Mode de paiement requis.';

  return {
    valid: Object.keys(errors).length === 0,
    errors,
    sanitized: {
      prenom,
      nom,
      telephone,
      email,
      eventId,
      zone: Number(zone),
      pointRelaisIndex: Number(pointRelaisIndex),
      modePaiement,
      quantite,
      localite: localite.slice(0, 150),
      categorie: categorie.slice(0, 100),
    },
  };
}
