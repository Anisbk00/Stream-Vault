// Generate PWA icons matching the StreamVault splash screen:
// Red Shield emblem (#E50914) on void black (#080808) background
//
// CRITICAL iOS Safari rules:
//   1. ZERO transparent pixels — iOS treats ANY transparency as "no icon"
//      and falls back to a screenshot of the page
//   2. NO rounded corners — iOS applies its own squircle mask
//   3. Shield must fill most of the canvas — with 15% padding + iOS squircle,
//      the shield ends up tiny and invisible
//   4. Must be RGBA (not Indexed/palette) PNG format
//
const sharp = require('sharp');
const path = require('path');

function buildShieldSVG(size) {
  // Shield icon: SOLID black background (no transparency!), large shield
  // iOS will apply its own squircle mask — we don't need rounded corners
  const padding = Math.round(size * 0.08); // 8% padding — shield fills ~70% of canvas
  const inner = size - padding * 2;

  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="shieldFill" x1="0" y1="0" x2="0" y2="1" gradientUnits="objectBoundingBox">
      <stop offset="0%" stop-color="#FF1A25"/>
      <stop offset="100%" stop-color="#C2070F"/>
    </linearGradient>
  </defs>
  <!-- SOLID opaque black background — NO rounded corners, NO transparency -->
  <rect width="${size}" height="${size}" fill="#080808"/>
  <!-- Filled Red Shield emblem — Lucide Shield path, centered, LARGE -->
  <g transform="translate(${padding}, ${padding}) scale(${inner / 24})">
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"
          fill="url(#shieldFill)" stroke="#E50914" stroke-width="0.6" stroke-linejoin="round"/>
  </g>
</svg>`;
}

function buildMaskableSVG(size) {
  // Maskable: same shield but with safe zone padding per Android spec
  const safePad = Math.round(size * 0.10);
  const inner = size - safePad * 2;
  const shieldPad = Math.round(inner * 0.08);
  const shieldInner = inner - shieldPad * 2;

  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="shieldFill" x1="0" y1="0" x2="0" y2="1" gradientUnits="objectBoundingBox">
      <stop offset="0%" stop-color="#FF1A25"/>
      <stop offset="100%" stop-color="#C2070F"/>
    </linearGradient>
  </defs>
  <!-- SOLID opaque background for maskable shape — NO transparency -->
  <rect width="${size}" height="${size}" fill="#080808"/>
  <!-- Filled Shield emblem with safe zone -->
  <g transform="translate(${safePad + shieldPad}, ${safePad + shieldPad}) scale(${shieldInner / 24})">
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"
          fill="url(#shieldFill)" stroke="#E50914" stroke-width="0.6" stroke-linejoin="round"/>
  </g>
</svg>`;
}

async function generateIcons() {
  const publicDir = path.join(__dirname, '..', 'public');

  const icons = [
    { size: 512, name: 'icon-512.png', fn: buildShieldSVG },
    { size: 192, name: 'icon-192.png', fn: buildShieldSVG },
    { size: 180, name: 'apple-touch-icon.png', fn: buildShieldSVG },
    { size: 120, name: 'apple-touch-icon-120.png', fn: buildShieldSVG },
    { size: 152, name: 'apple-touch-icon-152.png', fn: buildShieldSVG },
    { size: 167, name: 'apple-touch-icon-167.png', fn: buildShieldSVG },
    { size: 32,  name: 'favicon-32.png', fn: buildShieldSVG },
    { size: 512, name: 'icon-maskable-512.png', fn: buildMaskableSVG },
    { size: 192, name: 'icon-maskable-192.png', fn: buildMaskableSVG },
  ];

  for (const { size, name, fn } of icons) {
    const svg = fn(size);
    const outputPath = path.join(publicDir, name);
    await sharp(Buffer.from(svg))
      .resize(size, size)
      // CRITICAL: Force RGBA (colorType 6) output.
      // Indexed/palette PNGs (colorType 3) are REJECTED by iOS Safari
      // and many Android launchers for home screen icons.
      .png({ quality: 100, compressionLevel: 6, palette: false })
      .toFile(outputPath);

    // Verify: ensure ZERO transparent pixels
    const buf = await sharp(outputPath).raw().toBuffer({ resolveWithObject: true });
    const { data, info } = buf;
    let transparentCount = 0;
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] < 255) transparentCount++;
    }

    const fs = require('fs');
    const stat = fs.statSync(outputPath);
    const status = transparentCount === 0 ? '✓' : `⚠ ${transparentCount} transparent pixels!`;
    console.log(`${status} ${name} (${size}x${size}, ${stat.size} bytes)`);
  }

  console.log('\nAll PWA icons regenerated — filled red Shield on solid black');
}

generateIcons().catch(err => {
  console.error('Failed:', err);
  process.exit(1);
});
