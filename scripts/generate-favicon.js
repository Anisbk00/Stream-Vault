const sharp = require('sharp');
const path = require('path');

async function generateFavicon() {
  const size = 180; // apple-touch-icon recommended size
  const svg = `
  <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="bgGrad" x1="0" y1="0" x2="${size}" y2="${size}" gradientUnits="userSpaceOnUse">
        <stop offset="0%" stop-color="#0f0f0f"/>
        <stop offset="100%" stop-color="#080808"/>
      </linearGradient>
      <linearGradient id="playGrad" x1="0" y1="0" x2="${size}" y2="${size}" gradientUnits="userSpaceOnUse">
        <stop offset="0%" stop-color="#E50914"/>
        <stop offset="100%" stop-color="#CC0812"/>
      </linearGradient>
    </defs>
    <rect x="0" y="0" width="${size}" height="${size}" rx="36" ry="36" fill="url(#bgGrad)"/>
    <g transform="translate(${size * 0.025}, 0)">
      <polygon
        points="${29 + 123 * 0.33},${29 + 123 * 0.18} ${29 + 123 * 0.33},${29 + 123 * 0.82} ${29 + 123 * 0.78},${29 + 123 * 0.50}"
        fill="url(#playGrad)"
      />
    </g>
  </svg>`;

  const publicDir = path.join(__dirname, '..', 'public');

  // Apple touch icon (180x180)
  await sharp(Buffer.from(svg))
    .resize(180, 180)
    .png()
    .toFile(path.join(publicDir, 'apple-touch-icon.png'));

  // Favicon 32x32
  await sharp(Buffer.from(svg))
    .resize(32, 32)
    .png()
    .toFile(path.join(publicDir, 'favicon-32.png'));

  console.log('Generated apple-touch-icon.png and favicon-32.png');
}

generateFavicon().catch(console.error);
