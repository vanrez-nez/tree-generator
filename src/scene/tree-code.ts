import { RANGES } from "./tree-ranges";

// Reversible tree "code": a compact, shareable encoding of every parameter that defines a tree's
// form. Unlike a one-way PRNG seed, the code IS the configuration — so both directions work:
//   • configure a tree (the form params) → `encodeForm` → a short string you can copy/share;
//   • paste/keep that string → `decodeForm` → the exact same configuration.
//
// `randomForm` picks a random value per field (within each field's random window from tree-ranges),
// which `encodeForm` turns into a random — but valid — code. The encoding is mixed-radix over
// base-62: each field contributes a digit in its own base (its number of discrete steps), so the
// code stays short. A `seed` field is included so the leftover per-limb jitter (azimuth/attach/
// length wobble + modifier seeds) is captured too — the code therefore fully determines the tree.
//
// All ranges live in tree-ranges.ts; this module is just the codec over them.

// The form is exactly one number per field defined in RANGES.
export type TreeForm = { [K in keyof typeof RANGES]: number };

export type FieldSpec = {
  key: keyof TreeForm;
  min: number;
  max: number;
  step: number;
  randMin: number; // resolved random window (defaults to [min, max])
  randMax: number;
};

// The wire order is RANGES' key order. Appending new fields at the END of RANGES keeps existing
// codes decoding the same way (older codes leave the new trailing fields at their min).
export const FIELDS: FieldSpec[] = (
  Object.entries(RANGES) as [keyof TreeForm, (typeof RANGES)[keyof typeof RANGES]][]
).map(([key, range]) => ({
  key,
  min: range.min,
  max: range.max,
  step: range.step,
  randMin: "randMin" in range ? range.randMin : range.min,
  randMax: "randMax" in range ? range.randMax : range.max,
}));

// Current "default tree" expressed as a form. Every value sits exactly on its field's grid.
export const DEFAULT_FORM: TreeForm = {
  seed: 1,
  height: 4,
  branchCount: 3,
  branchLevels: 3,
  branchL2: 2,
  branchL3: 1,
  rootLevels: 1,
  rootL2: 2,
  rootL3: 1,
  trunkRadius: 0.45,
  radiusScale: 0.6,
  tipScale: 0.12,
  branchLean1: 30,
  branchLean2: 60,
  branchLean3: 70,
  rootRadius: 0.53,
  rootHeight: 0.03,
  rootLength: 1.6,
  rootDownAngle: 0,
  rootDownCurve: 0,
  maxRoots: 8,
  rootSeparation: 0.6,
  rootLSmooth: 0.5,
};

const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const BASE = 62n;

// Number of discrete values a field can take (inclusive of both ends).
function stepCount(field: FieldSpec): number {
  return Math.round((field.max - field.min) / field.step) + 1;
}

// Snap a raw value to its field's grid and return the integer index in [0, stepCount - 1].
function toIndex(value: number, field: FieldSpec): number {
  const raw = Math.round((value - field.min) / field.step);
  return Math.min(stepCount(field) - 1, Math.max(0, raw));
}

// Turn an index back into the field's value, rounding away float drift from `min + idx*step`.
function fromIndex(index: number, field: FieldSpec): number {
  return Math.round((field.min + index * field.step) * 1e6) / 1e6;
}

function toBase62(value: bigint): string {
  if (value <= 0n) {
    return "0";
  }
  let out = "";
  let n = value;
  while (n > 0n) {
    out = ALPHABET[Number(n % BASE)] + out;
    n /= BASE;
  }
  return out;
}

function fromBase62(code: string): bigint | null {
  let n = 0n;
  for (const ch of code) {
    const digit = ALPHABET.indexOf(ch);
    if (digit < 0) {
      return null;
    }
    n = n * BASE + BigInt(digit);
  }
  return n;
}

// Pack the form into a single big integer (mixed radix, first field most significant) and render
// it as base-62.
export function encodeForm(form: TreeForm): string {
  let value = 0n;
  for (const field of FIELDS) {
    value = value * BigInt(stepCount(field)) + BigInt(toIndex(form[field.key], field));
  }
  return toBase62(value);
}

// Reverse of `encodeForm`. Returns null for codes that aren't valid base-62, so callers can reject
// bad input without throwing.
export function decodeForm(code: string): TreeForm | null {
  const trimmed = code.trim();
  if (trimmed.length === 0) {
    return null;
  }
  let value = fromBase62(trimmed);
  if (value === null) {
    return null;
  }

  const form = { ...DEFAULT_FORM };
  // Fields were folded in forward; peel them off in reverse (least significant last-encoded first).
  for (let i = FIELDS.length - 1; i >= 0; i -= 1) {
    const field = FIELDS[i];
    const radix = BigInt(stepCount(field));
    form[field.key] = fromIndex(Number(value % radix), field);
    value /= radix;
  }
  return form;
}

// A random-but-valid form: each field gets a uniformly random index inside its random window
// (randMin..randMax from tree-ranges), so random trees always stay within those limits.
export function randomForm(): TreeForm {
  const form = { ...DEFAULT_FORM };
  for (const field of FIELDS) {
    const lo = toIndex(field.randMin, field);
    const hi = toIndex(field.randMax, field);
    const index = lo + Math.floor(Math.random() * (hi - lo + 1));
    form[field.key] = fromIndex(index, field);
  }
  return form;
}
