/**
 * Generate PWA icons that EXACTLY match the splash screen:
 *   Black background + amber RetroShield (no box, no square — just the shield)
 *
 * This mirrors SplashScreen.tsx:
 *   <RetroShield style={{ color: '#D97706' }} />
 *
 * The SVG paths match RetroShield.tsx path-for-path.
 */
const sharp = require('sharp');
const path = require('path');
const fs = require('fs');

const BRAND = '#D97706';
const BG = '#080808';

/**
 * Build the PWA icon SVG: black background + amber RetroShield centered.
 */
function buildIconSVG(size, padding = 0) {
  const canvasSize = size - padding * 2;
  const sw = 1.2;
  // Inset so the shield has breathing room inside the canvas
  const shieldInset = Math.round(canvasSize * 0.10);
  const shieldSize = canvasSize - shieldInset * 2;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <!-- Black background (fully opaque) -->
  <rect width="${size}" height="${size}" fill="${BG}"/>
  <!-- Amber RetroShield centered -->
  <g transform="translate(${padding + shieldInset}, ${padding + shieldInset})">
    <svg width="${shieldSize}" height="${shieldSize}" viewBox="0 0 24 24" fill="none">
      <!-- Outer shield shape -->
      <path
        d="M12 2L3 7V12C3 16.97 7.03 21.5 12 22.5C16.97 21.5 21 16.97 21 12V7L12 2Z"
        stroke="${BRAND}"
        stroke-width="${sw}"
        stroke-linejoin="round"
      />
      <!-- Inner shield border — double-line Art Deco motif -->
      <path
        d="M12 4.5L5.5 8.2V12C5.5 15.8 8.4 19.3 12 20.2C15.6 19.3 18.5 15.8 18.5 12V8.2L12 4.5Z"
        stroke="${BRAND}"
        stroke-width="${sw * 0.6}"
        stroke-linejoin="round"
        opacity="0.6"
      />
      <!-- Chevron stripes -->
      <path
        d="M12 8L8.5 12L12 16L15.5 12L12 8Z"
        stroke="${BRAND}"
        stroke-width="${sw * 0.8}"
        stroke-linejoin="round"
      />
      <!-- Center diamond — filled amber -->
      <path
        d="M12 10L10.5 12L12 14L13.5 12L12 10Z"
        fill="${BRAND}"
        opacity="0.9"
      />
    </svg>
  </g>
</svg>`;
}

async function generateIcon(size, name, maskable = false) {
  const publicDir = path.join(__dirname, '..', 'public');
  const outputPath = path.join(publicDir, name);

  const padding = maskable ? Math.round(size * 0.10) : 0;
  const svg = buildIconSVG(size, padding);

  await sharp(Buffer.from(svg))
    .png({
      compressionLevel: 6,
      palette: false,
      effort: 7,
    })
    .toFile(outputPath);

  // Verify: zero transparent pixels
  const stat = fs.statSync(outputPath);
  const verifyBuf = await sharp(outputPath).raw().toBuffer();
  let transparent = 0;
  for (let i = 3; i < verifyBuf.length; i += 4) {
    if (verifyBuf[i] < 255) transparent++;
  }
  const status = transparent === 0 ? '✓' : `⚠ ${transparent} transparent!`;
  console.log(`${status} ${name} (${size}x${size}, ${stat.size} bytes)`);
}

async function main() {
  const icons = [
    { size: 512, name: 'pwa-512x512.png', maskable: false },
    { size: 192, name: 'pwa-192x192.png', maskable: false },
    { size: 180, name: 'apple-touch-icon.png', maskable: false },
    { size: 32,  name: 'favicon.png', maskable: false },
    { size: 512, name: 'maskable-512x512.png', maskable: true },
    { size: 192, name: 'maskable-192x192.png', maskable: true },
  ];

  for (const { size, name, maskable } of icons) {
    await generateIcon(size, name, maskable);
  }

  console.log('\nAll PWA icons generated — amber RetroShield on black (matches splash screen)');
}

main().catch(err => {
  console.error('Failed:', err);
  process.exit(1);
});
