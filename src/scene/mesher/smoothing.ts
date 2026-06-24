import { Vector3 } from "three";
import type { WeldMesh } from "./weld-mesh";
import { lerpVec } from "./tree-node";

// Double-buffered, radius-weighted Laplacian smooth: each vertex moves toward the barycenter of
// its neighbours, scaled by its per-vertex weight (smoothAmount = min(1, radius/length)). Thin
// segments and dense junction rings smooth hard; long straight sections barely move — concentrating
// the rounding exactly at the welds, producing natural fillets.

function addIndexNoDuplicates(indices: number[], index: number): void {
  for (const i of indices) {
    if (i === index) return;
  }
  indices.push(index);
}

function getNeighbourhoods(mesh: WeldMesh): number[][] {
  const neighbourhood: number[][] = Array.from(
    { length: mesh.vertices.length },
    () => [],
  );
  for (const polygon of mesh.polygons) {
    // Faithful port: the original loop starts at i = 1 and wraps.
    for (let i = 1; i < polygon.length; i++) {
      const i1 = polygon[i];
      const i2 = polygon[(i + 1) % polygon.length];
      addIndexNoDuplicates(neighbourhood[i1], i2);
      addIndexNoDuplicates(neighbourhood[i2], i1);
    }
  }
  return neighbourhood;
}

function smoothMeshOnce(
  result: Vector3[],
  previous: Vector3[],
  neighbourhoods: number[][],
  factor: number,
  weights?: number[],
): void {
  for (let i = 0; i < result.length; i++) {
    if (neighbourhoods[i].length <= 1) {
      // Isolated/boundary vertex: keep its previous position.
      result[i].copy(previous[i]);
      continue;
    }
    const barycenter = new Vector3();
    for (const n of neighbourhoods[i]) barycenter.add(previous[n]);
    barycenter.divideScalar(neighbourhoods[i].length);
    const trueFactor = weights ? factor * weights[i] : factor;
    result[i] = lerpVec(previous[i], barycenter, trueFactor);
  }
}

export function smoothMesh(
  mesh: WeldMesh,
  iterations: number,
  factor: number,
  weights?: number[],
): void {
  const neighbourhoods = getNeighbourhoods(mesh);
  let previous = mesh.vertices;
  let result = mesh.vertices.map((v) => v.clone());

  for (let i = 0; i < iterations; i++) {
    smoothMeshOnce(result, previous, neighbourhoods, factor, weights);
    const tmp = previous;
    previous = result;
    result = tmp;
  }

  // After the final swap, `previous` holds the most recently written buffer.
  mesh.vertices = previous;
}
