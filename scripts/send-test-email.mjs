// scripts/send-test-email.mjs — Envoie un billet d'exemple pour vérifier la configuration SMTP o2switch.
// Usage : npm run mail:test -- destinataire@example.com
import 'dotenv/config';
import { sendTicketEmail, isEmailConfigured } from '../src/services/email.js';

const to = String(process.argv[2] || '').trim();
if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(to)) {
  console.error('Usage : npm run mail:test -- destinataire@example.com');
  process.exit(1);
}
if (!isEmailConfigured()) {
  console.error('SMTP non configuré : renseignez SMTP_HOST, SMTP_USER et SMTP_PASS dans le .env.');
  process.exit(1);
}

const site = String(process.env.APP_URL || 'https://tick-way.com').replace(/\/$/, '');
const ref = 'TW-TEST-MAIL';
try {
  await sendTicketEmail({
    to,
    reservation: {
      reference: ref,
      prenom: 'Test',
      nom: 'TickWay',
      email: to,
      event_nom: 'Billet de test (non valable)',
      event_date: new Date().toLocaleDateString('fr-FR'),
      zone: 'Test',
      point_relais: 'Vérification SMTP',
      montant: 0,
      mode_paiement: 'Test',
      ticketsUrl: site,
      tickets: [{ reference: ref, qrText: `${site}/#controle?c=${ref}` }],
    },
  });
  console.log('E-mail de test envoyé. Vérifiez la boîte de réception (et les spams).');
} catch (err) {
  console.error(`Échec de l'envoi SMTP : ${err.message}`);
  process.exit(1);
}
