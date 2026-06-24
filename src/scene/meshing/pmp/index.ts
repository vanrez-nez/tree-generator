// PMP mesh-processing module (TypeScript port of selected pmp-library algorithms).
// HalfedgeMesh is the topology core; Three.js BufferGeometry is the import/export boundary.

import type * as THREE from "three";
import { fromBufferGeometry, toBufferGeometry } from "./geometry-adapter";
import {
  linearSubdivision,
  loopSubdivision,
  catmullClarkSubdivision,
  quadTriSubdivision,
  type BoundaryHandling,
} from "./subdivision";
import {
  explicitSmoothing,
  implicitSmoothing,
  type ExplicitSmoothingOptions,
  type ImplicitSmoothingOptions,
} from "./smoothing";
import { decimate, type DecimateOptions } from "./decimation";
import {
  uniformRemeshing,
  adaptiveRemeshing,
  type UniformRemeshingOptions,
  type AdaptiveRemeshingOptions,
} from "./remeshing";

export { HalfedgeMesh, TopologyError } from "./halfedge-mesh";
export type { VertexId, HalfedgeId, EdgeId, FaceId, Point } from "./halfedge-mesh";
export * from "./geometry";
export { faceNormal, vertexNormal, computeFaceNormals, computeVertexNormals } from "./normals";
export { cotanWeight, voronoiArea, clampCot } from "./laplace";
export {
  linearSubdivision,
  loopSubdivision,
  catmullClarkSubdivision,
  quadTriSubdivision,
  type BoundaryHandling,
} from "./subdivision";
export {
  explicitSmoothing,
  implicitSmoothing,
  type LaplaceKind,
  type ExplicitSmoothingOptions,
  type ImplicitSmoothingOptions,
} from "./smoothing";
export { decimate, type DecimateOptions } from "./decimation";
export {
  uniformRemeshing,
  adaptiveRemeshing,
  type UniformRemeshingOptions,
  type AdaptiveRemeshingOptions,
} from "./remeshing";
export { principalCurvatures, maxAbsCurvatures, type Curvatures } from "./curvature";
export { TriangleKdTree, type Triangle, type NearestTriangle } from "./spatial";
export { fromBufferGeometry, toBufferGeometry, NonManifoldError } from "./geometry-adapter";

export type SubdivisionScheme = "linear" | "loop" | "catmull-clark" | "quad-tri";

// Convenience: subdivide a BufferGeometry through the halfedge core and return a new geometry.
// Suitable as a LineMesher geometry processor.
export function subdivideGeometry(
  geometry: THREE.BufferGeometry,
  options: { scheme?: SubdivisionScheme; iterations?: number; boundary?: BoundaryHandling } = {},
): THREE.BufferGeometry {
  const { scheme = "loop", iterations = 1, boundary = "interpolate" } = options;
  const mesh = fromBufferGeometry(geometry);
  for (let i = 0; i < iterations; i += 1) {
    switch (scheme) {
      case "linear":
        linearSubdivision(mesh);
        break;
      case "loop":
        loopSubdivision(mesh, boundary);
        break;
      case "catmull-clark":
        catmullClarkSubdivision(mesh, boundary);
        break;
      case "quad-tri":
        quadTriSubdivision(mesh, boundary);
        break;
    }
  }
  return toBufferGeometry(mesh);
}

// Convenience: explicit-smooth a BufferGeometry through the halfedge core.
export function smoothGeometry(
  geometry: THREE.BufferGeometry,
  options: ExplicitSmoothingOptions = {},
): THREE.BufferGeometry {
  const mesh = fromBufferGeometry(geometry);
  explicitSmoothing(mesh, options);
  return toBufferGeometry(mesh);
}

// Convenience: implicit-smooth a BufferGeometry through the halfedge core.
export function implicitSmoothGeometry(
  geometry: THREE.BufferGeometry,
  options: ImplicitSmoothingOptions = {},
): THREE.BufferGeometry {
  const mesh = fromBufferGeometry(geometry);
  implicitSmoothing(mesh, options);
  return toBufferGeometry(mesh);
}

// Convenience: QEM-decimate a BufferGeometry through the halfedge core.
export function decimateGeometry(
  geometry: THREE.BufferGeometry,
  options: DecimateOptions,
): THREE.BufferGeometry {
  const mesh = fromBufferGeometry(geometry);
  decimate(mesh, options);
  return toBufferGeometry(mesh);
}

// Convenience: uniformly remesh a BufferGeometry through the halfedge core.
export function remeshGeometry(
  geometry: THREE.BufferGeometry,
  options: UniformRemeshingOptions,
): THREE.BufferGeometry {
  const mesh = fromBufferGeometry(geometry);
  uniformRemeshing(mesh, options);
  return toBufferGeometry(mesh);
}

// Convenience: adaptively (curvature-driven) remesh a BufferGeometry through the halfedge core.
export function adaptiveRemeshGeometry(
  geometry: THREE.BufferGeometry,
  options: AdaptiveRemeshingOptions,
): THREE.BufferGeometry {
  const mesh = fromBufferGeometry(geometry);
  adaptiveRemeshing(mesh, options);
  return toBufferGeometry(mesh);
}
