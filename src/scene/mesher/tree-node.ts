import { Vector3 } from "three";

// Skeleton model consumed by the welding mesher (a TS port of m_tree's ManifoldMesher).
//
// A `TreeNode` is one straight segment. A whole tree is a hierarchy of these:
//   children[0]   = the continuation of the current axis (the branch flows through it)
//   children[1..] = side branches budding off this segment's wall
//
// `Stem` pairs the root node with its world-space base position. The mesher walks the
// hierarchy from the stem and welds every segment into one watertight surface.

/** Which limb system a node belongs to — selects the tip-cap profile in the mesher. */
export type CapGroup = "trunk" | "branch" | "root";

// World size (in scene units) of one texture tile. UVs are scaled so one tile spans roughly this
// much surface in BOTH axes regardless of tube radius, so bark features read at a consistent scale
// on the fat trunk and the thin branches/roots (instead of u always mapping [0,1] per ring, which
// made trunk features larger). Smaller = finer/denser texture.
export const UV_WORLD_PER_TILE = 1.2;

export interface TreeNode {
  children: NodeChild[];
  /** unit growth direction of this segment */
  direction: Vector3;
  /** stable "right" reference, carried down so cross-sections don't twist randomly */
  tangent: Vector3;
  /** segment length along `direction` */
  length: number;
  /** cross-section radius at the node base */
  radius: number;
  /**
   * Texture tiles around the circumference (integer, ≥1). Chosen per tube ∝ circumference so the
   * texel density is world-consistent and the wrap stays seamless (integer repeats). Default 1.
   */
  uRepeat: number;
  /** authoring/source id; the graph adapter uses 0 for every generated segment */
  creatorId: number;
  /** trunk/branch/root, so leaf tips pick the matching cap shape */
  capGroup: CapGroup;
}

export interface NodeChild {
  node: TreeNode;
  /** position along the parent segment where this child attaches, in [0, 1] */
  positionInParent: number;
}

export interface Stem {
  node: TreeNode;
  position: Vector3;
}

// Mirrors the original Node constructor: the tangent is the parent tangent projected onto
// the plane perpendicular to `direction`, then normalized — a minimal-twist frame down the chain.
export function createNode(
  direction: Vector3,
  parentTangent: Vector3,
  length: number,
  radius: number,
  capGroup: CapGroup = "branch",
  creatorId = 0,
): TreeNode {
  const tangent = projectedOnPlane(parentTangent, direction).normalize();
  return {
    children: [],
    direction: direction.clone(),
    tangent,
    length,
    radius,
    uRepeat: 1,
    creatorId,
    capGroup,
  };
}

export function isLeaf(node: TreeNode): boolean {
  return node.children.length === 0;
}

// Geometry helpers. THREE.Vector3 methods mutate in place; every helper here returns a fresh
// vector and never mutates its inputs, matching the value semantics of the original Eigen code.

export function lerp(a: number, b: number, t: number): number {
  t = Math.min(1, Math.max(0, t));
  return t * b + (1 - t) * a;
}

export function lerpVec(a: Vector3, b: Vector3, t: number): Vector3 {
  // The original lerp(Vector3) does NOT clamp t; keep that behaviour.
  return a.clone().multiplyScalar(1 - t).addScaledVector(b, t);
}

/** Component of `v` lying in the plane with the given normal (v minus its projection on the normal). */
export function projectedOnPlane(v: Vector3, planeNormal: Vector3): Vector3 {
  const offset = planeNormal.clone().multiplyScalar(v.dot(planeNormal));
  return v.clone().sub(offset);
}

/** Some unit vector orthogonal to `v`. */
export function getOrthogonalVector(v: Vector3): Vector3 {
  const tmp = Math.abs(v.z) < 0.95 ? new Vector3(1, 0, 0) : new Vector3(0, 1, 0);
  return tmp.cross(v).normalize();
}
