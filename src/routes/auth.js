// src/routes/auth.js — Routes d'authentification Supabase Auth (/api/auth/*)
import { Router } from 'express';
import {
  attachPendingTransfersForVerifiedUser,
  authenticateAndMigrateLegacyUser,
  checkAndTouchRateLimit,
  clearPersistentRateLimit,
  consumePasswordResetGrant,
  getUserRawByEmail,
  issuePasswordResetGrant,
  normalizeEmail,
  revokeAllLegacyUserSessions,
  syncUserFromSupabase,
} from '../services/userStore.js';
import {
  getSupabasePublicConfig,
  supabaseRefreshSession,
  supabaseResendOtp,
  supabaseSendRecoveryOtp,
  supabaseSignInWithPassword,
  supabaseSignOut,
  supabaseSignUp,
  supabaseUpdateUserPassword,
  supabaseVerifyOtp,
} from '../services/supabaseAuth.js';
import { extractUserToken, requireUserAuth, resolveOptionalUserAuth } from '../middleware/auth.js';

const router = Router();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const OTP_RE = /^\d{6,8}$/;

function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || req.ip || 'unknown').split(',')[0].trim();
}

function sessionExpiryIso(sessionObj) {
  if (!sessionObj) return null;
  if (sessionObj.expires_at) {
    const ms = Number(sessionObj.expires_at) > 1e12 ? Number(sessionObj.expires_at) : Number(sessionObj.expires_at) * 1000;
    if (Number.isFinite(ms)) return new Date(ms).toISOString();
  }
  if (sessionObj.expires_in) {
    return new Date(Date.now() + Number(sessionObj.expires_in) * 1000).toISOString();
  }
  return null;
}

function isSupabaseRateLimitError(err) {
  return Boolean(err && (err.status === 429 || String(err.code || '').includes('rate_limit') || String(err.message || '').toLowerCase().includes('rate limit')));
}

function isSupabaseAlreadyExistsError(err) {
  const msg = String((err && err.message) || '').toLowerCase();
  const code = String((err && err.code) || '').toLowerCase();
  return err && (err.status === 422 || code.includes('user_already_exists') || msg.includes('already registered') || msg.includes('already exists'));
}

function isSupabaseEmailNotConfirmed(err) {
  const msg = String((err && err.message) || '').toLowerCase();
  const code = String((err && err.code) || '').toLowerCase();
  return code === 'email_not_confirmed' || msg.includes('email not confirmed');
}

// GET /api/auth/config — Configuration publique non sensible pour le client
router.get('/config', (req, res) => {
  return res.json({
    statut: 'ok',
    ...getSupabasePublicConfig(),
  });
});

