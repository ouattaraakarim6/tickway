// src/services/events.js — Données des événements et points relais (source de vérité côté serveur)

export const EVENTS = [
  {
    id: 'k',
    n: 'Kiff No Beat',
    t: 'Concert',
    m: 'Novembre',
    d: 'Sam. 28 novembre 2026',
    h: '',
    p: 6000,
    img: 'https://media.tikerama.com/events/cover/1d4210fa-db6a-4ec1-8ebc-595153290698/conversions/01M4H1BRWF15FZ5C7KX94KBDF7-thumbnail.jpg',
  },
  {
    id: 'sb',
    n: 'Serge Beynaud',
    t: 'Concert',
    m: 'Décembre',
    d: 'Sam. 5 décembre 2026',
    h: '20 h 00',
    p: 6000,
    img: 'https://media.tikerama.com/events/cover/e4ef1550-863d-5f48-85cb-b862ddca36f7/conversions/beynaud-en-concert-a-lesplanade-du-parc-des-expos-6a8340c162e48-1786986739-thumbnail.jpg',
  },
  {
    id: 'dm',
    n: 'Dena Mwana',
    t: 'Concert',
    m: 'Décembre',
    d: 'Dim. 13 décembre 2026',
    h: '16 h 00',
    p: 6000,
    img: 'https://media.tikerama.com/events/cover/a3433dd3-de52-489c-b6b6-c5442a95947a/conversions/event_image_1792544807369-thumbnail.jpg',
  },
  {
    id: 'mw',
    n: 'Meiway',
    t: 'Concert',
    m: 'Décembre',
    d: 'Dim. 13 & Sam. 19 décembre 2026',
    h: '20 h 00',
    p: 6000,
    img: 'https://media.tikerama.com/events/cover/c61c8aeb-b153-5744-8ef9-3c8e669337d0/conversions/le-double-concert-de-meiway-et-le-zo-gang-6aa021ee42802-1788879375-1788881476-thumbnail.jpg',
  },
  {
    id: 't',
    n: 'Tiakola',
    t: 'Concert',
    m: 'Décembre',
    d: 'Dim. 20 décembre 2026',
    h: '',
    p: 6000,
    img: 'https://media.tikerama.com/events/cover/b6785ac0-ba3d-4e34-a512-d60c3b865555/conversions/01M4BJNJVQ4BG67YQ9YF31M22V-thumbnail.jpg',
  },
  {
    id: 'lp',
    n: 'Les Patrons',
    t: 'Concert',
    m: 'Décembre',
    d: 'Dim. 20 décembre 2026',
    h: '20 h 00',
    p: 6000,
    img: 'https://media.tikerama.com/events/cover/3d605f31-5377-4957-9ded-8f5788290dfe/conversions/les-patrons-en-concert-live-6ac65670046a9-thumbnail.jpg',
  },
  {
    id: 'f',
    n: 'Fally Ipupa',
    t: 'Concert',
    m: 'Décembre',
    d: 'Jeu. 24 & Ven. 25 décembre 2026',
    h: '20 h 00',
    p: 6000,
    img: 'https://media.tikerama.com/events/cover/80f66712-afe1-5c07-8ed4-c6be1585372f/conversions/fally-ipupa-en-concert-au-stade-fhb-6a9d0a77421a8-1788676756-1788677536-thumbnail.jpg',
  },
  {
    id: 'h',
    n: 'Himra',
    t: 'Concert',
    m: 'Décembre',
    d: 'Sam. 26 décembre 2026',
    h: '20 h 00',
    p: 6000,
    img: 'https://media.tikerama.com/events/cover/5fc0a8a1-93b3-504d-9e97-e90c52a5aa2a/conversions/himra-en-concert-au-stade-ebimpe-6a834348e6886-1786987394-thumbnail.jpg',
  },
  {
    id: 'm',
    n: 'Mother Africa Festival',
    t: 'Festival',
    m: 'Décembre',
    d: 'Dim. 27 & Lun. 28 décembre 2026',
    h: '18 h 00',
    p: 6000,
    img: 'https://media.tikerama.com/events/cover/e3ce4e77-e970-44e9-8acc-128728cb9370/conversions/dOrBPs2KlPg5yGIxRKnIk2CKq7E5FmqYHlRlsz5F-thumbnail.jpg',
  },
];

export const RELAIS = [
  {
    n: 'Abidjan Nord',
    p: [
      ['Yopougon', 'Zone 1 - Carrefour Niangon Supeco'],
      ['Yopougon', 'Zone 2 - Cosmos'],
      ['Angré', 'CNPS'],
      ['Riviera 2', 'Casino'],
      ['Abobo', "Mairie d'Abobo"],
      ['Adjamé', 'Gare routière'],
      ['Bingerville', 'Késé'],
      ['Anyama', 'Carrefour Anyama'],
      ['Songon', 'Terminus SOTRA'],
    ],
  },
  {
    n: 'Abidjan Sud',
    p: [
      ['Cocody', 'UFHB'],
      ['Plateau', 'Cathédrale du Plateau'],
      ['Marcory', 'Prima Center'],
      ['Treichville', 'Gare SOTRA'],
      ['Koumassi', 'Grand Marché'],
      ['Port-Bouët', 'Mairie de Port-Bouët'],
      ['Grand-Bassam', 'Carrefour Grand-Bassam'],
    ],
  },
];

export const PAIEMENTS = {
  wv: 'Wave',
  om: 'Orange Money',
  mt: 'MTN MoMo',
  mv: 'Moov Money',
  cb: 'Carte bancaire',
  psh: 'PaySecureHub (Mobile Money / Carte)',
};

export function findEvent(id) {
  return EVENTS.find((e) => e.id === id) || null;
}

export function findRelais(zoneIndex, pointIndex) {
  const zone = RELAIS[zoneIndex];
  if (!zone) return null;
  const point = zone.p[pointIndex];
  if (!point) return null;
  return { zone: zone.n, commune: point[0], lieu: point[1] };
}

// Dates de fin d'événement (fuseau Abidjan GMT+0) pour empêcher le transfert après expiration
export const EVENT_END_DATES = {
  k: '2026-11-29T05:00:00Z',
  sb: '2026-12-06T05:00:00Z',
  dm: '2026-12-14T05:00:00Z',
  mw: '2026-12-20T05:00:00Z',
  t: '2026-12-21T05:00:00Z',
  lp: '2026-12-21T05:00:00Z',
  f: '2026-12-26T05:00:00Z',
  h: '2026-12-27T05:00:00Z',
  m: '2026-12-29T05:00:00Z',
};

export function isEventExpired(eventId, now = new Date()) {
  const endIso = EVENT_END_DATES[eventId];
  if (!endIso) return false;
  return Date.parse(endIso) < (now instanceof Date ? now.getTime() : Number(now));
}
