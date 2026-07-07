import * as THREE from "three";

// Root/ground crossing slices, shared by the collar's grooves and the debug overlay so both always see
// the SAME data. The crossing of the tree mesh with the floor plane (y = 0) is extracted as exact line
// segments (marching-triangles cross-section), filtered by a single normal-angle gate; a distance field
// over those segments then drives the concentric groove bands — iso-distance rings that automatically
// reproduce each crossing's true shape (elongated for tilted roots, round for vertical stubs).
// Reads the tree geometry ONLY — nothing in the graph or mesher is touched, no per-line tag.

// A floor crossing covered by more collar-mound dirt than this is buried — not a visible ground entry.
// Applied by consumers (the collar's groove build and the overlay), not by the extractor, because the
// mound height depends on the collar's own freshly-computed reach.
export const BURIED_EPS = 0.03;

// Queryable distance to the nearest slice segment on the ground plane.
export interface SliceField {
  nearestDist(x: number, z: number): number;
}

export const EMPTY_SLICE_FIELD: SliceField = { nearestDist: () => Infinity };

// Marching-triangles cross-section of the tree surface with the floor plane y = 0. Returns exact slice
// segments (flat [x0, z0, x1, z1, …]) for every straddling triangle whose smooth face normal is steeper
// than `normalAngleDeg` from flat (acos|n.y| ≥ angle): at 0° the whole coastline qualifies; raising the
// angle drops flat-lying/skimming faces first, keeping the genuinely through-the-ground walls.
export function extractSliceSegments(
  geometry: THREE.BufferGeometry | undefined,
  normalAngleDeg: number,
): number[] {
  const pos = geometry?.getAttribute("position");
  const nor = geometry?.getAttribute("normal");
  if (!geometry || !pos || !nor) return [];

  const index = geometry.index;
  const triCount = (index ? index.count : pos.count) / 3;
  const vertexOf = (t: number, k: number): number => (index ? index.getX(t * 3 + k) : t * 3 + k);

  // Keep faces steeper than the gate: acos(|n.y|) ≥ angle ⇔ |n.y| ≤ cos(angle).
  const cosMax = Math.cos((normalAngleDeg * Math.PI) / 180);

  const out: number[] = [];
  const ex: number[] = [];
  const ez: number[] = [];

  for (let t = 0; t < triCount; t += 1) {
    const a = vertexOf(t, 0);
    const b = vertexOf(t, 1);
    const c = vertexOf(t, 2);
    const ay = pos.getY(a);
    const by = pos.getY(b);
    const cy = pos.getY(c);

    // Straddle the floor plane (cheap band reject first — the ground region is |y| ≲ 1).
    const minY = Math.min(ay, by, cy);
    const maxY = Math.max(ay, by, cy);
    if (minY > 1.2 || maxY < -1.2) continue;
    if (!(minY < 0 && maxY > 0)) continue;

    // Normal gate: averaged smooth normal steepness.
    const nx = nor.getX(a) + nor.getX(b) + nor.getX(c);
    const ny = nor.getY(a) + nor.getY(b) + nor.getY(c);
    const nz = nor.getZ(a) + nor.getZ(b) + nor.getZ(c);
    const nlen = Math.hypot(nx, ny, nz) || 1;
    if (Math.abs(ny) / nlen > cosMax) continue;

    // The two edge/plane intersection points = one exact segment of the slice outline.
    ex.length = 0;
    ez.length = 0;
    const edge = (pi: number, py: number, qi: number, qy: number): void => {
      if (py < 0 === qy < 0) return; // both on the same side → no crossing on this edge
      const s = py / (py - qy); // fraction from p to q where y = 0
      ex.push(pos.getX(pi) + (pos.getX(qi) - pos.getX(pi)) * s);
      ez.push(pos.getZ(pi) + (pos.getZ(qi) - pos.getZ(pi)) * s);
    };
    edge(a, ay, b, by);
    edge(b, by, c, cy);
    edge(c, cy, a, ay);
    if (ex.length < 2) continue;

    out.push(ex[0], ez[0], ex[1], ez[1]);
  }
  return out;
}

// Bin the slice segments into a uniform grid (cell = maxDist) so nearestDist only checks the 3×3 cells
// around the query — any segment within `maxDist` is at most one cell away. Distance is exact
// point-to-segment, so groove bands hug the slice outline rather than a point cloud.
export function buildSliceField(segments: number[], maxDist: number): SliceField {
  const count = segments.length >> 2;
  if (count === 0) return EMPTY_SLICE_FIELD;

  const cell = Math.max(1e-3, maxDist);
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < count; i += 1) {
    const x0 = segments[i * 4];
    const z0 = segments[i * 4 + 1];
    const x1 = segments[i * 4 + 2];
    const z1 = segments[i * 4 + 3];
    minX = Math.min(minX, x0, x1);
    maxX = Math.max(maxX, x0, x1);
    minZ = Math.min(minZ, z0, z1);
    maxZ = Math.max(maxZ, z0, z1);
  }
  const cols = Math.max(1, Math.floor((maxX - minX) / cell) + 1);
  const rows = Math.max(1, Math.floor((maxZ - minZ) / cell) + 1);
  const clampCol = (v: number): number => Math.min(cols - 1, Math.max(0, v));
  const clampRow = (v: number): number => Math.min(rows - 1, Math.max(0, v));

  const grid: number[][] = Array.from({ length: cols * rows }, () => []);
  for (let i = 0; i < count; i += 1) {
    const x0 = segments[i * 4];
    const z0 = segments[i * 4 + 1];
    const x1 = segments[i * 4 + 2];
    const z1 = segments[i * 4 + 3];
    const c0 = clampCol(Math.floor((Math.min(x0, x1) - minX) / cell));
    const c1 = clampCol(Math.floor((Math.max(x0, x1) - minX) / cell));
    const r0 = clampRow(Math.floor((Math.min(z0, z1) - minZ) / cell));
    const r1 = clampRow(Math.floor((Math.max(z0, z1) - minZ) / cell));
    for (let r = r0; r <= r1; r += 1) {
      for (let c = c0; c <= c1; c += 1) grid[r * cols + c].push(i);
    }
  }

  const segDist2 = (qx: number, qz: number, i: number): number => {
    const x0 = segments[i * 4];
    const z0 = segments[i * 4 + 1];
    const x1 = segments[i * 4 + 2];
    const z1 = segments[i * 4 + 3];
    const dx = x1 - x0;
    const dz = z1 - z0;
    const lenSq = dx * dx + dz * dz;
    const t = lenSq <= 1e-12 ? 0 : Math.min(1, Math.max(0, ((qx - x0) * dx + (qz - z0) * dz) / lenSq));
    const px = x0 + dx * t - qx;
    const pz = z0 + dz * t - qz;
    return px * px + pz * pz;
  };

  return {
    nearestDist(x: number, z: number): number {
      const col = Math.floor((x - minX) / cell);
      const row = Math.floor((z - minZ) / cell);
      let best = Infinity;
      for (let dr = -1; dr <= 1; dr += 1) {
        const r = row + dr;
        if (r < 0 || r >= rows) continue;
        for (let dc = -1; dc <= 1; dc += 1) {
          const c = col + dc;
          if (c < 0 || c >= cols) continue;
          const bucket = grid[r * cols + c];
          for (let k = 0; k < bucket.length; k += 1) {
            const d2 = segDist2(x, z, bucket[k]);
            if (d2 < best) best = d2;
          }
        }
      }
      return best === Infinity ? Infinity : Math.sqrt(best);
    },
  };
}
