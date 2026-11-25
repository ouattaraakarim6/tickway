// playwright.config.js — Tests de bout en bout TickWay (MySQL Laragon + faux PaySecureHub local)
import 'dotenv/config';
import { defineConfig, devices } from '@playwright/test';

import crypto from 'node:crypto';

const APP_PORT = Number(process.env.E2E_PORT) || 3100;
const MOCK_PORT = Number(process.env.MOCK_PSH_PORT) || 3999;

// Base de test dédiée : la base de travail « tickway » et le vrai mot de passe fondateur ne sont jamais utilisés
const baseDbUrl = new URL(process.env.DATABASE_URL || 'mysql://root:@127.0.0.1:3306/tickway');
baseDbUrl.pathname = '/tickway_e2e';
process.env.E2E_DATABASE_URL = baseDbUrl.toString();
// Mot de passe fondateur de test, stable entre les exécutions, dérivé du secret local (jamais écrit en clair)
process.env.E2E_FOUNDER_PASSWORD = 'e2e-' + crypto
  .createHmac('sha256', String(process.env.APP_SECRET || 'e2e-local')).update('e2e-founder').digest('hex').slice(0, 24);

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  use: {
    baseURL: `http://localhost:${APP_PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: [
    {
      command: 'node tests/e2e/mock-paysecurehub.mjs',
      url: `http://127.0.0.1:${MOCK_PORT}/health`,
      reuseExistingServer: false,
      env: { MOCK_PSH_PORT: String(MOCK_PORT) },
    },
    {
      command: 'node src/server.js',
      url: `http://localhost:${APP_PORT}/api/founder/status`,
      reuseExistingServer: false,
      env: {
        PORT: String(APP_PORT),
        NODE_ENV: 'development',
        DATABASE_URL: process.env.E2E_DATABASE_URL,
        FOUNDER_AUTH_SALT: '',
        FOUNDER_AUTH_HASH: '',
        FOUNDER_PASSWORD: process.env.E2E_FOUNDER_PASSWORD,
        PAYSECUREHUB_API_KEY: 'e2e_fake_key',
        PAYSECUREHUB_MERCHANT_ID: 'e2e_fake_merchant',
        PAYSECUREHUB_BASE_URL: `http://127.0.0.1:${MOCK_PORT}`,
        // Aucun e-mail réel n'est envoyé pendant les tests
        SMTP_HOST: '',
        SMTP_USER: '',
        SMTP_PASS: '',
      },
    },
  ],
});
