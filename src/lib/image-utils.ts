/**
 * Image compression utilities for avatar uploads.
 * Shared between ProfileCompletionScreen and ProfilePage.
 */

const AVATAR_COMPRESS_TARGET = 200;
const AVATAR_JPEG_QUALITY = 0.75;

/**
 * Compress an image file to a square JPEG data URL.
 * Centers and crops to a square, resizes to AVATAR_COMPRESS_TARGET px.
 * Revokes the ObjectURL after processing to prevent memory leaks.
 */
export function compressImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const objectUrl = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(objectUrl);
      const size = AVATAR_COMPRESS_TARGET;
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext('2d');
      if (!ctx) { reject(new Error('Canvas context unavailable')); return; }
      const minDim = Math.min(img.width, img.height);
      const sx = (img.width - minDim) / 2;
      const sy = (img.height - minDim) / 2;
      ctx.drawImage(img, sx, sy, minDim, minDim, 0, 0, size, size);
      resolve(canvas.toDataURL('image/jpeg', AVATAR_JPEG_QUALITY));
    };
    img.onerror = () => { URL.revokeObjectURL(objectUrl); reject(new Error('Failed to load image')); };
    img.src = objectUrl;
  });
}
