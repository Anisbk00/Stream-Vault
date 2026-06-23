/**
 * Generate PWA icons from scratch using sharp's raw pixel creation.
 * NO SVG involved — eliminates any SVG→PNG rendering issues that
 * iOS Safari's system-level "Add to Home Screen" process might reject.
 *
 * Creates a solid amber shield shape on opaque black background
 * using direct pixel manipulation.
 */
const sharp = require('sharp');
const path = require('path');
const fs = require('fs');

/**
 * Draw a shield shape into a raw RGBA pixel buffer.
 * The shield is a filled path (same shape as Lucide's Shield icon)
 * rendered at the given size with the given padding.
 */
function createShieldPixels(size) {
  // Create RGBA buffer filled with opaque black (#080808)
  const pixels = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    pixels[i * 4] = 8;     // R
    pixels[i * 4 + 1] = 8; // G
    pixels[i * 4 + 2] = 8; // B
    pixels[i * 4 + 3] = 255; // A (fully opaque)
  }

  // Shield parameters
  const pad = Math.round(size * 0.10);
  const w = size - pad * 2;

  // Draw shield as filled polygon using scanline approach
  // Shield shape: pointed top, wide middle, pointed bottom
  // Normalized coords (0-1 within the padded area)
  function isInShield(nx, ny) {
    // Lucide shield: wide at top, tapers to point at bottom
    // Top: flat edge from 0.15 to 0.85 at y=0.05
    // Middle: widest at y=0.3
    // Bottom: point at y=0.95

    // Left edge curve
    const topY = 0.0;
    const midY = 0.35;
    const botY = 1.0;
    const topLeftX = 0.05;
    const midLeftX = 0.0;
    const botX = 0.5;

    // Right edge (mirror)
    const topRightX = 0.95;
    const midRightX = 1.0;

    if (ny < topY || ny > botY) return false;

    let leftX, rightX;

    if (ny <= midY) {
      // Top half: from flat top to widest point
      const t = ny / midY;
      leftX = topLeftX + (midLeftX - topLeftX) * t;
      rightX = topRightX + (midRightX - topRightX) * t;
    } else {
      // Bottom half: from widest to point
      const t = (ny - midY) / (botY - midY);
      leftX = midLeftX + (botX - midLeftX) * t;
      rightX = midRightX + (botX - midRightX) * t;
    }

    return nx >= leftX && nx <= rightX;
  }

  // Paint shield pixels with amber gradient
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const nx = (x - pad) / w;
      const ny = (y - pad) / w;

      if (nx >= 0 && nx <= 1 && ny >= 0 && ny <= 1 && isInShield(nx, ny)) {
        const idx = (y * size + x) * 4;
        // Amber gradient: brighter at top, darker at bottom
        const gradient = 1.0 - ny * 0.15;
        pixels[idx] = Math.round(217 * gradient);     // R (#D97706 base)
        pixels[idx + 1] = Math.round(119 * gradient);   // G
        pixels[idx + 2] = Math.round(6 * gradient);  // B
        pixels[idx + 3] = 255;                         // A
      }
    }
  }

  return pixels;
}

/**
 * Create maskable icon pixels with safe zone.
 * The safe zone (outer 10%) is solid black, shield is centered in the safe area.
 */
function createMaskablePixels(size) {
  const safePad = Math.round(size * 0.10);
  const innerSize = size - safePad * 2;
  const innerPixels = createShieldPixels(innerSize);

  // Create full-size buffer with solid black
  const pixels = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    pixels[i * 4] = 8;
    pixels[i * 4 + 1] = 8;
    pixels[i * 4 + 2] = 8;
    pixels[i * 4 + 3] = 255;
  }

  // Copy inner pixels into center
  for (let y = 0; y < innerSize; y++) {
    for (let x = 0; x < innerSize; x++) {
      const srcIdx = (y * innerSize + x) * 4;
      const dstIdx = ((y + safePad) * size + (x + safePad)) * 4;
      pixels[dstIdx] = innerPixels[srcIdx];
      pixels[dstIdx + 1] = innerPixels[srcIdx + 1];
      pixels[dstIdx + 2] = innerPixels[srcIdx + 2];
      pixels[dstIdx + 3] = innerPixels[srcIdx + 3];
    }
  }

  return pixels;
}

async function generateIcon(size, name, pixelFn) {
  const publicDir = path.join(__dirname, '..', 'public');
  const outputPath = path.join(publicDir, name);

  const pixels = pixelFn(size);

  await sharp(pixels, {
    raw: { width: size, height: size, channels: 4 }
  })
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
    // Primary icons (used by manifest + browser)
    { size: 512, name: 'pwa-512x512.png', fn: createShieldPixels },
    { size: 192, name: 'pwa-192x192.png', fn: createShieldPixels },
    // Apple touch icon — WELL-KNOWN path iOS Safari auto-discovers
    { size: 180, name: 'apple-touch-icon.png', fn: createShieldPixels },
    // Favicon
    { size: 32, name: 'favicon.png', fn: createShieldPixels },
    // Maskable icons
    { size: 512, name: 'maskable-512x512.png', fn: createMaskablePixels },
    { size: 192, name: 'maskable-192x192.png', fn: createMaskablePixels },
  ];

  for (const { size, name, fn } of icons) {
    await generateIcon(size, name, fn);
  }

  console.log('\nAll PWA icons generated — raw pixel shield, zero SVG, zero transparency — retro amber');
}

main().catch(err => {
  console.error('Failed:', err);
  process.exit(1);
});
