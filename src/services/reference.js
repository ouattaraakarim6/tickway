// src/services/reference.js — Génération de référence unique côté serveur
import crypto from 'node:crypto';
import pool from '../db/pool.js';

const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'; // 32 caractères sans ambiguïté

/**
 * Génère une référence unique TW-XXXX-XXXX.
 * En cas de collision (extrêmement rare), on retente.
 */
export async function generateReference() {
  for (let attempt = 0; attempt < 5; attempt++) {
    const bytes = crypto.randomBytes(8);
    let code = '';
    for (const b of bytes) code += ALPHABET[b % 32];
    const ref = `TW-${code.slice(0, 4)}-${code.slice(4, 8)}`;

    // Vérifier unicité en base
    const { rows } = await pool.query(
      'SELECT 1 FROM reservations WHERE reference = $1',
      [ref]
    );
    if (rows.length === 0) return ref;
  }
  throw new Error('Impossible de générer une référence unique après 5 tentatives');
}
