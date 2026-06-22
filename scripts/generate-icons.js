// Generate PWA icons from the StreamVault logo SVG (dark square + white Z)
const sharp = require('sharp');
const path = require('path');
const fs = require('fs');

function buildLogoSVG(size) {
  // Scale the original 30x30 viewBox logo to the target size
  // Add padding for maskable safe zone (the outer 10% on each side is the "unsafe" area)
  // We embed the original logo design as a static SVG (no animations for icons)
  const padding = Math.round(size * 0.10);
  const innerSize = size - padding * 2;

  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <clipPath id="bgClip">
      <rect x="0" y="0" width="${size}" height="${size}" rx="${Math.round(size * 0.18)}" ry="${Math.round(size * 0.18)}"/>
    </clipPath>
  </defs>
  <g clip-path="url(#bgClip)">
    <!-- Dark background matching the app theme -->
    <rect x="0" y="0" width="${size}" height="${size}" fill="#2D2D2D"/>
    <!-- White Z lettermark — scaled from original 30x30 viewBox, centered -->
    <g transform="translate(${padding}, ${padding}) scale(${innerSize / 30})">
      <!-- Top bar of Z -->
      <path fill="#FFFFFF" d="M15.47,7.1l-1.3,1.85c-0.2,0.29-0.54,0.47-0.9,0.47h-7.1V7.09C6.16,7.1,15.47,7.1,15.47,7.1z"/>
      <!-- Diagonal of Z -->
      <polygon fill="#FFFFFF" points="24.3,7.1 13.14,22.91 5.7,22.91 16.86,7.1"/>
      <!-- Bottom bar of Z -->
      <path fill="#FFFFFF" d="M14.53,22.91l1.31-1.86c0.2-0.29,0.54-0.47,0.9-0.47h7.09v2.33H14.53z"/>
    </g>
  </g>
</svg>`;
}

async function generateIcons() {
  const publicDir = path.join(__dirname, '..', 'public');

  const icons = [
    { size: 512, name: 'icon-512.png' },
    { size: 192, name: 'icon-192.png' },
    { size: 180, name: 'apple-touch-icon.png' },
    { size: 32,  name: 'favicon-32.png' },
  ];

  for (const { size, name } of icons) {
    const svg = buildLogoSVG(size);
    const outputPath = path.join(publicDir, name);
    await sharp(Buffer.from(svg))
      .resize(size, size)
      .png()
      .toFile(outputPath);
    console.log(`✓ Generated ${name} (${size}x${size})`);
  }

  console.log('\nAll PWA icons regenerated from the StreamVault logo.');
}

generateIcons().catch(err => {
  console.error('Icon generation failed:', err);
  process.exit(1);
});