// POST /api/auth/register — Création de compte via Supabase Auth + création du profil client
router.post('/register', async (req, res) => {
  const ipKey = `reg_ip_${clientIp(req)}`;
  const gate = await checkAndTouchRateLimit(ipKey, { maxAttempts: 8, windowMs: 15 * 60 * 1000, lockoutMs: 10 * 60 * 1000, increment: false });
  if (!gate.allowed) {
    return res.status(429).json({
      statut: 'erreur',
      message: `Trop de tentatives. Réessayez dans ${gate.remainingSec} seconde(s).`,
    });
  }

  try {
    const { prenom, nom, email, telephone, password } = req.body || {};
    const cleanPrenom = String(prenom || '').trim();
    const cleanNom = String(nom || '').trim();
    const cleanEmail = normalizeEmail(email);
    const cleanTel = String(telephone || '').trim();
    const cleanPwd = String(password || '');

    if (cleanPrenom.length < 2) {
      return res.status(400).json({ statut: 'erreur', message: 'Le prénom doit contenir au moins 2 caractères.' });
    }
    if (cleanNom.length < 2) {
      return res.status(400).json({ statut: 'erreur', message: 'Le nom doit contenir au moins 2 caractères.' });
    }
    if (!EMAIL_RE.test(cleanEmail)) {
      return res.status(400).json({ statut: 'erreur', message: 'Adresse e-mail invalide.' });
    }
    if (cleanPwd.length < 8) {
      return res.status(400).json({ statut: 'erreur', message: 'Le mot de passe doit contenir au moins 8 caractères.' });
    }

    const existingLegacy = await getUserRawByEmail(cleanEmail);
    if (existingLegacy) {
      await checkAndTouchRateLimit(ipKey, { maxAttempts: 8, windowMs: 15 * 60 * 1000, lockoutMs: 10 * 60 * 1000, increment: true });
      return res.status(409).json({
        statut: 'erreur',
        code: 'EMAIL_EXISTS',
        message: 'Un compte TickWay existe déjà avec cette adresse e-mail.',
      });
    }

    const supaRes = await supabaseSignUp({
      email: cleanEmail,
      password: cleanPwd,
      metadata: {
        prenom: cleanPrenom,
        nom: cleanNom,
        telephone: cleanTel,
      },
    });

    const supaUser = supaRes && (supaRes.user || (supaRes.id ? supaRes : null));
    if (!supaUser || !supaUser.id) {
      return res.status(502).json({ statut: 'erreur', message: 'Impossible de créer le compte sur le service d’authentification.' });
    }

    const user = await syncUserFromSupabase(supaUser, {
      allowEmailLink: false,
      profileInput: { prenom: cleanPrenom, nom: cleanNom, telephone: cleanTel },
    });

    await clearPersistentRateLimit(ipKey);

    const hasSession = Boolean(supaRes.access_token);
    if (!hasSession) {
      return res.status(201).json({
        statut: 'ok',
        needsEmailVerification: true,
        email: cleanEmail,
        user,
        message: 'Compte créé ! Saisissez le code envoyé à votre adresse e-mail par Supabase pour activer votre connexion.',
      });
    }

    return res.status(201).json({
      statut: 'ok',
      needsEmailVerification: !user.emailVerified,
      token: supaRes.access_token,
      refreshToken: supaRes.refresh_token || null,
      expiresAt: sessionExpiryIso(supaRes),
      user,
      message: 'Compte créé et connecté avec succès !',
    });
  } catch (err) {
    await checkAndTouchRateLimit(ipKey, { maxAttempts: 8, windowMs: 15 * 60 * 1000, lockoutMs: 10 * 60 * 1000, increment: true });
    if (isSupabaseAlreadyExistsError(err)) {
      return res.status(409).json({
        statut: 'erreur',
        code: 'EMAIL_EXISTS',
        message: 'Un compte TickWay existe déjà avec cette adresse e-mail.',
      });
    }
    if (isSupabaseRateLimitError(err)) {
      return res.status(429).json({ statut: 'erreur', message: 'Trop de demandes d’inscription. Patientez quelques minutes.' });
    }
    const status = err && err.status && err.status >= 400 && err.status < 500 ? err.status : 500;
    return res.status(status).json({
      statut: 'erreur',
      code: (err && err.code) || 'REGISTER_ERROR',
      message: (err && err.message) || 'Impossible de créer le compte.',
    });
  }
});

