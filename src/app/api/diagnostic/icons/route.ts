import { NextRequest } from 'next/server';

export const dynamic = 'force-dynamic';

/**
 * Diagnostic endpoint — checks PWA icon serving health.
 * Returns detailed info about each icon file including:
 *  - Whether it's reachable via internal fetch
 *  - Content-Type header returned
 *  - Content-Length
 *  - PNG header validation (signature, dimensions, color type)
 *  - Whether it matches manifest.json expectations
 *
 * Usage: GET /api/diagnostic/icons
 */

interface IconCheck {
  path: string;
  exists: boolean;
  httpStatus: number | null;
  contentType: string | null;
  contentLength: number | null;
  pngValid: boolean | null;
  pngWidth: number | null;
  pngHeight: number | null;
  pngColorType: string | null;
  pngBitDepth: number | null;
  error: string | null;
}

const COLOR_TYPE_NAMES: Record<number, string> = {
  0: 'Grayscale',
  2: 'RGB',
  3: 'Indexed (palette)',
  4: 'Gray+Alpha',
  6: 'RGBA',
};

const EXPECTED_ICONS = [
  { path: '/icon-192.png', expectedWidth: 192, expectedHeight: 192, purpose: 'any' },
  { path: '/icon-512.png', expectedWidth: 512, expectedHeight: 512, purpose: 'any' },
  { path: '/icon-maskable-192.png', expectedWidth: 192, expectedHeight: 192, purpose: 'maskable' },
  { path: '/icon-maskable-512.png', expectedWidth: 512, expectedHeight: 512, purpose: 'maskable' },
  { path: '/apple-touch-icon.png', expectedWidth: 180, expectedHeight: 180, purpose: 'apple-touch' },
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
  // PNG signature: 89 50 4E 47 0D 0A 1A 0A
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const headerBytes = new Uint8Array(data.slice(0, 8));
  const valid = sig.every((byte, i) => headerBytes[i] === byte);

  if (!valid || data.byteLength < 28) {
    return { valid: false, width: 0, height: 0, bitDepth: 0, colorType: 0, colorTypeName: 'Invalid' };
  }

  // IHDR chunk starts at byte 8: 4 bytes length + 4 bytes type + 13 bytes data
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
  let manifestIcons: string[] = [];
  try {
    const manifestResp = await fetch(`${baseUrl}/manifest.json`, {
      signal: AbortSignal.timeout(5000),
    });
    if (manifestResp.ok) {
      const manifest = await manifestResp.json();
      manifestOk = true;
      manifestIcons = (manifest.icons || []).map((i: { src: string }) => i.src);
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
      pngValid: null,
      pngWidth: null,
      pngHeight: null,
      pngColorType: null,
      pngBitDepth: null,
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

      if (!resp.ok) {
        check.error = `HTTP ${resp.status} ${resp.statusText}`;
        errors.push(`${expected.path}: HTTP ${resp.status}`);
      } else {
        // Validate Content-Type
        if (check.contentType && !check.contentType.includes('image/png')) {
          warnings.push(
            `${expected.path}: Wrong Content-Type "${check.contentType}" — expected "image/png". ` +
            'With X-Content-Type-Options: nosniff, browsers will REJECT this icon.',
          );
        }

        // Read first 30 bytes for PNG header validation
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
          warnings.push(
            `${expected.path}: Dimensions ${png.width}x${png.height} — expected ${expected.expectedWidth}x${expected.expectedHeight}`,
          );
        }

        // Check color type — Indexed (palette) PNGs often fail on iOS home screen
        if (png.colorType === 3) {
          warnings.push(
            `${expected.path}: Uses Indexed (palette) color type — iOS Safari and many Android launchers ` +
            'may not display this as a home screen icon. Regenerate as RGBA (color type 6).',
          );
        }

        // Check if referenced in manifest
        if (!manifestIcons.includes(expected.path)) {
          warnings.push(`${expected.path}: Not referenced in manifest.json icons`);
        }
      }
    } catch (e) {
      check.error = e instanceof Error ? e.message : String(e);
      errors.push(`${expected.path}: ${check.error}`);
    }

    results.push(check);
  }

  // 3. Check for missing manifest icon references
  for (const src of manifestIcons) {
    const found = EXPECTED_ICONS.some((e) => e.path === src);
    if (!found) {
      warnings.push(`manifest.json references "${src}" but no validation rule exists for it`);
    }
  }

  return Response.json({
    timestamp: new Date().toISOString(),
    manifestOk,
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
    },
  });
}
