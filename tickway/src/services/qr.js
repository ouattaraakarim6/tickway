// src/services/qr.js — Génération de QR codes côté serveur
import QRCode from 'qrcode';

/**
 * Génère un QR code en tant que Buffer PNG.
 * @param {string} text — Le texte à encoder (la référence du billet).
 * @returns {Promise<Buffer>} — Image PNG du QR code.
 */
export async function generateQR(text) {
  return QRCode.toBuffer(text, {
    type: 'png',
    width: 300,
    margin: 2,
    color: { dark: '#1b1f24', light: '#ffffff' },
    errorCorrectionLevel: 'M',
  });
}

/**
 * Génère un QR code en Data URL (base64) pour affichage direct côté front.
 * @param {string} text — Le texte à encoder (la référence du billet).
 * @returns {Promise<string>} — Data URL string (ex: data:image/png;base64,...).
 */
export async function generateQRDataUrl(text) {
  return QRCode.toDataURL(text, {
    width: 300,
    margin: 2,
    color: { dark: '#1b1f24', light: '#ffffff' },
    errorCorrectionLevel: 'M',
  });
}
