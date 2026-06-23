/**
 * Generate PWA icons using sharp's SVG→PNG rendering.
 * Creates the EXACT RetroShield design (Art Deco shield with chevron + diamond)
 * matching the in-app RetroShield.tsx component, rendered in amber on black.
 *
 * The SVG is crafted to mirror RetroShield.tsx path-for-path:
 *   1. Outer shield silhouette
 *   2. Inner shield border (double-line Art Deco motif)
 *   3. Chevron stripes (vintage cinema heraldry)
 *   4. Filled center diamond (Art Deco focal point)
 */
const sharp = require('sharp');
const path = require('path');
const fs = require('fs');

const BG = '#080808';
const BRAND = '#D97706';

/**
 * Build an SVG string for the RetroShield icon at a given pixel size.
 * The shield fills the canvas with appropriate padding.
 */
function buildRetroShieldSVG(size, padding = 0) {
  const canvasSize = size - padding * 2;
  // The RetroShield viewBox is 0 0 24 24.
  // We scale it to fill the canvas area.
  const sw = 1.2; // base strokeWidth matching RetroShield default

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <!-- Black background — fully opaque -->
  <rect width="${size}" height="${size}" fill="${BG}"/>
  <g transform="translate(${padding}, ${padding})">
    <svg width="${canvasSize}" height="${canvasSize}" viewBox="0 0 24 24" fill="none">
      <!-- Outer shield shape — Art Deco heraldic silhouette -->
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
      <!-- Chevron stripes — vintage cinema heraldry -->
      <path
        d="M12 8L8.5 12L12 16L15.5 12L12 8Z"
        stroke="${BRAND}"
        stroke-width="${sw * 0.8}"
        stroke-linejoin="round"
      />
      <!-- Center diamond — Art Deco focal point -->
      <path
        d="M12 10L10.5 12L12 14L13.5 12L12 10Z"
        fill="${BRAND}"
        opacity="0.9"
      />
    </svg>
  </g>
</svg>`;
}

/**
 * Build a "filled" variant for the RetroShield icon —
 * The outer shield is filled with brand color, inner details are white/light,
 * making it more visible as a small app icon on home screens.
 */
function buildFilledRetroShieldSVG(size, padding = 0) {
  const canvasSize = size - padding * 2;
  const sw = 1.2;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <!-- Black background — fully opaque -->
  <rect width="${size}" height="${size}" fill="${BG}"/>
  <g transform="translate(${padding}, ${padding})">
    <svg width="${canvasSize}" height="${canvasSize}" viewBox="0 0 24 24" fill="none">
      <!-- Filled outer shield — solid amber background -->
      <path
        d="M12 2L3 7V12C3 16.97 7.03 21.5 12 22.5C16.97 21.5 21 16.97 21 12V7L12 2Z"
        fill="${BRAND}"
        stroke="none"
      />
      <!-- Inner shield border — double-line Art Deco motif (white on amber) -->
      <path
        d="M12 4.5L5.5 8.2V12C5.5 15.8 8.4 19.3 12 20.2C15.6 19.3 18.5 15.8 18.5 12V8.2L12 4.5Z"
        stroke="#ffffff"
        stroke-width="${sw * 0.6}"
        stroke-linejoin="round"
        opacity="0.5"
      />
      <!-- Chevron stripes — white on amber -->
      <path
        d="M12 8L8.5 12L12 16L15.5 12L12 8Z"
        stroke="#ffffff"
        stroke-width="${sw * 0.8}"
        stroke-linejoin="round"
      />
      <!-- Center diamond — white filled -->
      <path
        d="M12 10L10.5 12L12 14L13.5 12L12 10Z"
        fill="#ffffff"
        opacity="0.9"
      />
    </svg>
  </g>
</svg>`;
}

async function generateIcon(size, name, svgBuilder, maskable = false) {
  const publicDir = path.join(__dirname, '..', 'public');
  const outputPath = path.join(publicDir, name);

  const padding = maskable ? Math.round(size * 0.10) : Math.round(size * 0.08);
  const svg = svgBuilder(size, padding);

  await sharp(Buffer.from(svg))
    .png({
      compressionLevel: 6,
      palette: false,
      effort: 7,
    })
    .toFile(outputPath);

  // Verify: check file exists and has zero transparent pixels
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
    // Primary icons (used by manifest + browser) — filled style for visibility
    { size: 512, name: 'pwa-512x512.png', fn: buildFilledRetroShieldSVG, maskable: false },
    { size: 192, name: 'pwa-192x192.png', fn: buildFilledRetroShieldSVG, maskable: false },
    // Apple touch icon — filled style
    { size: 180, name: 'apple-touch-icon.png', fn: buildFilledRetroShieldSVG, maskable: false },
    // Favicon — filled style
    { size: 32, name: 'favicon.png', fn: buildFilledRetroShieldSVG, maskable: false },
    // Maskable icons — extra safe zone padding
    { size: 512, name: 'maskable-512x512.png', fn: buildFilledRetroShieldSVG, maskable: true },
    { size: 192, name: 'maskable-192x192.png', fn: buildFilledRetroShieldSVG, maskable: true },
  ];

  for (const { size, name, fn, maskable } of icons) {
    await generateIcon(size, name, fn, maskable);
  }

  console.log('\nAll PWA icons generated — RetroShield Art Deco design, retro amber, zero transparency');
}

main().catch(err => {
  console.error('Failed:', err);
  process.exit(1);
});
