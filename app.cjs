// app.cjs — Point d'entrée pour Phusion Passenger (o2switch « Setup Node.js App »).
// Passenger charge le fichier de démarrage via require() : ce shim CommonJS importe le serveur ES Modules.
import('./src/server.js').catch((err) => {
  console.error('[TickWay] Échec du démarrage :', err);
  process.exit(1);
});