// POST /api/auth/login — Connexion e-mail + mot de passe via Supabase Auth (+ migration transparente des comptes historiques)
router.post('/login', async (req, res) => {
  const ip = clientIp(req);
  const emailNorm = normalizeEmail(req.body && req.body.email);
  const lockKey = `login_${ip}_${emailNorm || 'anon'}`;
  const gate = await checkAndTouchRateLimit(lockKey, { maxAttempts: 5, windowMs: 15 * 60 * 1000, lockoutMs: 10 * 60 * 1000, increment: false });
  if (!gate.allowed) {
    return res.status(429).json({
      statut: 'erreur',
      message: `Compte temporairement verrouillé après plusieurs échecs. Réessayez dans ${gate.remainingSec}s.`,
    });
  }

  const { email, password } = req.body || {};
  if (!EMAIL_RE.test(emailNorm) || !password) {
    return res.status(400).json({ statut: 'erreur', message: 'Adresse e-mail et mot de passe requis.' });
  }

  try {
    const signIn = await supabaseSignInWithPassword({ email: emailNorm, password });
    const supaUser = signIn && signIn.user;
    if (!signIn || !signIn.access_token || !supaUser) {
      const fail = await checkAndTouchRateLimit(lockKey, { maxAttempts: 5, windowMs: 15 * 60 * 1000, lockoutMs: 10 * 60 * 1000, increment: true });
      return res.status(401).json({
        statut: 'erreur',
        attemptsLeft: fail.attemptsLeft,
        message: 'Adresse e-mail ou mot de passe incorrect.',
      });
    }

    // Si compte historique non relié : vérifier qu'il ne s'agit pas d'un contournement sans preuve
    let user = await syncUserFromSupabase(supaUser, { allowEmailLink: false });
    if (!user) {
      // Compte historique existant pas encore lié à cet ID Supabase : vérifier que le mot de passe historique correspond ou forcer reset OTP
      const migratedCheck = await authenticateAndMigrateLegacyUser({ email: emailNorm, password });
      if (migratedCheck && migratedCheck.ok && migratedCheck.user) {
        user = migratedCheck.user;
      } else {
        await checkAndTouchRateLimit(lockKey, { maxAttempts: 5, windowMs: 15 * 60 * 1000, lockoutMs: 10 * 60 * 1000, increment: true });
        return res.status(409).json({
          statut: 'erreur',
          code: 'ACCOUNT_LINK_REQUIRED',
          message: 'Votre compte nécessite une confirmation de sécurité. Utilisez « Mot de passe oublié ? » pour recevoir un code par e-mail.',
        });
      }
    }

    await clearPersistentRateLimit(lockKey);
    return res.json({
      statut: 'ok',
      token: signIn.access_token,
      refreshToken: signIn.refresh_token || null,
      expiresAt: sessionExpiryIso(signIn),
      user,
    });
  } catch (err) {
    if (isSupabaseEmailNotConfirmed(err)) {
      return res.status(403).json({
        statut: 'erreur',
        code: 'EMAIL_CONFIRMATION_REQUIRED',
        needsEmailVerification: true,
        email: emailNorm,
        message: 'Votre adresse e-mail n’est pas encore vérifiée. Saisissez le code reçu par e-mail ou demandez un nouvel envoi.',
      });
    }

    // Tenter une migration sécurisée si l'utilisateur existait dans l'ancien système PBKDF2
    if (err && (err.status === 400 || err.status === 401)) {
      try {
        const migrated = await authenticateAndMigrateLegacyUser({ email: emailNorm, password });
        if (migrated && migrated.ok && migrated.session && migrated.user) {
          await clearPersistentRateLimit(lockKey);
          return res.json({
            statut: 'ok',
            token: migrated.session.access_token,
            refreshToken: migrated.session.refresh_token || null,
            expiresAt: sessionExpiryIso(migrated.session),
            user: migrated.user,
          });
        }
        if (migrated && migrated.reason === 'EMAIL_CONFIRMATION_REQUIRED') {
          await clearPersistentRateLimit(lockKey);
          return res.status(403).json({
            statut: 'erreur',
            code: 'EMAIL_CONFIRMATION_REQUIRED',
            needsEmailVerification: true,
            email: emailNorm,
            message: migrated.message,
          });
        }
        if (migrated && migrated.reason === 'SUPABASE_CONFLICT') {
          return res.status(409).json({
            statut: 'erreur',
            code: 'ACCOUNT_LINK_REQUIRED',
            message: migrated.message,
          });
        }
      } catch (migErr) {
        console.warn('[AUTH] Migration legacy au login :', migErr.message);
      }

      const fail = await checkAndTouchRateLimit(lockKey, { maxAttempts: 5, windowMs: 15 * 60 * 1000, lockoutMs: 10 * 60 * 1000, increment: true });
      return res.status(401).json({
        statut: 'erreur',
        attemptsLeft: fail.attemptsLeft,
        message: 'Adresse e-mail ou mot de passe incorrect.',
      });
    }

    if (isSupabaseRateLimitError(err)) {
      return res.status(429).json({ statut: 'erreur', message: 'Trop de tentatives. Réessayez dans quelques minutes.' });
    }
    return res.status(503).json({ statut: 'erreur', message: 'Service d’authentification temporairement indisponible.' });
  }
});

