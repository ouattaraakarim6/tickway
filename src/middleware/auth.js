// src/middleware/auth.js — Authentification par clé API pour l'équipe terrain
export function requireApiKey(req, res, next) {
  const key = req.headers['x-api-key'];
  const expectedKey = process.env.VALIDATE_API_KEY || 'cle_secrete_equipe_terrain_2026';
  if (!key || key !== expectedKey) {
    return res.status(401).json({
      statut: 'erreur',
      message: "Clé d'API invalide ou manquante. Ajoutez l'en-tête X-Api-Key.",
    });
  }
  next();
}
