export interface CompressedImageResult {
  dataBase64: string;
  mimeType: 'image/webp' | 'image/jpeg';
  originalBytes: number;
  compressedBytes: number;
  width: number;
  height: number;
}

const ALLOWED_INPUT_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']);

function estimateBase64Bytes(dataUrl: string): number {
  const commaIdx = dataUrl.indexOf(',');
  const base64 = commaIdx >= 0 ? dataUrl.slice(commaIdx + 1) : dataUrl;
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}

export async function compressClinicalImage(
  file: File,
  maxDimension = 1200,
  quality = 0.78
): Promise<CompressedImageResult> {
  if (!file.type.startsWith('image/') && !ALLOWED_INPUT_TYPES.has(file.type)) {
    throw new Error('Please choose a JPEG, PNG, or WebP image file.');
  }
  if (file.size > 20 * 1024 * 1024) {
    throw new Error('Source image must be under 20 MB.');
  }

  const objectUrl = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('Could not decode selected image file.'));
      image.src = objectUrl;
    });

    const scale = Math.min(1, maxDimension / Math.max(img.width, img.height));
    const targetWidth = Math.max(1, Math.round(img.width * scale));
    const targetHeight = Math.max(1, Math.round(img.height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = targetWidth;
    canvas.height = targetHeight;

    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('Canvas rendering context unavailable in this browser.');
    }

    ctx.drawImage(img, 0, 0, targetWidth, targetHeight);

    let dataUrl = canvas.toDataURL('image/webp', quality);
    let mimeType: 'image/webp' | 'image/jpeg' = 'image/webp';

    if (!dataUrl.startsWith('data:image/webp')) {
      dataUrl = canvas.toDataURL('image/jpeg', quality);
      mimeType = 'image/jpeg';
    }

    let compressedBytes = estimateBase64Bytes(dataUrl);
    if (compressedBytes > 1_200_000) {
      dataUrl = canvas.toDataURL(mimeType, 0.58);
      compressedBytes = estimateBase64Bytes(dataUrl);
    }

    return {
      dataBase64: dataUrl,
      mimeType,
      originalBytes: file.size,
      compressedBytes,
      width: targetWidth,
      height: targetHeight,
    };
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