// POST /api/auth/refresh — Rafraîchissement sécurisé du jeton de session Supabase
router.post('/refresh', async (req, res) => {
  const refreshToken = String((req.body && req.body.refreshToken) || '').trim();
  if (refreshToken.length < 10) {
    return res.status(401).json({ statut: 'erreur', code: 'SESSION_EXPIREE', message: 'Session expirée.' });
  }
  try {
    const refreshed = await supabaseRefreshSession(refreshToken);
    if (!refreshed || !refreshed.access_token || !refreshed.user) {
      return res.status(401).json({ statut: 'erreur', code: 'SESSION_EXPIREE', message: 'Session expirée.' });
    }
    const user = await syncUserFromSupabase(refreshed.user, { allowEmailLink: false });
    if (!user) {
      return res.status(401).json({ statut: 'erreur', code: 'SESSION_EXPIREE', message: 'Session invalide.' });
    }
    return res.json({
      statut: 'ok',
      token: refreshed.access_token,
      refreshToken: refreshed.refresh_token || refreshToken,
      expiresAt: sessionExpiryIso(refreshed),
      user,
    });
  } catch {
    return res.status(401).json({ statut: 'erreur', code: 'SESSION_EXPIREE', message: 'Votre session a expiré. Veuillez vous reconnecter.' });
  }
});

// POST /api/auth/logout — Déconnexion (révoque la session Supabase côté serveur)
router.post('/logout', async (req, res) => {
  try {
    const token = extractUserToken(req);
    if (token) {
      await supabaseSignOut(token, 'local').catch(() => {});
    }
    return res.json({ statut: 'ok', message: 'Vous êtes déconnecté.' });
  } catch {
    return res.json({ statut: 'ok', message: 'Vous êtes déconnecté.' });
  }
});

// GET /api/auth/me — Session utilisateur courante (vérifiée côté serveur auprès de Supabase)
router.get('/me', requireUserAuth, async (req, res) => {
  return res.json({
    statut: 'ok',
    user: req.user,
    expiresAt: req.userSessionExpiresAt || null,
  });
});

// POST /api/auth/resend-verification — Renvoyer le code de confirmation d'inscription via Supabase
router.post('/resend-verification', resolveOptionalUserAuth, async (req, res) => {
  const email = normalizeEmail((req.user && req.user.email) || (req.body && req.body.email));
  if (!EMAIL_RE.test(email)) {
    return res.status(400).json({ statut: 'erreur', message: 'Adresse e-mail valide requise.' });
  }
  const rateKey = `verify_resend_${clientIp(req)}_${email}`;
  const gate = await checkAndTouchRateLimit(rateKey, { maxAttempts: 3, windowMs: 10 * 60 * 1000, lockoutMs: 5 * 60 * 1000, increment: true });
  if (!gate.allowed) {
    return res.status(429).json({
      statut: 'erreur',
      message: `Veuillez patienter ${gate.remainingSec}s avant de demander un autre code.`,
    });
  }

  try {
    await supabaseResendOtp({ email, type: 'signup' });
  } catch (err) {
    if (isSupabaseRateLimitError(err)) {
      return res.status(429).json({ statut: 'erreur', message: 'Veuillez patienter avant de demander un nouvel envoi.' });
    }
  }
  return res.json({
    statut: 'ok',
    message: 'Si cette adresse est en attente de confirmation, un code vient d’être renvoyé.',
  });
});

