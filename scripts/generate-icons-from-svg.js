// Generate PWA icons directly from the StreamVault logo.svg source file
const sharp = require('sharp');
const path = require('path');
const fs = require('fs');

async function generateIcons() {
  const publicDir = path.join(__dirname, '..', 'public');
  const svgPath = path.join(publicDir, 'logo.svg');
  
  // Read the source SVG and strip animations (static icon)
  let svgContent = fs.readFileSync(svgPath, 'utf8');
  
  // Remove the animation style block — icons must be static
  svgContent = svgContent.replace(/\.z-breathe\s*\{[^}]*\}/gs, '');
  svgContent = svgContent.replace(/class="z-breathe"/g, '');
  
  // The original SVG has a 30x30 viewBox with the design inside.
  // For PWA icons, we need to render at specific sizes with proper padding.
  const sizes = [
    { size: 512, name: 'icon-512.png' },
    { size: 192, name: 'icon-192.png' },
    { size: 180, name: 'apple-touch-icon.png' },
    { size: 32,  name: 'favicon-32.png' },
  ];

  for (const { size, name } of sizes) {
    const outputPath = path.join(publicDir, name);
    
    await sharp(Buffer.from(svgContent))
      .resize(size, size)
      .png({ quality: 100, compressionLevel: 6 })
      .toFile(outputPath);
    
    const stat = fs.statSync(outputPath);
    console.log(`✓ ${name} (${size}x${size}, ${stat.size} bytes)`);
  }

  // Generate maskable variants with safe zone (center 80%)
  const maskableSizes = [
    { size: 512, name: 'icon-maskable-512.png' },
    { size: 192, name: 'icon-maskable-192.png' },
  ];

  for (const { size, name } of maskableSizes) {
    // For maskable icons, render the logo centered within a padded canvas
    // Safe zone = center 80%, so we add 10% padding on each side
    const padding = Math.round(size * 0.10);
    const logoSize = size - padding * 2;
    
    // Create a canvas with the dark background, then composite the logo
    const canvas = Buffer.from(`<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
      <rect width="${size}" height="${size}" fill="#2D2D2D"/>
    </svg>`);
    
    const resizedLogo = await sharp(Buffer.from(svgContent))
      .resize(logoSize, logoSize)
      .png()
      .toBuffer();
    
    const outputPath = path.join(publicDir, name);
    
    await sharp(canvas)
      .composite([{
        input: resizedLogo,
        left: padding,
        top: padding,
      }])
      .png({ quality: 100, compressionLevel: 6 })
      .toFile(outputPath);
    
    const stat = fs.statSync(outputPath);
    console.log(`✓ ${name} (${size}x${size}, maskable, ${stat.size} bytes)`);
  }

  console.log('\nAll icons regenerated from logo.svg');
}

generateIcons().catch(err => {
  console.error('Failed:', err);
  process.exit(1);
});
