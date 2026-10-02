// The kiosk matches exclusively 512-dim MobileFaceNet embeddings; legacy
// 128-dim dlib encodings are invalid and require re-enrollment.
export const SUPPORTED_ENCODING_LENGTHS = new Set([512]);

export function isSupportedEncoding(encoding: unknown): encoding is number[] {
  if (!Array.isArray(encoding) || !SUPPORTED_ENCODING_LENGTHS.has(encoding.length) ||
      !encoding.every((value) => typeof value === 'number' && Number.isFinite(value))) return false;
  const squaredNorm = encoding.reduce((sum, value) => sum + value * value, 0);
  return squaredNorm > 0 && Number.isFinite(squaredNorm);
}

export function getEncodingValidationMessage(fieldName = 'Encoding'): string {
  return `${fieldName} must be an array of 512 finite numbers with a nonzero finite squared norm`;
}
