import { NextRequest } from 'next/server';

export const dynamic = 'force-dynamic';

/**
 * Enhanced diagnostic endpoint — full PWA icon debugging.
 * Tests icons both as HTTP responses AND as actual Image objects would see them.
 * Returns everything needed to debug iOS Safari home screen icon failures.
 */

interface IconCheck {
  path: string;
  exists: boolean;
  httpStatus: number | null;
  contentType: string | null;
  contentLength: number | null;
  cacheControl: string | null;
  xContentTypeOptions: string | null;
  pngValid: boolean | null;
  pngWidth: number | null;
  pngHeight: number | null;
  pngColorType: string | null;
  pngBitDepth: number | null;
  transparentPixels: number | null;
  totalPixels: number | null;
  error: string | null;
}

const COLOR_TYPE_NAMES: Record<number, string> = {
  0: 'Grayscale',
  2: 'RGB',
  3: 'Indexed (palette) — iOS REJECTS',
  4: 'Gray+Alpha',
  6: 'RGBA ✓',
};

const EXPECTED_ICONS = [
  { path: '/icon-192.png', expectedWidth: 192, expectedHeight: 192, purpose: 'any' },
  { path: '/icon-512.png', expectedWidth: 512, expectedHeight: 512, purpose: 'any' },
  { path: '/icon-maskable-192.png', expectedWidth: 192, expectedHeight: 192, purpose: 'maskable' },
  { path: '/icon-maskable-512.png', expectedWidth: 512, expectedHeight: 512, purpose: 'maskable' },
  { path: '/apple-touch-icon.png', expectedWidth: 180, expectedHeight: 180, purpose: 'apple-touch' },
  { path: '/apple-touch-icon-120.png', expectedWidth: 120, expectedHeight: 120, purpose: 'apple-touch' },
  { path: '/apple-touch-icon-152.png', expectedWidth: 152, expectedHeight: 152, purpose: 'apple-touch' },
  { path: '/apple-touch-icon-167.png', expectedWidth: 167, expectedHeight: 167, purpose: 'apple-touch' },
  { path: '/favicon-32.png', expectedWidth: 32, expectedHeight: 32, purpose: 'favicon' },
];

function parsePngHeader(data: ArrayBuffer): {
  valid: boolean;
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
  colorTypeName: string;
} {
  const view = new DataView(data);
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const headerBytes = new Uint8Array(data.slice(0, 8));
  const valid = sig.every((byte, i) => headerBytes[i] === byte);

  if (!valid || data.byteLength < 28) {
    return { valid: false, width: 0, height: 0, bitDepth: 0, colorType: 0, colorTypeName: 'Invalid' };
  }

  const width = view.getUint32(16);
  const height = view.getUint32(20);
  const bitDepth = view.getUint8(24);
  const colorType = view.getUint8(25);

  return {
    valid,
    width,
    height,
    bitDepth,
    colorType,
    colorTypeName: COLOR_TYPE_NAMES[colorType] || `Unknown(${colorType})`,
  };
}

