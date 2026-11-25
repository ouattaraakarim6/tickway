-- src/db/supabase_rls.sql
-- Politiques Row Level Security (RLS) additives pour Supabase PostgreSQL
-- IMPORTANT : Ne jamais désactiver RLS pour faciliter l'intégration.
-- Ce script est idempotent et conçu pour le schéma TickWay sur Supabase PostgreSQL.

-- 1. S'assurer que les tables existent (profiles, users, reservations, ticket_transfers, tables d'audit)
ALTER TABLE IF EXISTS public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.user_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.user_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.password_reset_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.auth_rate_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.ticket_transfers ENABLE ROW LEVEL SECURITY;

-- 2. Profils clients (profiles) : lecture uniquement de son propre profil ; blocage d'escalade d'identité
DROP POLICY IF EXISTS profiles_select_own ON public.profiles;
CREATE POLICY profiles_select_own
  ON public.profiles
  FOR SELECT
  TO authenticated
  USING (id = auth.uid());

DROP POLICY IF EXISTS profiles_update_own ON public.profiles;
CREATE POLICY profiles_update_own
  ON public.profiles
  FOR UPDATE
  TO authenticated
  USING (id = auth.uid())
  WITH CHECK (id = auth.uid());

-- Interdire aux utilisateurs clients de modifier directement id, legacy_user_id, email ou email_verified via PostgREST
REVOKE ALL ON public.profiles FROM anon, authenticated;
GRANT SELECT ON public.profiles TO authenticated;
GRANT UPDATE (prenom, nom, telephone, updated_at) ON public.profiles TO authenticated;

-- 3. Réservations / Billets (reservations) :
--    Un client authentifié ne voit QUE ses propres billets (UUID Supabase OU legacy_user_id rattaché à son profil).
--    Jamais d'accès client direct aux achats invités (user_id IS NULL) ni aux billets d'un autre client.
--    Aucune écriture directe autorisée depuis anon/authenticated : toute création, paiement, validation et transfert passe par le serveur Express.
DROP POLICY IF EXISTS reservations_select_own ON public.reservations;
CREATE POLICY reservations_select_own
  ON public.reservations
  FOR SELECT
  TO authenticated
  USING (
    user_id IS NOT NULL
    AND user_id <> ''
    AND (
      user_id = auth.uid()::text
      OR EXISTS (
        SELECT 1
        FROM public.profiles p
        WHERE p.id = auth.uid()
          AND p.legacy_user_id IS NOT NULL
          AND public.reservations.user_id = p.legacy_user_id
      )
    )
  );

REVOKE ALL ON public.reservations FROM anon, authenticated;
GRANT SELECT ON public.reservations TO authenticated;

-- 4. Transferts de billets (ticket_transfers) :
--    Un client ne peut lire que les transferts dont il est expéditeur ou destinataire.
DROP POLICY IF EXISTS ticket_transfers_select_own ON public.ticket_transfers;
CREATE POLICY ticket_transfers_select_own
  ON public.ticket_transfers
  FOR SELECT
  TO authenticated
  USING (
    from_user_id = auth.uid()::text
    OR to_user_id = auth.uid()::text
    OR EXISTS (
      SELECT 1
      FROM public.profiles p
      WHERE p.id = auth.uid()
        AND p.legacy_user_id IS NOT NULL
        AND (
          public.ticket_transfers.from_user_id = p.legacy_user_id
          OR public.ticket_transfers.to_user_id = p.legacy_user_id
        )
    )
  );

REVOKE ALL ON public.ticket_transfers FROM anon, authenticated;
GRANT SELECT ON public.ticket_transfers TO authenticated;

-- 5. Tables strictement serveur (aucune politique = refus total pour anon et authenticated)
REVOKE ALL ON public.users FROM anon, authenticated;
REVOKE ALL ON public.user_sessions FROM anon, authenticated;
REVOKE ALL ON public.user_tokens FROM anon, authenticated;
REVOKE ALL ON public.password_reset_grants FROM anon, authenticated;
REVOKE ALL ON public.auth_rate_limits FROM anon, authenticated;

-- 6. Empêcher l'exposition directe des colonnes sensibles ou l'auto-élévation même via SQL direct
-- (Rollback sécurisé : ne jamais supprimer RLS ni réactiver la récupération par numéro de commande + téléphone.)