// POST /api/auth/verify-email — Vérification OTP d'inscription (type: signup) via Supabase Auth
router.post('/verify-email', resolveOptionalUserAuth, async (req, res) => {
  const ip = clientIp(req);
  const emailInput = normalizeEmail((req.body && req.body.email) || (req.user && req.user.email));
  const code = String((req.body && req.body.code) || '').replace(/\s+/g, '');

  if (!EMAIL_RE.test(emailInput)) {
    return res.status(400).json({ statut: 'erreur', message: 'Adresse e-mail valide requise.' });
  }
  if (!OTP_RE.test(code)) {
    return res.status(400).json({ statut: 'erreur', message: 'Saisissez le code reçu par e-mail (6 à 8 chiffres).' });
  }

  const lockKey = `verify_signup_${ip}_${emailInput}`;
  const gate = await checkAndTouchRateLimit(lockKey, { maxAttempts: 5, windowMs: 15 * 60 * 1000, lockoutMs: 10 * 60 * 1000, increment: false });
  if (!gate.allowed) {
    return res.status(429).json({
      statut: 'erreur',
      message: `Trop de tentatives incorrectes. Réessayez dans ${gate.remainingSec}s.`,
    });
  }

  try {
    const verified = await supabaseVerifyOtp({ email: emailInput, token: code, type: 'signup' });
    if (!verified || !verified.user) {
      await checkAndTouchRateLimit(lockKey, { maxAttempts: 5, windowMs: 15 * 60 * 1000, lockoutMs: 10 * 60 * 1000, increment: true });
      return res.status(400).json({ statut: 'erreur', message: 'Code de vérification invalide ou expiré.' });
    }

    await clearPersistentRateLimit(lockKey);
    const user = await syncUserFromSupabase(verified.user, { allowEmailLink: true });
    const attached = user ? await attachPendingTransfersForVerifiedUser(user) : [];

    return res.json({
      statut: 'ok',
      token: verified.access_token || null,
      refreshToken: verified.refresh_token || null,
      expiresAt: sessionExpiryIso(verified),
      user,
      attachedTransferCount: attached.length,
      message: attached.length > 0
        ? `Adresse e-mail vérifiée ! ${attached.length} billet(s) transféré(s) rattaché(s) à votre compte.`
        : 'Adresse e-mail vérifiée avec succès !',
    });
  } catch (err) {
    await checkAndTouchRateLimit(lockKey, { maxAttempts: 5, windowMs: 15 * 60 * 1000, lockoutMs: 10 * 60 * 1000, increment: true });
    return res.status(400).json({
      statut: 'erreur',
      message: 'Code de vérification invalide ou expiré.',
    });
  }
});

// POST /api/auth/forgot-password — Étape 1 : déclenche l'envoi du code OTP de récupération Supabase (réponse neutre anti-énumération)
router.post('/forgot-password', async (req, res) => {
  const email = normalizeEmail(req.body && req.body.email);
  if (!EMAIL_RE.test(email)) {
    return res.status(400).json({ statut: 'erreur', message: 'Veuillez saisir une adresse e-mail valide.' });
  }

  const ip = clientIp(req);
  const [ipGate, emailGate] = await Promise.all([
    checkAndTouchRateLimit(`forgot_ip_${ip}`, { maxAttempts: 10, windowMs: 15 * 60 * 1000, lockoutMs: 10 * 60 * 1000, increment: true }),
    checkAndTouchRateLimit(`forgot_email_${email}`, { maxAttempts: 3, windowMs: 10 * 60 * 1000, lockoutMs: 5 * 60 * 1000, increment: true }),
  ]);

  if (!ipGate.allowed || !emailGate.allowed) {
    const remainingSec = Math.max(ipGate.remainingSec || 0, emailGate.remainingSec || 0);
    return res.status(429).json({
      statut: 'erreur',
      message: `Trop de demandes. Réessayez dans ${remainingSec}s.`,
    });
  }

  const neutralMessage = 'Si un compte TickWay correspond à cette adresse e-mail, un code de réinitialisation à usage unique vient d’y être envoyé.';
  try {
    await supabaseSendRecoveryOtp(email);
    return res.json({ statut: 'ok', message: neutralMessage });
  } catch (err) {
    if (isSupabaseRateLimitError(err)) {
      return res.status(429).json({
        statut: 'erreur',
        message: 'Veuillez patienter quelques instants avant de redemander un code.',
      });
    }
    // Ne jamais révéler si l'adresse e-mail existe ou non
    return res.json({ statut: 'ok', message: neutralMessage });
  }
});

