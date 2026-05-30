// Generate minimalist premium PWA icons — red background + white play
const sharp = require('sharp');
const path = require('path');

async function generateIcons() {
  const sizes = [192, 512, 180, 32];

  for (const size of sizes) {
    const padding = Math.round(size * 0.16);
    const innerSize = size - padding * 2;
    const cornerRadius = Math.round(size * 0.2);

    const svg = `
    <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="bgGrad" x1="0" y1="0" x2="${size}" y2="${size}" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stop-color="#E50914"/>
          <stop offset="100%" stop-color="#CC0812"/>
        </linearGradient>
      </defs>

      <!-- Red background -->
      <rect x="0" y="0" width="${size}" height="${size}" rx="${cornerRadius}" ry="${cornerRadius}" fill="url(#bgGrad)"/>

      <!-- White play triangle, centered with slight right offset -->
      <g transform="translate(${size * 0.028}, 0)">
        <polygon
          points="${padding + innerSize * 0.33},${padding + innerSize * 0.18} ${padding + innerSize * 0.33},${padding + innerSize * 0.82} ${padding + innerSize * 0.78},${padding + innerSize * 0.50}"
          fill="#FFFFFF"
        />
      </g>
    </svg>`;

    const publicDir = path.join(__dirname, '..', 'public');

    if (size === 192 || size === 512) {
      const outputPath = path.join(publicDir, `icon-${size}.png`);
      await sharp(Buffer.from(svg)).resize(size, size).png().toFile(outputPath);
      console.log(`Generated ${outputPath} (${size}x${size})`);
    } else if (size === 180) {
      const outputPath = path.join(publicDir, 'apple-touch-icon.png');
      await sharp(Buffer.from(svg)).resize(180, 180).png().toFile(outputPath);
      console.log(`Generated ${outputPath} (180x180)`);
    } else if (size === 32) {
      const outputPath = path.join(publicDir, 'favicon-32.png');
      await sharp(Buffer.from(svg)).resize(32, 32).png().toFile(outputPath);
      console.log(`Generated ${outputPath} (32x32)`);
    }
  }
}

generateIcons().catch(console.error);
