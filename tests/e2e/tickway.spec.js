// tests/e2e/tickway.spec.js — Parcours principaux : accueil, réservation + paiement, espace équipe, dashboard fondateur
import 'dotenv/config';
import { test, expect } from '@playwright/test';
import mysql from 'mysql2/promise';

// Base et mot de passe fondateur de test définis par playwright.config.js
const DB_URL = process.env.E2E_DATABASE_URL;
const FOUNDER_PASSWORD = process.env.E2E_FOUNDER_PASSWORD;
const TEST_EMAIL = 'e2e-playwright@example.com';

let db;

function randomRef() {
  const a = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  let s = '';
  for (let i = 0; i < 8; i++) s += a[Math.floor(Math.random() * a.length)];
  return `TW-${s.slice(0, 4)}-${s.slice(4)}`;
}

test.beforeAll(async () => {
  db = await mysql.createConnection({ uri: DB_URL, timezone: 'Z' });
  await db.query('DELETE FROM reservations WHERE email = ?', [TEST_EMAIL]);
  await db.query("DELETE FROM equipes WHERE nom LIKE 'E2E %'");
});

test.afterAll(async () => {
  await db.query('DELETE FROM reservations WHERE email = ?', [TEST_EMAIL]);
  await db.query("DELETE FROM equipes WHERE nom LIKE 'E2E %'");
  await db.end();
});

// Le front appelle l'API sur :3000 en local : on le redirige vers le serveur de test
test.beforeEach(async ({ page, baseURL }) => {
  await page.addInitScript((api) => {
    try { localStorage.setItem('tickway_api_url', api); } catch { /* ignore */ }
    window.__tickwayNoRedirect = true; // pas de redirection vers le hub de paiement
  }, baseURL);
});

test("la page d'accueil se charge sans erreur et liste les événements", async ({ page }) => {
  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });

  await page.goto('/');
  await expect(page).toHaveTitle(/TickWay/i);
  await expect(page.locator('#evs [data-ev]').first()).toBeVisible();
  expect(await page.locator('#evs [data-ev]').count()).toBeGreaterThan(0);

  // Erreurs liées aux ressources externes (CDN, images) ignorées : seules les erreurs applicatives comptent
  const appErrors = errors.filter((e) => !/Failed to load resource|net::ERR/i.test(e));
  expect(appErrors).toEqual([]);
});

test('réservation complète : formulaire → paiement (mock) → billets confirmés en base MySQL', async ({ page }) => {
  await page.goto('/#reserver');

  // Étape 1 : informations
  await page.fill('input[name="pr"]', 'Awa');
  await page.fill('input[name="nm"]', 'Playwright');
  await page.fill('input[name="tel"]', '0700000099');
  await page.fill('input[name="ml"]', TEST_EMAIL);
  await page.click('#nx');

  // Étape 2 : événement + 2 billets
  await page.locator('#eo .opt[data-id="k"]').click();
  await page.locator('#qtyBtns .qty-btn[data-q="2"]').click();
  await page.click('#nx');

  // Étape 3 : point relais
  await page.locator('#ro .opt').first().click();
  await page.click('#nx');

  // Étape 4 : paiement
  await expect(page.locator('#nx')).toContainText('Payer');
  const initResp = page.waitForResponse((r) => r.url().includes('/api/payments/paysecurehub/init'));
  await page.click('#nx');
  const init = await (await initResp).json();
  expect(init.statut).toBe('en_attente');
  expect(init.references).toHaveLength(2);
  await expect(page.locator('#waveWait')).toBeVisible();

  const [pending] = await db.query('SELECT statut FROM reservations WHERE commande_id = ?', [init.commandeId]);
  expect(pending.map((r) => r.statut)).toEqual(['en_attente', 'en_attente']);

  // Le faux hub confirme le paiement
  await page.click('#waveDone');
  await expect(page.locator('#dn')).toBeVisible();
  await expect(page.locator('#dn')).toContainText(init.references[0]);

  const [paid] = await db.query('SELECT statut FROM reservations WHERE commande_id = ?', [init.commandeId]);
  expect(paid.map((r) => r.statut)).toEqual(['valide', 'valide']);
  const [[tx]] = await db.query('SELECT statut, email_sent FROM payment_transactions WHERE commande_id = ?', [init.commandeId]);
  expect(tx.statut).toBe('paye');
});

