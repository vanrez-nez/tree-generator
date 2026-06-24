// Tiny FNV-1a-style 32-bit hashing used to build content signatures of the graph's geometry, so
// the mesher can detect "did anything that affects the surface change?" by comparing one number.
// Floats are quantized (1e-4) so insignificant noise doesn't churn the signature; the geometry
// here is camera/time-independent, so an unchanged graph yields a stable hash.

export const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

export function hashInt(hash: number, value: number): number {
  return Math.imul(hash ^ (value | 0), FNV_PRIME);
}

export function hashFloat(hash: number, value: number): number {
  return hashInt(hash, Math.round(value * 1e4));
}

export function hashString(hash: number, value: string): number {
  let next = hash;
  for (let index = 0; index < value.length; index += 1) {
    next = Math.imul(next ^ value.charCodeAt(index), FNV_PRIME);
  }
  return next;
}
