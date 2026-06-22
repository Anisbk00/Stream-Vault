const sharp = require('sharp');
const path = require('path');

function buildMaskableSVG(size) {
  // For maskable icons: the safe zone is the center 80% (40% padding total)
  // So the logo should be drawn in the center 80% of the canvas
  const safePadding = Math.round(size * 0.10); // 10% on each side = 80% safe zone
  const innerSize = size - safePadding * 2;
  const bgRadius = Math.round(size * 0.18);
  const innerRadius = Math.round(innerSize * 0.18);

  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg">
  <!-- Full background fill for maskable shape -->
  <rect x="0" y="0" width="${size}" height="${size}" fill="#2D2D2D"/>
  <!-- Inner logo area with rounded corners -->
  <g transform="translate(${safePadding}, ${safePadding})">
    <rect x="0" y="0" width="${innerSize}" height="${innerSize}" rx="${innerRadius}" ry="${innerRadius}" fill="#2D2D2D" stroke="#FFFFFF" stroke-width="${Math.max(1, Math.round(size * 0.01))}" stroke-miterlimit="10"/>
    <!-- White Z lettermark -->
    <g transform="translate(${Math.round(innerSize * 0.05)}, ${Math.round(innerSize * 0.05)}) scale(${(innerSize * 0.9) / 30})">
      <path fill="#FFFFFF" d="M15.47,7.1l-1.3,1.85c-0.2,0.29-0.54,0.47-0.9,0.47h-7.1V7.09C6.16,7.1,15.47,7.1,15.47,7.1z"/>
      <polygon fill="#FFFFFF" points="24.3,7.1 13.14,22.91 5.7,22.91 16.86,7.1"/>
      <path fill="#FFFFFF" d="M14.53,22.91l1.31-1.86c0.2-0.29,0.54-0.47,0.9-0.47h7.09v2.33H14.53z"/>
    </g>
  </g>
</svg>`;
}

async function generate() {
  const publicDir = path.join(__dirname, '..', 'public');
  
  const svg = buildMaskableSVG(512);
  await sharp(Buffer.from(svg)).resize(512, 512).png().toFile(path.join(publicDir, 'icon-maskable-512.png'));
  console.log('✓ Generated icon-maskable-512.png (512x512)');
  
  const svg192 = buildMaskableSVG(192);
  await sharp(Buffer.from(svg192)).resize(192, 192).png().toFile(path.join(publicDir, 'icon-maskable-192.png'));
  console.log('✓ Generated icon-maskable-192.png (192x192)');
}

generate().catch(console.error);
