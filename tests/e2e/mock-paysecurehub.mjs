// tests/e2e/mock-paysecurehub.mjs — Faux PaySecureHub local pour les tests (aucun appel réseau externe).
// Toute commande est considérée comme payée dès qu'elle est interrogée via /api/airtime/status/transact.
import http from 'node:http';

const PORT = Number(process.env.MOCK_PSH_PORT) || 3999;
const amounts = new Map();

function readJson(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); } catch { resolve({}); }
    });
  });
}

function send(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/api/payhub-ws/build-away') {
    const body = await readJson(req);
    amounts.set(body.code_paiement, Number(body.montant) || 0);
    // Redirige directement vers l'URL de retour, comme si l'utilisateur avait payé sur le hub
    return send(res, 200, { code: 200, tokens: `mock-${body.code_paiement}`, url: body.Url_Retour });
  }
  if (req.method === 'POST' && req.url === '/api/airtime/status/transact') {
    const body = await readJson(req);
    const amount = amounts.get(body.codePaiement);
    if (amount === undefined) return send(res, 200, { code: 404, message: 'Transaction inconnue' });
    return send(res, 200, {
      code: 200,
      payments: [{ state: 'SUCCESS', transactionId: `TX-${body.codePaiement}`, serviceName: 'Wave CI (mock)', amount, fees: 0 }],
    });
  }
  if (req.url === '/health') return send(res, 200, { ok: true });
  return send(res, 404, { code: 404 });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Mock PaySecureHub sur http://127.0.0.1:${PORT}`);
});