test('espace équipe : connexion par clé, billet validé (VERT) puis refusé au 2e scan (ORANGE)', async ({ page, request }) => {
  test.skip(!FOUNDER_PASSWORD, 'E2E_FOUNDER_PASSWORD absent');

  // Création d'une équipe dédiée via l'API fondateur (clé en clair renvoyée une seule fois)
  const login = await request.post('/api/founder/login', { data: { password: FOUNDER_PASSWORD } });
  expect(login.ok()).toBeTruthy();
  const { token } = await login.json();
  const created = await request.post('/api/founder/teams', {
    headers: { 'X-Founder-Token': token },
    data: { nom: 'E2E Equipe Scan', eventIds: ['*'] },
  });
  const { plainKey } = await created.json();

  // Billet de test payé
  const ref = randomRef();
  await db.query(
    `INSERT INTO reservations (reference, commande_id, prenom, nom, telephone, email, event_id, event_nom, event_date, zone, point_relais, montant, mode_paiement, statut)
     VALUES (?, ?, 'Koffi', 'Scan', '0700000098', ?, 'k', 'Kiff No Beat', 'Sam. 28 novembre 2026', 'Abidjan Nord', 'Yopougon, Cosmos', 6000, 'Wave', 'valide')`,
    [ref, `CMD-E2E${Date.now().toString(36).toUpperCase().slice(-6)}`, TEST_EMAIL]
  );

  await page.goto('/#controle');
  await page.fill('#teamAgentIn', 'Agent E2E');
  await page.fill('#teamKeyIn', plainKey);
  await page.click('#teamLoginBtn');
  await expect(page.locator('#teamWorkspaceView')).toBeVisible();
  await expect(page.locator('#teamNameBadge')).toContainText('E2E Equipe Scan');

  await page.fill('#codeIn', ref);
  await page.click('#codeBtn');
  await expect(page.locator('#res')).toContainText(/ENTRÉE AUTORISÉE|VALIDE/i);

  await page.fill('#codeIn', ref);
  await page.click('#codeBtn');
  await expect(page.locator('#res')).toContainText(/DÉJÀ UTILISÉ/i);

  const [[row]] = await db.query('SELECT statut, agent_id FROM reservations WHERE reference = ?', [ref]);
  expect(row.statut).toBe('utilise');
  expect(row.agent_id).toBe('Agent E2E');
  const [[scans]] = await db.query('SELECT COUNT(*) AS n FROM scans_log WHERE reference = ?', [ref]);
  expect(Number(scans.n)).toBe(2);
});

test('dashboard fondateur : refus du mauvais mot de passe, connexion, création et suppression d\'une équipe', async ({ page }) => {
  test.skip(!FOUNDER_PASSWORD, 'E2E_FOUNDER_PASSWORD absent');
  page.on('dialog', (d) => d.accept());

  await page.goto('/#fondateur');
  await expect(page.locator('#founderLoginCard')).toBeVisible();

  await page.fill('#fdLoginPass', 'mauvais-mot-de-passe');
  await page.click('#fdLoginBtn');
  await expect(page.locator('#fdLoginErr')).toBeVisible();

  await page.fill('#fdLoginPass', FOUNDER_PASSWORD);
  await page.click('#fdLoginBtn');
  await expect(page.locator('#founderDashboardView')).toBeVisible();
  await expect(page.locator('#fdOverviewCards')).not.toBeEmpty();

  await page.fill('#fdNewTeamName', 'E2E Equipe Dashboard');
  await page.click('#fdCreateTeamBtn');
  await expect(page.locator('#fdNewKeyBanner')).toContainText('TW-TEAM-');
  const [[team]] = await db.query("SELECT id FROM equipes WHERE nom = 'E2E Equipe Dashboard'");
  expect(team).toBeTruthy();

  await expect(page.locator(`[data-team-del="${team.id}"]`)).toBeVisible();
  await page.locator(`[data-team-del="${team.id}"]`).click();
  await expect.poll(async () => {
    const [rows] = await db.query('SELECT id FROM equipes WHERE id = ?', [team.id]);
    return rows.length;
  }).toBe(0);
});