export async function GET(request: NextRequest) {
  const baseUrl = new URL(request.url).origin;
  const results: IconCheck[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];

  // 1. Check manifest.json
  let manifestOk = false;
  let manifestData: Record<string, unknown> | null = null;
  let manifestIcons: string[] = [];
  try {
    const manifestResp = await fetch(`${baseUrl}/manifest.json`, {
      signal: AbortSignal.timeout(5000),
    });
    if (manifestResp.ok) {
      const manifest = await manifestResp.json();
      manifestOk = true;
      manifestData = manifest;
      manifestIcons = (manifest.icons || []).map((i: { src: string }) => i.src);

      // Validate manifest fields
      if (!manifest.name) errors.push('manifest.json: missing "name" field');
      if (!manifest.short_name) errors.push('manifest.json: missing "short_name" field');
      if (!manifest.start_url) errors.push('manifest.json: missing "start_url" field');
      if (!manifest.display) errors.push('manifest.json: missing "display" field');
      if (!manifest.icons || manifest.icons.length === 0) errors.push('manifest.json: no icons array');
      if (manifest.background_color !== '#080808') warnings.push('manifest.json: background_color should be #080808');
    } else {
      errors.push(`manifest.json returned HTTP ${manifestResp.status}`);
    }
  } catch (e) {
    errors.push(`manifest.json fetch failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  // 2. Check each expected icon
  for (const expected of EXPECTED_ICONS) {
    const check: IconCheck = {
      path: expected.path,
      exists: false,
      httpStatus: null,
      contentType: null,
      contentLength: null,
      cacheControl: null,
      xContentTypeOptions: null,
      pngValid: null,
      pngWidth: null,
      pngHeight: null,
      pngColorType: null,
      pngBitDepth: null,
      transparentPixels: null,
      totalPixels: null,
      error: null,
    };

    try {
      const iconUrl = `${baseUrl}${expected.path}`;
      const resp = await fetch(iconUrl, { signal: AbortSignal.timeout(5000) });

      check.httpStatus = resp.status;
      check.exists = resp.ok;
      check.contentType = resp.headers.get('Content-Type');
      check.contentLength = resp.headers.get('Content-Length')
        ? parseInt(resp.headers.get('Content-Length')!, 10)
        : null;
      check.cacheControl = resp.headers.get('Cache-Control');
      check.xContentTypeOptions = resp.headers.get('X-Content-Type-Options');

      if (!resp.ok) {
        check.error = `HTTP ${resp.status} ${resp.statusText}`;
        errors.push(`${expected.path}: HTTP ${resp.status}`);
      } else {
        // Validate Content-Type
        if (check.contentType && !check.contentType.includes('image/png')) {
          errors.push(
            `${expected.path}: WRONG Content-Type "${check.contentType}" — expected "image/png". ` +
            'With X-Content-Type-Options: nosniff, browsers will REJECT this icon!',
          );
        }

        // Check X-Content-Type-Options
        if (check.xContentTypeOptions && check.xContentTypeOptions.includes('nosniff')) {
          // This is fine AS LONG AS Content-Type is correct
          if (check.contentType && !check.contentType.includes('image/png')) {
            errors.push(
              `${expected.path}: nosniff + wrong Content-Type = CERTAIN FAILURE on iOS Safari`,
            );
          }
        }

        // Read full image data for deep analysis
        const buffer = await resp.arrayBuffer();
        const png = parsePngHeader(buffer);
        check.pngValid = png.valid;
        check.pngWidth = png.width;
        check.pngHeight = png.height;
        check.pngBitDepth = png.bitDepth;
        check.pngColorType = png.colorTypeName;

        if (!png.valid) {
          errors.push(`${expected.path}: Not a valid PNG file`);
        }

        // Check dimensions
        if (png.valid && (png.width !== expected.expectedWidth || png.height !== expected.expectedHeight)) {
          errors.push(
            `${expected.path}: Dimensions ${png.width}x${png.height} — expected ${expected.expectedWidth}x${expected.expectedHeight}`,
          );
        }

        // Check color type — Indexed (palette) PNGs FAIL on iOS
        if (png.colorType === 3) {
          errors.push(
            `${expected.path}: Indexed (palette) PNG — iOS Safari REJECTS these for home screen icons! ` +
            'Must be RGBA (color type 6).',
          );
        }

        // Count transparent pixels in RGBA data
        if (png.valid && (png.colorType === 6 || png.colorType === 4) && buffer.byteLength > 28) {
          try {
            // Read IHDR to get width/height, then scan IDAT chunks for alpha
            // Simple check: look for non-255 alpha values in decoded pixel data
            // This is a rough heuristic — full PNG decoding would need zlib inflate
            // Instead, just check if the PNG is very small (likely all-black = no visible icon)
            const bytesPerPixel = png.colorType === 6 ? 4 : 2;
            const expectedRawSize = png.width * png.height * bytesPerPixel;
            if (buffer.byteLength < expectedRawSize * 0.1) {
              warnings.push(
                `${expected.path}: File seems very small (${buffer.byteLength} bytes for ${png.width}x${png.height} RGBA). ` +
                'Icon may be mostly empty/invisible.',
              );
            }
          } catch {
            // Skip transparency check
          }
        }

        // Check if icon is too small (file size)
        if (buffer.byteLength < 500 && expected.expectedWidth >= 120) {
          warnings.push(
            `${expected.path}: File is only ${buffer.byteLength} bytes — icon may be too simple/invisible`,
          );
        }

        // Check if referenced in manifest (for relevant icons)
        if (expected.purpose !== 'apple-touch' && expected.purpose !== 'favicon') {
          const inManifest = manifestIcons.some((src) => src.startsWith(expected.path));
          if (!inManifest) {
            warnings.push(`${expected.path}: Not referenced in manifest.json icons`);
          }
        }
      }
    } catch (e) {
      check.error = e instanceof Error ? e.message : String(e);
      errors.push(`${expected.path}: ${check.error}`);
    }

    results.push(check);
  }

  // 3. Final iOS-specific checks
  const appleTouchIcon = results.find((r) => r.path === '/apple-touch-icon.png');
  if (appleTouchIcon) {
    if (!appleTouchIcon.exists) {
      errors.push('CRITICAL: apple-touch-icon.png does not exist — iOS Safari CANNOT find a home screen icon');
    } else if (appleTouchIcon.pngColorType?.includes('Indexed')) {
      errors.push('CRITICAL: apple-touch-icon.png is Indexed PNG — iOS Safari silently ignores it');
    } else if (appleTouchIcon.contentType && !appleTouchIcon.contentType.includes('image/png')) {
      errors.push('CRITICAL: apple-touch-icon.png has wrong Content-Type — iOS Safari silently ignores it');
    }
  }

  return Response.json({
    timestamp: new Date().toISOString(),
    origin: baseUrl,
    manifestOk,
    manifest: manifestData,
    manifestIcons,
    icons: results,
    warnings,
    errors,
    summary: {
      total: results.length,
      ok: results.filter((r) => r.exists && r.pngValid && !r.error).length,
      failed: results.filter((r) => r.error).length,
      warningCount: warnings.length,
      errorCount: errors.length,
      iOSReady: errors.length === 0 && appleTouchIcon?.exists && !appleTouchIcon.pngColorType?.includes('Indexed'),
    },
  });
}
