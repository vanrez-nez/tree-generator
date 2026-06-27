import type { WeldMesh } from "./weld-mesh";
import { getNeighbourhoods } from "./smoothing";

// Baked per-vertex ambient occlusion, computed once at mesh-build time (no per-frame cost — the scene
// hosts hundreds of trees, so dynamic shadows are out). This is a cheap GEOMETRIC "cavity" estimate: a
// vertex is occluded to the degree its neighbours sit ABOVE its tangent plane (i.e. toward its normal),
// which is exactly what happens in fork crotches and branch↔trunk insets. It is material-independent —
// the surface material multiplies it into its AO channel, so any tree shape/material gets form occlusion.
//
// It does NOT capture long-range occlusion (one branch shadowing another across open space); that would
// need a BVH raycast pass. The local-concavity term is what makes the junctions read with depth.

export interface CavityAoOptions {
  strength?: number; // how hard concavity darkens (ao = 1 - strength * obscurance). ~1.5–3.
  diffuseIterations?: number; // Laplacian smoothing passes to widen/soften the dark bands.
  diffuseFactor?: number; // per-iteration blend toward the neighbour average (0..1).
  min?: number; // floor so deep crevices never go fully black.
}

const DEFAULTS: Required<CavityAoOptions> = {
  strength: 3.5,
  diffuseIterations: 4,
  diffuseFactor: 0.5,
  min: 0.1,
};

// `sharedPositions` / `smoothNormals` are the flat Float32 arrays of the INDEXED (welded) geometry the
// caller already built for smooth-normal computation — vertex i occupies [i*3, i*3+3). Returns one AO
// scalar per welded vertex (∈ [min, 1]); the caller expands it per-corner alongside positions/normals.
export function computeVertexCavityAo(
  mesh: WeldMesh,
  sharedPositions: Float32Array,
  smoothNormals: Float32Array,
  options: CavityAoOptions = {},
): Float32Array {
  const { strength, diffuseIterations, diffuseFactor, min } = { ...DEFAULTS, ...options };
  const count = mesh.vertices.length;
  const neighbourhoods = getNeighbourhoods(mesh);
  let ao = new Float32Array(count);

  // 1. Local concavity → obscurance → AO.
  for (let i = 0; i < count; i++) {
    const neighbours = neighbourhoods[i];
    if (neighbours.length === 0) {
      ao[i] = 1;
      continue;
    }
    const px = sharedPositions[i * 3];
    const py = sharedPositions[i * 3 + 1];
    const pz = sharedPositions[i * 3 + 2];
    const nx = smoothNormals[i * 3];
    const ny = smoothNormals[i * 3 + 1];
    const nz = smoothNormals[i * 3 + 2];

    let obscurance = 0;
    for (const j of neighbours) {
      let dx = sharedPositions[j * 3] - px;
      let dy = sharedPositions[j * 3 + 1] - py;
      let dz = sharedPositions[j * 3 + 2] - pz;
      const len = Math.hypot(dx, dy, dz);
      if (len < 1e-9) continue;
      dx /= len;
      dy /= len;
      dz /= len;
      // saturate(dot(dir_to_neighbour, normal)): >0 when the neighbour bends toward the normal (concave).
      const d = dx * nx + dy * ny + dz * nz;
      if (d > 0) obscurance += d;
    }
    obscurance /= neighbours.length;
    ao[i] = Math.max(min, Math.min(1, 1 - strength * obscurance));
  }

  // 2. Diffuse (double-buffered Laplacian) so the occlusion reads as a soft band, not a thin crease.
  if (diffuseIterations > 0) {
    let next = new Float32Array(count);
    for (let it = 0; it < diffuseIterations; it++) {
      for (let i = 0; i < count; i++) {
        const neighbours = neighbourhoods[i];
        if (neighbours.length === 0) {
          next[i] = ao[i];
          continue;
        }
        let sum = 0;
        for (const j of neighbours) sum += ao[j];
        const avg = sum / neighbours.length;
        next[i] = ao[i] + (avg - ao[i]) * diffuseFactor;
      }
      const tmp = ao;
      ao = next;
      next = tmp;
    }
  }

  return ao;
}