// POST /api/auth/verify-reset-code — Étape 2 : vérifie l'OTP avec Supabase (type: 'recovery') sans ouvrir de session billets
router.post('/verify-reset-code', async (req, res) => {
  const ip = clientIp(req);
  const email = normalizeEmail(req.body && req.body.email);
  const code = String((req.body && req.body.code) || '').replace(/\s+/g, '');

  if (!EMAIL_RE.test(email) || !OTP_RE.test(code)) {
    return res.status(400).json({
      statut: 'erreur',
      message: 'Veuillez saisir votre adresse e-mail et le code à 6 chiffres reçu par e-mail.',
    });
  }

  const ipEmailKey = `verify_reset_ipe_${ip}_${email}`;
  const emailGlobalKey = `verify_reset_email_${email}`;
  const [g1, g2] = await Promise.all([
    checkAndTouchRateLimit(ipEmailKey, { maxAttempts: 5, windowMs: 15 * 60 * 1000, lockoutMs: 15 * 60 * 1000, increment: false }),
    checkAndTouchRateLimit(emailGlobalKey, { maxAttempts: 8, windowMs: 15 * 60 * 1000, lockoutMs: 15 * 60 * 1000, increment: false }),
  ]);

  if (!g1.allowed || !g2.allowed) {
    const wait = Math.max(g1.remainingSec || 0, g2.remainingSec || 0);
    return res.status(429).json({
      statut: 'erreur',
      message: `Trop de tentatives incorrectes. Réessayez dans ${wait}s.`,
    });
  }

  try {
    const verified = await supabaseVerifyOtp({ email, token: code, type: 'recovery' });
    if (!verified || !verified.access_token || !verified.user || !verified.user.id) {
      await Promise.all([
        checkAndTouchRateLimit(ipEmailKey, { maxAttempts: 5, windowMs: 15 * 60 * 1000, lockoutMs: 15 * 60 * 1000, increment: true }),
        checkAndTouchRateLimit(emailGlobalKey, { maxAttempts: 8, windowMs: 15 * 60 * 1000, lockoutMs: 15 * 60 * 1000, increment: true }),
      ]);
      return res.status(400).json({
        statut: 'erreur',
        message: 'Code de réinitialisation invalide, expiré ou déjà utilisé.',
      });
    }

    await Promise.all([
      clearPersistentRateLimit(ipEmailKey),
      clearPersistentRateLimit(emailGlobalKey),
    ]);

    const grant = await issuePasswordResetGrant({
      supabaseUserId: verified.user.id,
      email,
      recoveryAccessToken: verified.access_token,
    });

    // Ne jamais renvoyer verified.access_token au frontend : aucun accès compte avant validation du nouveau mot de passe
    return res.json({
      statut: 'ok',
      resetToken: grant.resetToken,
      expiresAt: grant.expiresAt,
      expiresInSeconds: grant.expiresInSeconds,
      message: 'Code vérifié. Définissez maintenant votre nouveau mot de passe.',
    });
  } catch (err) {
    await Promise.all([
      checkAndTouchRateLimit(ipEmailKey, { maxAttempts: 5, windowMs: 15 * 60 * 1000, lockoutMs: 15 * 60 * 1000, increment: true }),
      checkAndTouchRateLimit(emailGlobalKey, { maxAttempts: 8, windowMs: 15 * 60 * 1000, lockoutMs: 15 * 60 * 1000, increment: true }),
    ]);
    if (isSupabaseRateLimitError(err)) {
      return res.status(429).json({ statut: 'erreur', message: 'Trop de tentatives. Réessayez dans quelques minutes.' });
    }
    return res.status(400).json({
      statut: 'erreur',
      message: 'Code de réinitialisation invalide, expiré ou déjà utilisé.',
    });
  }
});

