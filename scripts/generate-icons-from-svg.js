// Generate PWA icons matching the StreamVault splash screen:
// Red Shield emblem (#E50914) on void black (#080808) background
const sharp = require('sharp');
const path = require('path');

function buildShieldSVG(size) {
  // Shield icon matching the splash screen's Lucide Shield + red color
  // Lucide shield path, scaled and centered in the canvas
  const padding = Math.round(size * 0.15);
  const inner = size - padding * 2;
  const bgRadius = Math.round(size * 0.22);

  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="${size}" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="#0a0a0a"/>
      <stop offset="100%" stop-color="#060606"/>
    </linearGradient>
  </defs>
  <!-- Void black background with rounded corners -->
  <rect width="${size}" height="${size}" rx="${bgRadius}" ry="${bgRadius}" fill="url(#bg)"/>
  <!-- Red Shield emblem — Lucide Shield path, centered -->
  <g transform="translate(${padding}, ${padding}) scale(${inner / 24})">
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"
          fill="none" stroke="#E50914" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
  </g>
</svg>`;
}

function buildMaskableSVG(size) {
  // Maskable: same shield but with extra safe zone padding
  const safePad = Math.round(size * 0.10);
  const inner = size - safePad * 2;
  const bgRadius = Math.round(inner * 0.22);
  const shieldPad = Math.round(inner * 0.15);
  const shieldInner = inner - shieldPad * 2;

  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg">
  <!-- Solid background for maskable shape -->
  <rect width="${size}" height="${size}" fill="#080808"/>
  <g transform="translate(${safePad}, ${safePad})">
    <rect width="${inner}" height="${inner}" rx="${bgRadius}" ry="${bgRadius}" fill="#0a0a0a"/>
    <!-- Shield emblem -->
    <g transform="translate(${shieldPad}, ${shieldPad}) scale(${shieldInner / 24})">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"
            fill="none" stroke="#E50914" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
    </g>
  </g>
</svg>`;
}

async function generateIcons() {
  const publicDir = path.join(__dirname, '..', 'public');

  const icons = [
    { size: 512, name: 'icon-512.png', fn: buildShieldSVG },
    { size: 192, name: 'icon-192.png', fn: buildShieldSVG },
    { size: 180, name: 'apple-touch-icon.png', fn: buildShieldSVG },
    { size: 32,  name: 'favicon-32.png', fn: buildShieldSVG },
    { size: 512, name: 'icon-maskable-512.png', fn: buildMaskableSVG },
    { size: 192, name: 'icon-maskable-192.png', fn: buildMaskableSVG },
  ];

  for (const { size, name, fn } of icons) {
    const svg = fn(size);
    const outputPath = path.join(publicDir, name);
    await sharp(Buffer.from(svg))
      .resize(size, size)
      .png({ quality: 100, compressionLevel: 6 })
      .toFile(outputPath);
    const fs = require('fs');
    const stat = fs.statSync(outputPath);
    console.log(`✓ ${name} (${size}x${size}, ${stat.size} bytes)`);
  }

  console.log('\nAll PWA icons regenerated — red Shield on black, matching splash screen');
}

generateIcons().catch(err => {
  console.error('Failed:', err);
  process.exit(1);
});
