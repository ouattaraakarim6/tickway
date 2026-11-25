// src/db/migrateUsersToSupabase.js — Script serveur optionnel et réversible pour pré-importer les comptes historiques dans Supabase Auth
// Usage côté serveur uniquement : SUPABASE_SECRET_KEY=... DATABASE_URL=... node src/db/migrateUsersToSupabase.js
import 'dotenv/config';
import crypto from 'node:crypto';
import pool from './pool.js';
import { INIT_SQL } from './init.js';
import {
  getSupabaseSecretKey,
  getSupabaseUrl,
  hasSupabaseAdminKey,
  supabaseAdminCreateUser,
} from '../services/supabaseAuth.js';
import { syncUserFromSupabase } from '../services/userStore.js';

async function findSupabaseUserByEmailAdmin(email) {
  const secretKey = getSupabaseSecretKey();
  const url = `${getSupabaseUrl()}/auth/v1/admin/users?filter=${encodeURIComponent(email)}`;
  const resp = await fetch(url, {
    headers: {
      apikey: secretKey,
      Authorization: `Bearer ${secretKey}`,
    },
    signal: AbortSignal.timeout(10000),
  });
  if (!resp.ok) return null;
  const data = await resp.json();
  const list = Array.isArray(data && data.users) ? data.users : [];
  return list.find((u) => String(u.email || '').toLowerCase() === String(email || '').toLowerCase()) || null;
}

if (!hasSupabaseAdminKey()) {
  console.error('❌ SUPABASE_SECRET_KEY (service_role) requis côté serveur pour exécuter la migration batch.');
  process.exit(1);
}

try {
  await pool.query(INIT_SQL);
  const { rows } = await pool.query(
    `SELECT * FROM users WHERE supabase_id IS NULL ORDER BY created_at ASC`
  );
  console.log(`🔎 ${rows.length} compte(s) historique(s) à synchroniser avec Supabase Auth.`);

  let linked = 0;
  for (const row of rows) {
    let supaUser = await findSupabaseUserByEmailAdmin(row.email);
    if (!supaUser) {
      // Créer le compte dans Supabase Auth avec un mot de passe aléatoire ;
      // le mot de passe PBKDF2 reste utilisable pour la première bascule ou l'utilisateur peut réinitialiser via OTP.
      const tempPassword = crypto.randomBytes(24).toString('base64url') + '!A1a';
      supaUser = await supabaseAdminCreateUser({
        email: row.email,
        password: tempPassword,
        emailConfirm: Boolean(row.email_verified),
        userMetadata: {
          prenom: row.prenom,
          nom: row.nom,
          telephone: row.telephone || '',
          legacy_user_id: row.id,
        },
      });
    }
    if (supaUser && supaUser.id) {
      await syncUserFromSupabase(supaUser, { allowEmailLink: true, wipeLegacyPassword: false });
      linked += 1;
    }
  }
  console.log(`✅ Synchronisation terminée : ${linked}/${rows.length} compte(s) liés sans perte de billets.`);
} catch (err) {
  console.error('❌ Erreur de migration :', err);
  process.exit(1);
} finally {
  await pool.end();
}