// POST /api/auth/reset-password — Étape 3 : enregistre le nouveau mot de passe sur Supabase Auth et révoque les anciennes sessions
router.post('/reset-password', async (req, res) => {
  const ipKey = `reset_pwd_ip_${clientIp(req)}`;
  const gate = await checkAndTouchRateLimit(ipKey, { maxAttempts: 10, windowMs: 15 * 60 * 1000, lockoutMs: 10 * 60 * 1000, increment: false });
  if (!gate.allowed) {
    return res.status(429).json({
      statut: 'erreur',
      message: `Trop de tentatives. Réessayez dans ${gate.remainingSec}s.`,
    });
  }

  const { resetToken, newPassword } = req.body || {};
  const cleanNew = String(newPassword || '');
  if (!resetToken || typeof resetToken !== 'string') {
    return res.status(400).json({
      statut: 'erreur',
      message: 'Vérifiez d’abord votre code de réinitialisation envoyé par e-mail.',
    });
  }
  if (cleanNew.length < 8) {
    return res.status(400).json({
      statut: 'erreur',
      message: 'Le nouveau mot de passe doit contenir au moins 8 caractères.',
    });
  }

  const grant = await consumePasswordResetGrant(resetToken);
  if (!grant) {
    await checkAndTouchRateLimit(ipKey, { maxAttempts: 10, windowMs: 15 * 60 * 1000, lockoutMs: 10 * 60 * 1000, increment: true });
    return res.status(400).json({
      statut: 'erreur',
      message: 'Session de réinitialisation expirée ou déjà utilisée. Demandez un nouveau code.',
    });
  }

  try {
    const updatedSupaUser = await supabaseUpdateUserPassword(grant.recoveryAccessToken, cleanNew);
    await supabaseSignOut(grant.recoveryAccessToken, 'global').catch(() => {});

    const supaUserObj = (updatedSupaUser && updatedSupaUser.id)
      ? updatedSupaUser
      : { id: grant.supabaseUserId, email: grant.email, email_confirmed_at: new Date().toISOString() };

    const synced = await syncUserFromSupabase(supaUserObj, {
      allowEmailLink: true,
      wipeLegacyPassword: true,
    });
    if (synced) {
      await revokeAllLegacyUserSessions(synced);
    }

    await clearPersistentRateLimit(ipKey);
    return res.json({
      statut: 'ok',
      message: 'Mot de passe réinitialisé avec succès. Connectez-vous avec votre nouveau mot de passe.',
    });
  } catch (err) {
    return res.status(400).json({
      statut: 'erreur',
      message: (err && err.message) || 'Impossible de mettre à jour le mot de passe. Demandez un nouveau code.',
    });
  }
});

// POST /api/auth/change-password — Changement de mot de passe depuis « Mon compte » (vérification préalable du mot de passe actuel)
router.post('/change-password', requireUserAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  const cleanCurrent = String(currentPassword || '');
  const cleanNew = String(newPassword || '');

  if (!cleanCurrent || cleanNew.length < 8) {
    return res.status(400).json({
      statut: 'erreur',
      message: 'Mot de passe actuel et nouveau mot de passe (min. 8 caractères) requis.',
    });
  }

  const lockKey = `chgpwd_${req.user.id}`;
  const gate = await checkAndTouchRateLimit(lockKey, { maxAttempts: 5, windowMs: 15 * 60 * 1000, lockoutMs: 10 * 60 * 1000, increment: false });
  if (!gate.allowed) {
    return res.status(429).json({
      statut: 'erreur',
      message: `Trop de tentatives. Réessayez dans ${gate.remainingSec}s.`,
    });
  }

  try {
    const verifiedSignIn = await supabaseSignInWithPassword({
      email: req.user.email,
      password: cleanCurrent,
    });
    if (!verifiedSignIn || !verifiedSignIn.access_token) {
      await checkAndTouchRateLimit(lockKey, { maxAttempts: 5, windowMs: 15 * 60 * 1000, lockoutMs: 10 * 60 * 1000, increment: true });
      return res.status(400).json({ statut: 'erreur', message: 'Mot de passe actuel incorrect.' });
    }

    await supabaseUpdateUserPassword(verifiedSignIn.access_token, cleanNew);
    await clearPersistentRateLimit(lockKey);

    const freshSession = await supabaseSignInWithPassword({
      email: req.user.email,
      password: cleanNew,
    }).catch(() => verifiedSignIn);

    return res.json({
      statut: 'ok',
      token: freshSession.access_token,
      refreshToken: freshSession.refresh_token || null,
      expiresAt: sessionExpiryIso(freshSession),
      message: 'Mot de passe mis à jour avec succès.',
    });
  } catch (err) {
    await checkAndTouchRateLimit(lockKey, { maxAttempts: 5, windowMs: 15 * 60 * 1000, lockoutMs: 10 * 60 * 1000, increment: true });
    return res.status(400).json({
      statut: 'erreur',
      message: 'Mot de passe actuel incorrect ou nouveau mot de passe non valide.',
    });
  }
});

export default router;
