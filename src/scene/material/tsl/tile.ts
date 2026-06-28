import {
  Fn,
  float,
  int,
  vec2,
  floor,
  mod,
  min,
  max,
  abs,
  length,
  cos,
  sin,
  select,
  smoothstep,
} from "three/tsl";
import type { MaterialValue } from "../graph/types";
import { hashCell2ToVec3Seed } from "./noise/hash";

// Generic TILE GENERATOR (Substance-style), not a brick-specific node. It lays a rounded-rectangle tile in
// each cell of a `columns × rows` grid, with a per-row horizontal offset and per-tile randomisation of
// position, size, rotation, and value. Brick is just one preset of it (offset 0.5, offsetFreq 2, low
// randomness); the same node makes stack-bond tile (offset 0), planks (columns 1), and scattered cobblestone
// (size/position/rotation randomness + roundness).
//
// A jittered/scaled/rotated tile can spill into neighbouring cells, so — like Voronoi — each fragment tests
// the 3×3 neighbourhood of cells and keeps the tile it's most inside (max insideness). Distances are in UV
// space (per-axis ÷columns/÷rows) so gaps and rounding stay EVEN regardless of brick aspect, and rotation
// reads visually correct. Seamless in the offline bake: integer columns, and the caller snaps rows to a
// multiple of offsetFreq so the offset cycle closes at the tile edge.
type V = MaterialValue;
const TAU = 6.283185307179586;

export interface TileGrid {
  columns: number;
  rows: number;
  offsetFreq: number; // horizontal offset applied on rows where (row mod offsetFreq) != 0
}

export interface TileUniforms {
  rowOffset: V; // 0..1 of a cell (0.5 = running bond)
  gap: V; // mortar/grout half-width, UV units (even on both axes)
  roundness: V; // 0 = sharp corners, 1 = fully rounded (capsule/ellipse-ish)
  edge: V; // edge softness, UV units
  sizeRandom: V; // 0..1 per-tile size jitter
  posRandom: V; // 0..1 per-tile position jitter (cell units)
  rotRandom: V; // 0..1 per-tile rotation jitter (×±π)
}

export interface TileResult {
  mask: V; // 1 inside a tile, 0 in the gap/grout
  value: V; // per-tile random value [0,1] → colour / roughness / luminance variation
}

export function tilePattern(coord: V, grid: TileGrid, u: TileUniforms): TileResult {
  const { columns: C, rows: R, offsetFreq: F } = grid;
  // An Fn returns a single node, so pack (mask, value) into a vec2 and unpack after.
  const packed = Fn(() => {
    const g = vec2(coord.x.mul(C), coord.y.mul(R)) as V; // grid space (unit cells)
    const baseRow = floor(g.y) as V;
    const best = float(-1e9).toVar(); // winning tile insideness (-SDF; >0 inside)
    const bestVal = float(0).toVar();

    for (let dy = -1; dy <= 1; dy++) {
      const cyf = baseRow.add(dy) as V;
      const cy = int(cyf);
      // this row's horizontal offset (cell units)
      const off = select(mod(cyf, float(F)).notEqual(0), u.rowOffset, float(0)) as V;
      const colBase = floor(g.x.sub(off)) as V;
      for (let dx = -1; dx <= 1; dx++) {
        const cxf = colBase.add(dx) as V;
        const cx = int(cxf);
        const h1 = hashCell2ToVec3Seed(cx, cy, 0, C, R) as V; // xy = position jitter, z = size
        const h2 = hashCell2ToVec3Seed(cx, cy, 1, C, R) as V; // x = rotation, y = value

        // tile centre in grid space + per-tile position jitter (±0.5 cell × posRandom)
        const jx = h1.x.sub(0.5).mul(u.posRandom) as V;
        const jy = h1.y.sub(0.5).mul(u.posRandom) as V;
        const centerX = cxf.add(0.5).add(off).add(jx) as V;
        const centerY = cyf.add(0.5).add(jy) as V;

        // fragment offset from the tile centre, in isotropic UV units
        const duvX = g.x.sub(centerX).div(C) as V;
        const duvY = g.y.sub(centerY).div(R) as V;

        // rotate into the tile's frame (−angle), visually correct in UV space
        const angle = h2.x.sub(0.5).mul(2).mul(u.rotRandom).mul(TAU * 0.5).negate() as V;
        const ca = cos(angle) as V;
        const sa = sin(angle) as V;
        const rx = ca.mul(duvX).sub(sa.mul(duvY)) as V;
        const ry = sa.mul(duvX).add(ca.mul(duvY)) as V;

        // half extents (UV): half a cell, scaled by per-tile size, minus the even gap inset
        const sizeScale = float(1).add(h1.z.sub(0.5).mul(2).mul(u.sizeRandom)) as V;
        const hx = float(0.5).div(C).mul(sizeScale).sub(u.gap) as V;
        const hy = float(0.5).div(R).mul(sizeScale).sub(u.gap) as V;

        // signed distance to a rounded box (negative inside)
        const r = u.roundness.mul(min(hx, hy)) as V;
        const qx = abs(rx).sub(hx.sub(r)) as V;
        const qy = abs(ry).sub(hy.sub(r)) as V;
        const outside = length(vec2(max(qx, 0), max(qy, 0))) as V;
        const inside = min(max(qx, qy), 0) as V;
        const d = outside.add(inside).sub(r) as V; // <0 inside the tile
        const insideness = d.negate() as V;

        const win = insideness.greaterThan(best) as V;
        bestVal.assign(select(win, h2.y, bestVal));
        best.assign(select(win, insideness, best));
      }
    }

    // best is −SDF in UV: >0 inside, 0 at the edge, negative in the gap.
    return vec2(smoothstep(0, u.edge.add(1e-5), best), bestVal);
  })() as V;
  return { mask: packed.x, value: packed.y };
}
