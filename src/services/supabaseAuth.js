// src/services/supabaseAuth.js — Client officiel Supabase Auth (GoTrue REST) exclusivement côté serveur
const DEFAULT_SUPABASE_URL = 'https://vuahvbyianddnoapccpp.supabase.co';
const DEFAULT_SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_u9CrvJ6nEv9FAq0g_fHuIg_pjSi_Fvm';

export function getSupabaseUrl() {
  return String(process.env.SUPABASE_URL || DEFAULT_SUPABASE_URL).trim().replace(/\/$/, '');
}

export function getSupabasePublishableKey() {
  return String(
    process.env.SUPABASE_PUBLISHABLE_KEY
    || process.env.SUPABASE_ANON_KEY
    || DEFAULT_SUPABASE_PUBLISHABLE_KEY
  ).trim();
}

export function getSupabaseSecretKey() {
  // Strictement côté serveur : jamais renvoyée dans les réponses HTTP ou au frontend
  return String(
    process.env.SUPABASE_SECRET_KEY
    || process.env.SUPABASE_SERVICE_ROLE_KEY
    || ''
  ).trim();
}

export function hasSupabaseAdminKey() {
  return Boolean(getSupabaseSecretKey());
}

export function getSupabasePublicConfig() {
  return {
    supabaseUrl: getSupabaseUrl(),
    supabasePublishableKey: getSupabasePublishableKey(),
  };
}

function buildAuthError(status, payload, fallbackMessage) {
  const code = String(
    (payload && (payload.error_code || payload.code || payload.error))
    || 'SUPABASE_AUTH_ERROR'
  );
  const rawMsg = String(
    (payload && (payload.msg || payload.message || payload.error_description || payload.error))
    || fallbackMessage
    || 'Erreur d’authentification.'
  );
  const err = new Error(rawMsg);
  err.status = status || 500;
  err.code = code;
  err.payload = payload || null;
  return err;
}

async function supabaseAuthRequest(path, { method = 'GET', body = null, bearerToken = '', useAdmin = false } = {}) {
  const url = `${getSupabaseUrl()}${path}`;
  const adminKey = useAdmin ? getSupabaseSecretKey() : '';
  if (useAdmin && !adminKey) {
    throw buildAuthError(500, null, 'Clé serveur Supabase absente.');
  }

  const apiKey = adminKey || getSupabasePublishableKey();
  const headers = {
    apikey: apiKey,
    Accept: 'application/json',
  };
  if (bearerToken) {
    headers.Authorization = `Bearer ${bearerToken}`;
  } else if (adminKey) {
    headers.Authorization = `Bearer ${adminKey}`;
  }
  if (body !== null && body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  const resp = await fetch(url, {
    method,
    headers,
    body: body !== null && body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10000),
  });

  const text = await resp.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { message: text || 'Réponse invalide du serveur d’authentification.' };
  }

  if (!resp.ok) {
    throw buildAuthError(resp.status, data, 'Échec de l’opération d’authentification.');
  }
  return data;
}

export async function supabaseSignUp({ email, password, metadata = {} }) {
  return supabaseAuthRequest('/auth/v1/signup', {
    method: 'POST',
    body: {
      email,
      password,
      data: metadata,
    },
  });
}

export async function supabaseSignInWithPassword({ email, password }) {
  return supabaseAuthRequest('/auth/v1/token?grant_type=password', {
    method: 'POST',
    body: { email, password },
  });
}

export async function supabaseRefreshSession(refreshToken) {
  return supabaseAuthRequest('/auth/v1/token?grant_type=refresh_token', {
    method: 'POST',
    body: { refresh_token: String(refreshToken || '').trim() },
  });
}

export async function supabaseGetUser(accessToken) {
  const token = String(accessToken || '').trim();
  if (!token || token.length < 16) {
    throw buildAuthError(401, { code: 'INVALID_TOKEN' }, 'Jeton manquant.');
  }
  return supabaseAuthRequest('/auth/v1/user', {
    method: 'GET',
    bearerToken: token,
  });
}

export async function supabaseSignOut(accessToken, scope = 'local') {
  const token = String(accessToken || '').trim();
  if (!token) return;
  const cleanScope = ['global', 'local', 'others'].includes(scope) ? scope : 'local';
  await supabaseAuthRequest(`/auth/v1/logout?scope=${cleanScope}`, {
    method: 'POST',
    bearerToken: token,
    body: {},
  });
}

export async function supabaseSendRecoveryOtp(email) {
  return supabaseAuthRequest('/auth/v1/recover', {
    method: 'POST',
    body: { email },
  });
}

export async function supabaseVerifyOtp({ email, token, type = 'recovery' }) {
  return supabaseAuthRequest('/auth/v1/verify', {
    method: 'POST',
    body: {
      email,
      token: String(token || '').trim(),
      type,
    },
  });
}

export async function supabaseResendOtp({ email, type = 'signup' }) {
  return supabaseAuthRequest('/auth/v1/resend', {
    method: 'POST',
    body: { email, type },
  });
}

export async function supabaseUpdateUserPassword(accessToken, newPassword) {
  return supabaseAuthRequest('/auth/v1/user', {
    method: 'PUT',
    bearerToken: accessToken,
    body: { password: newPassword },
  });
}

export async function supabaseUpdateUserMetadata(accessToken, metadata) {
  return supabaseAuthRequest('/auth/v1/user', {
    method: 'PUT',
    bearerToken: accessToken,
    body: { data: metadata },
  });
}

export async function supabaseAdminCreateUser({ email, password, emailConfirm = false, userMetadata = {} }) {
  return supabaseAuthRequest('/auth/v1/admin/users', {
    method: 'POST',
    useAdmin: true,
    body: {
      email,
      password,
      email_confirm: Boolean(emailConfirm),
      user_metadata: userMetadata,
    },
  });
}
