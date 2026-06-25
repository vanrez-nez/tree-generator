// Reversible tree "code": a compact, shareable encoding of every parameter that defines a tree's
// form. Unlike a one-way PRNG seed, the code IS the configuration — so the two directions both
// work:
//   • configure a tree (the form params) → `encodeForm` → a short string you can copy/share;
//   • paste/keep that string → `decodeForm` → the exact same configuration.
//
// `randomForm` picks a random value per field, which `encodeForm` turns into a random (but valid)
// code. The encoding is mixed-radix over base-62: each field contributes a digit in its own base
// (its number of discrete steps), so the code stays short and self-describing. A `seed` field is
// included so the leftover per-limb jitter (azimuth/attach/length wobble + modifier seeds) is also
// captured — the code therefore fully determines the tree.

// Every form field: its key plus the quantized [min, max] grid the value snaps to. The order here
// is the wire order — appending new fields at the END keeps existing codes decoding the same way
// (older codes simply leave the new trailing fields at 0 / their min).
export type FieldSpec = { key: keyof TreeForm; min: number; max: number; step: number };

export type TreeForm = {
  seed: number; // jitter PRNG seed (per-limb wobble + modifier variation)
  height: number;
  branchCount: number;
  branchLevels: number;
  branchL2: number; // L2 children per parent (fan-out)
  branchL3: number; // L3 children per parent
  rootLevels: number;
  rootL2: number;
  rootL3: number;
  trunkRadius: number;
  radiusScale: number; // radius multiplier per branching level
  tipScale: number; // taper fraction toward each line's tip
  branchLean1: number; // joint lean clamp (°) at branch L1..L3
  branchLean2: number;
  branchLean3: number;
  rootRadius: number;
  rootHeight: number; // trunk fraction (0..0.5) where roots attach
  rootLength: number;
  rootDownAngle: number;
  rootDownCurve: number;
  maxRoots: number;
  rootSeparation: number;
  rootLSmooth: number;
};

export const FIELDS: FieldSpec[] = [
  { key: "seed", min: 0, max: 1_048_575, step: 1 }, // 2^20 jitter seeds
  { key: "height", min: 2, max: 7, step: 0.25 },
  { key: "branchCount", min: 0, max: 8, step: 1 },
  { key: "branchLevels", min: 1, max: 3, step: 1 },
  { key: "branchL2", min: 0, max: 5, step: 1 },
  { key: "branchL3", min: 0, max: 5, step: 1 },
  { key: "rootLevels", min: 1, max: 3, step: 1 },
  { key: "rootL2", min: 0, max: 5, step: 1 },
  { key: "rootL3", min: 0, max: 5, step: 1 },
  { key: "trunkRadius", min: 0.2, max: 0.6, step: 0.01 },
  { key: "radiusScale", min: 0.4, max: 0.8, step: 0.02 },
  { key: "tipScale", min: 0.05, max: 0.25, step: 0.01 },
  { key: "branchLean1", min: 0, max: 90, step: 5 },
  { key: "branchLean2", min: 0, max: 90, step: 5 },
  { key: "branchLean3", min: 0, max: 90, step: 5 },
  { key: "rootRadius", min: 0.2, max: 0.7, step: 0.01 },
  { key: "rootHeight", min: 0, max: 0.5, step: 0.01 },
  { key: "rootLength", min: 0.5, max: 3, step: 0.05 },
  { key: "rootDownAngle", min: 0, max: 90, step: 5 },
  { key: "rootDownCurve", min: 0, max: 90, step: 5 },
  { key: "maxRoots", min: 0, max: 16, step: 1 },
  { key: "rootSeparation", min: 0, max: 2, step: 0.05 },
  { key: "rootLSmooth", min: 0, max: 1, step: 0.05 },
];

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

// A random-but-valid form: each field gets a uniformly random index on its grid.
export function randomForm(): TreeForm {
  const form = { ...DEFAULT_FORM };
  for (const field of FIELDS) {
    const index = Math.floor(Math.random() * stepCount(field));
    form[field.key] = fromIndex(index, field);
  }
  return form;
}
