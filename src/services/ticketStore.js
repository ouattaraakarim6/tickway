// src/services/ticketStore.js — Accès invité aux billets & rapport des transferts (MySQL)
import crypto from 'node:crypto';
import pool from '../db/pool.js';
import { isEventExpired } from './events.js';
import { getTransferConfig } from './platformStore.js';

export function hashSecret(raw) {
  return crypto.createHash('sha256').update(String(raw || '')).digest('hex');
}

function toIso(d) {
  if (!d) return null;
  return d instanceof Date ? d.toISOString() : String(d);
}

export function mapReservationToTicket(r, fallbackOrigin, cfg) {
  const origin = String(fallbackOrigin || 'https://tickway.netlify.app').replace(/\/$/, '');
  const isTransferredOut = r.statut === 'transfere';
  const qrText = isTransferredOut
    ? null
    : (r.qr_text || `${origin}/#controle?c=${encodeURIComponent(r.reference)}`);
  const transferCount = Number(r.transfer_count) || 0;
  const expired = isEventExpired(r.event_id);
  const maxPerTicket = Number(cfg.maxTransfersPerTicket ?? 1);
  return {
    reference: r.reference,
    commandeId: r.commande_id || r.reference,
    prenom: r.prenom,
    nom: r.nom,
    telephone: r.telephone,
    email: r.email,
    localite: r.localite || 'Localité non renseignée',
    categorie: r.categorie || 'Standard Navette',
    eventId: r.event_id,
    eventNom: r.event_nom,
    eventDate: r.event_date,
    zone: r.zone,
    pointRelais: r.point_relais,
    montant: Number(r.montant) || 0,
    fraisTransaction: Number(r.frais_transaction) || 0,
    modePaiement: r.mode_paiement,
    statut: r.statut || 'valide',
    qrText,
    transferCount,
    maxTransfersPerTicket: maxPerTicket,
    transferredFrom: r.transferred_from || null,
    transferredTo: r.transferred_to || null,
    transferredAt: toIso(r.transferred_at),
    isExpired: expired,
    canTransfer: r.statut === 'valide' && !expired && Boolean(cfg.enabled) && transferCount < maxPerTicket,
    creeLe: toIso(r.cree_le),
    utiliseLe: toIso(r.utilise_le),
  };
}

export async function getGuestTicketsByAccessToken(rawToken, fallbackOrigin) {
  const clean = String(rawToken || '').trim();
  if (clean.length < 16) return [];
  const { rows } = await pool.query(
    'SELECT * FROM reservations WHERE guest_access_hash = ? ORDER BY cree_le ASC',
    [hashSecret(clean)]
  );
  const cfg = await getTransferConfig();
  return rows
    .filter((r) => r.statut === 'valide' || r.statut === 'utilise')
    .map((r) => mapReservationToTicket(r, fallbackOrigin, cfg));
}

function sanitizeTransferRecord(tr) {
  return {
    id: tr.id,
    oldReference: tr.old_reference,
    newReference: tr.new_reference,
    commandeId: tr.commande_id || tr.old_reference,
    eventId: tr.event_id,
    eventNom: tr.event_nom,
    eventDate: tr.event_date,
    categorie: tr.categorie || 'Standard Navette',
    fromUserId: tr.from_user_id,
    fromName: tr.from_name,
    fromEmail: tr.from_email,
    toUserId: tr.to_user_id || null,
    toName: tr.to_name || tr.to_email,
    toEmail: tr.to_email,
    statut: tr.statut || 'complete',
    direction: null,
    createdAt: toIso(tr.created_at),
    claimedAt: toIso(tr.claimed_at),
  };
}

export async function getAdminTransfersReport() {
  const cfg = await getTransferConfig();
  const { rows } = await pool.query('SELECT * FROM ticket_transfers ORDER BY created_at DESC LIMIT 500');
  const transfers = rows.map(sanitizeTransferRecord);
  const stats = {
    total: transfers.length,
    completes: transfers.filter((t) => t.statut === 'complete').length,
    reclames: transfers.filter((t) => t.statut === 'reclame').length,
    enAttente: transfers.filter((t) => t.statut === 'en_attente_compte').length,
  };
  return { config: cfg, stats, transfers };
}
