import { Vector2, Vector3 } from "three";
import { WeldMesh } from "./weld-mesh";
import { smoothMesh } from "./smoothing";
import {
  isLeaf,
  lerp,
  projectedOnPlane,
  UV_WORLD_PER_TILE,
  type CapGroup,
  type NodeChild,
  type Stem,
  type TreeNode,
} from "./tree-node";

// The welding mesher (a TS port of m_tree's ManifoldMesher). A branch is a stack of circular
// cross-section rings bridged by quads. At a junction (a node with >= 2 children) it:
//   1. finds where each child sits on the parent ring (angle),
//   2. converts the child radius into an angular index band (the hole),
//   3. bridges the parent ring while SKIPPING those bands (punching holes),
//   4. builds each child's base ring FROM the parent hole-rim vertices and stitches quads to it
//      (shared topology = the weld),
//   5. corrects the seam twist,
//   6. recurses.
// A final radius-weighted Laplacian smooth rounds the welds into organic fillets.

interface CircleDesignator {
  vertexIndex: number;
  uvIndex: number;
  radialN: number;
}

interface IndexRange {
  minIndex: number;
  maxIndex: number;
}

const TAU = 2 * Math.PI;

function getSmoothAmount(radius: number, nodeLength: number): number {
  return Math.min(1, radius / nodeLength);
}

/**
 * Emit one ring of `radialN` vertices in the plane spanned by `right`/`up` around `center`.
 * A ring stores `radialN` positions but `radialN + 1` UVs (the seam doesn't wrap back to x=0).
 */
function emitRing(
  center: Vector3,
  right: Vector3,
  up: Vector3,
  direction: Vector3,
  radialN: number,
  radius: number,
  smoothAmount: number,
  mesh: WeldMesh,
  uvY: number,
  uRepeat: number,
): CircleDesignator {
  const vertexIndex = mesh.vertices.length;
  const uvIndex = mesh.uvs.length;

  for (let i = 0; i < radialN; i++) {
    const angle = (i / radialN) * TAU;
    const point = right
      .clone()
      .multiplyScalar(Math.cos(angle))
      .addScaledVector(up, Math.sin(angle))
      .multiplyScalar(radius)
      .add(center);
    const index = mesh.addVertex(point);
    mesh.smoothAmount[index] = smoothAmount;
    mesh.radius[index] = radius;
    mesh.directionA[index] = direction.clone();
    // u repeats the texture `uRepeat` times around (integer ⇒ seamless wrap; ∝ radius ⇒ consistent
    // world texel size). Seam vertex carries u = uRepeat (the wrap value), not 1.
    mesh.uvs.push(new Vector2((i / radialN) * uRepeat, uvY));
  }
  mesh.uvs.push(new Vector2(uRepeat, uvY));
  return { vertexIndex, uvIndex, radialN };
}

/** Emit one ring of `radialNPoints` vertices around `node` at parametric `factor`. */
function addCircle(
  nodePosition: Vector3,
  node: TreeNode,
  factor: number,
  radialNPoints: number,
  mesh: WeldMesh,
  uvY: number,
): CircleDesignator {
  const right = node.tangent;
  const up = node.tangent.clone().cross(node.direction);
  const circlePosition = nodePosition
    .clone()
    .addScaledVector(node.direction, node.length * factor);
  const radius = isLeaf(node)
    ? node.radius
    : lerp(node.radius, node.children[0].node.radius, factor);
  const smoothAmount = getSmoothAmount(radius, node.length);

  return emitRing(
    circlePosition,
    right,
    up,
    node.direction,
    radialNPoints,
    radius,
    smoothAmount,
    mesh,
    uvY,
    node.uRepeat,
  );
}

function isIndexInBranchMask(
  mask: IndexRange[],
  index: number,
  radialNPoints: number,
): boolean {
  const offset = Math.floor(radialNPoints / 2);
  for (const range of mask) {
    let i = index;
    let min = range.minIndex;
    let max = range.maxIndex;
    if (max < min) {
      i = (i + offset) % radialNPoints;
      min = (min + offset) % radialNPoints;
      max = (max + offset) % radialNPoints;
    }
    if (i >= min && i < max) {
      return true;
    }
  }
  return false;
}

/** Bridge two rings into a quad strip, skipping indices masked by child holes. */
function bridgeCircles(
  first: CircleDesignator,
  second: CircleDesignator,
  radialNPoints: number,
  mesh: WeldMesh,
  mask?: IndexRange[],
): void {
  for (let i = 0; i < radialNPoints; i++) {
    if (mask && isIndexInBranchMask(mask, i, radialNPoints)) {
      continue;
    }
    const p = mesh.addPolygon();
    mesh.polygons[p] = [
      first.vertexIndex + i,
      first.vertexIndex + ((i + 1) % radialNPoints),
      second.vertexIndex + ((i + 1) % radialNPoints),
      second.vertexIndex + i,
    ];
    // A ring of n points has n distinct positions but n+1 distinct UVs (no wrap to x=0).
    mesh.uvLoops[p] = [
      first.uvIndex + i,
      first.uvIndex + (i + 1),
      second.uvIndex + (i + 1),
      second.uvIndex + i,
    ];
  }
}

function getBranchAngleAroundParent(parent: TreeNode, branch: TreeNode): number {
  const projected = projectedOnPlane(branch.direction, parent.direction).normalize();
  const right = parent.tangent;
  const up = right.clone().cross(parent.direction);
  const cosAngle = projected.dot(right);
  const sinAngle = projected.dot(up);
  return ((Math.atan2(sinAngle, cosAngle) % TAU) + TAU) % TAU;
}

function getBranchIndicesOnCircle(
  radialNPoints: number,
  branchAngle: number,
  angleDelta: number,
): IndexRange {
  const increment = TAU / radialNPoints;
  const minIndex = Math.floor(
    (((branchAngle - angleDelta + TAU) % TAU) + TAU) % TAU / increment,
  );
  const maxIndex = Math.floor(
    (((branchAngle + angleDelta + increment + TAU) % TAU) + TAU) % TAU / increment,
  );
  return { minIndex, maxIndex };
}

// The half-angle a child of `branchRadius` wants to occupy on a parent ring of `parentRadius`.
function desiredHalfAngle(parentRadius: number, branchRadius: number): number {
  return Math.asin(Math.max(-1, Math.min(1, branchRadius / parentRadius)));
}

// Build one hole band per side child (children[1..]). When several children share the SAME node
// (e.g. the basal whorl of roots, all attached at one trunk segment), their desired bands can sum
// past 360° and overlap — which makes multiple child base rings stitch to the same parent rim
// vertices, producing non-manifold/boundary edges at the junction. To prevent that, each band's
// half-angle is clamped so it can't reach within one ring slot of its angular neighbour. A lone
// side child (the common branch case) is never clamped, so ordinary junctions are unchanged.
function getChildrenRanges(node: TreeNode, radialNPoints: number): IndexRange[] {
  const kids: { angle: number; half: number }[] = [];
  for (let i = 1; i < node.children.length; i++) {
    const child = node.children[i];
    kids.push({
      angle: getBranchAngleAroundParent(node, child.node),
      half: desiredHalfAngle(node.radius, child.node.radius),
    });
  }

  if (kids.length > 1) {
    const increment = TAU / radialNPoints;
    const order = kids.map((_, i) => i).sort((a, b) => kids[a].angle - kids[b].angle);
    for (let k = 0; k < order.length; k++) {
      const cur = kids[order[k]];
      const next = kids[order[(k + 1) % order.length]];
      const prev = kids[order[(k - 1 + order.length) % order.length]];
      const gapNext = (((next.angle - cur.angle) % TAU) + TAU) % TAU;
      const gapPrev = (((cur.angle - prev.angle) % TAU) + TAU) % TAU;
      // Half the smaller neighbour gap, minus one ring slot so adjacent holes never touch.
      const maxHalf = Math.max(0, Math.min(gapNext, gapPrev) / 2 - increment);
      if (cur.half > maxHalf) cur.half = maxHalf;
    }
  }

  return kids.map((k) => getBranchIndicesOnCircle(radialNPoints, k.angle, k.half));
}

/** Collect the parent hole-rim vertex indices in loop order (lower arc, then upper arc reversed). */
function getChildIndexOrder(
  parentBase: CircleDesignator,
  childRadialN: number,
  childRange: IndexRange,
): number[] {
  const childBaseIndices = new Array<number>(childRadialN);
  const half = Math.floor(childRadialN / 2);
  for (let i = 0; i < half; i++) {
    const lowerIndex =
      ((childRange.minIndex + i) % parentBase.radialN) + parentBase.vertexIndex;
    const upperIndex = lowerIndex + parentBase.radialN;
    childBaseIndices[i] = lowerIndex;
    childBaseIndices[childRadialN - i - 1] = upperIndex;
  }
  return childBaseIndices;
}

function addChildBaseGeometry(
  childBaseIndices: number[],
  childBase: CircleDesignator,
  childRadius: number,
  childPos: Vector3,
  offset: number,
  smoothAmount: number,
  mesh: WeldMesh,
): void {
  const a = mesh.vertices[childBaseIndices[2]].clone().sub(mesh.vertices[childBaseIndices[0]]);
  const b = mesh.vertices[childBaseIndices[1]].clone().sub(mesh.vertices[childBaseIndices[0]]);
  const direction = a.cross(b).normalize();

  const childBaseCenter = new Vector3();
  for (const idx of childBaseIndices) childBaseCenter.add(mesh.vertices[idx]);
  childBaseCenter.divideScalar(childBaseIndices.length);

  for (let i = 0; i < childBase.radialN; i++) {
    const index = (i + offset) % childBase.radialN;
    const vertex = mesh.vertices[childBaseIndices[index]]
      .clone()
      .sub(childBaseCenter)
      .normalize()
      .multiplyScalar(childRadius)
      .add(childPos);
    const added = mesh.addVertex(vertex);
    mesh.smoothAmount[added] = smoothAmount;
    mesh.radius[added] = childRadius;
    mesh.directionA[added] = direction.clone();

    const p = mesh.addPolygon();
    mesh.polygons[p] = [
      childBaseIndices[index],
      childBaseIndices[(index + 1) % childBase.radialN],
      childBase.vertexIndex + ((i + 1) % childBase.radialN),
      childBase.vertexIndex + i,
    ];
    // Skirt UVs: a uniform ring band in the child chart. Both rim and child-base corners are keyed
    // by the loop index `i` (NOT the rotated parent-rim `index`), so the band has uniform x = i/N and
    // matches the child tube above — no fan/compression. Each ring has N+1 UVs (raw i/i+1 = seam).
    const ringStart = childBase.uvIndex;
    const rimStart = ringStart - (childBase.radialN + 1);
    mesh.uvLoops[p] = [
      rimStart + i,
      rimStart + (i + 1),
      ringStart + (i + 1),
      ringStart + i,
    ];
  }
}

function getChildTwist(child: TreeNode, parent: TreeNode): number {
  const projectedParentDir = projectedOnPlane(parent.direction, child.direction).normalize();
  const right = projectedParentDir;
  const up = right.clone().cross(child.direction);
  const cosAngle = child.tangent.dot(right);
  const sinAngle = child.tangent.dot(up);
  return ((Math.atan2(sinAngle, cosAngle) % TAU) + TAU) % TAU;
}

// UVs for the junction skirt + child base ring. Both rings are in the CHILD's chart (x = around the
// child, N+1 entries for the wrap seam), so the skirt is a uniform ring band — bark grain runs
// axially and at the same density as the child tube, with no fan/compression or rotated island.
// Returns the child-base ring index (the rim ring sits one band-height below it).
function addChildBaseUvs(
  parentUvY: number,
  childRadialN: number,
  childURepeat: number,
  bandHeight: number,
  mesh: WeldMesh,
): number {
  const bandV = parentUvY - bandHeight; // thin collar band, in v (tile) units

  // Rim ring (parent-rim corners of the skirt), one band-height below the child base ring. Uses the
  // child's u-repeat so it's continuous with the child tube above.
  for (let i = 0; i < childRadialN; i++) {
    mesh.uvs.push(new Vector2((i / childRadialN) * childURepeat, bandV));
  }
  mesh.uvs.push(new Vector2(childURepeat, bandV));

  // Child base ring, continuous with the child tube's first bridge above (at parentUvY).
  const ringUvStartIndex = mesh.uvs.length;
  for (let i = 0; i < childRadialN; i++) {
    mesh.uvs.push(new Vector2((i / childRadialN) * childURepeat, parentUvY));
  }
  mesh.uvs.push(new Vector2(childURepeat, parentUvY));

  return ringUvStartIndex;
}

function addChildCircle(
  parent: TreeNode,
  child: NodeChild,
  childPos: Vector3,
  parentBase: CircleDesignator,
  childRange: IndexRange,
  uvY: number,
  mesh: WeldMesh,
): CircleDesignator {
  const smoothAmount = getSmoothAmount(child.node.radius, parent.length);

  const childRadialN =
    2 *
    (((childRange.maxIndex - childRange.minIndex + parentBase.radialN) %
      parentBase.radialN) +
      1);
  const childBaseIndices = getChildIndexOrder(parentBase, childRadialN, childRange);

  const childTwist = getChildTwist(child.node, parent);
  const offset =
    ((Math.trunc(
      (childTwist / TAU) * childRadialN -
        Math.floor(childRadialN / 4) +
        childRadialN,
    ) %
      childRadialN) +
      childRadialN) %
    childRadialN;

  const childBase: CircleDesignator = {
    vertexIndex: mesh.vertices.length,
    uvIndex: mesh.uvs.length,
    radialN: childRadialN,
  };
  // Collar band ~ parent radius tall, expressed in v (tile) units.
  const bandHeight = parent.radius / UV_WORLD_PER_TILE;
  childBase.uvIndex = addChildBaseUvs(uvY, childRadialN, child.node.uRepeat, bandHeight, mesh);
  addChildBaseGeometry(
    childBaseIndices,
    childBase,
    child.node.radius,
    childPos,
    offset,
    smoothAmount,
    mesh,
  );
  return childBase;
}

function getSideChildPosition(
  parent: TreeNode,
  child: NodeChild,
  nodePosition: Vector3,
): Vector3 {
  const tangent = projectedOnPlane(child.node.direction, parent.direction).normalize();
  return nodePosition
    .clone()
    .addScaledVector(parent.direction, parent.length * child.positionInParent)
    .addScaledVector(tangent, parent.radius);
}

/** Note: the original ignores the parametric `factor` here. */
function getPositionInNode(nodePosition: Vector3, node: TreeNode): Vector3 {
  return nodePosition.clone().addScaledVector(node.direction, node.length);
}

export interface CapParams {
  /** axial extent of the cap, in multiples of the tip radius (0 = flat) */
  length: number;
  /** 0 = straight cone (sharp), 1 = quarter-circle dome (rounded) */
  roundness: number;
}

const CAP_EPSILON = 1e-6;
const CAP_MAX_BANDS = 4;

/**
 * Close an open leaf tip (`endCircle`) with a cap. The profile is a stack of shrinking rings
 * from the terminal ring to a single apex vertex; `length` sets how far it extends (× tip radius)
 * and `roundness` blends a straight cone into a quarter-circle dome.
 */
function addCap(
  node: TreeNode,
  nodePosition: Vector3,
  endCircle: CircleDesignator,
  cap: CapParams,
  mesh: WeldMesh,
  uvY: number,
): void {
  const radialN = endCircle.radialN;
  const tipRadius = node.radius;
  const axialMax = cap.length * tipRadius;

  const right = node.tangent;
  const up = node.tangent.clone().cross(node.direction);
  const baseCenter = nodePosition.clone().addScaledVector(node.direction, node.length);

  // A cone is exact with a single band (direct fan); a dome needs a few bands to stay smooth.
  const bands =
    axialMax <= CAP_EPSILON ? 1 : Math.max(1, Math.round(1 + cap.roundness * (CAP_MAX_BANDS - 1)));

  let previous = endCircle;

  for (let k = 1; k < bands; k++) {
    const s = k / bands;
    const radiusScale = lerp(1 - s, Math.cos((s * Math.PI) / 2), cap.roundness);
    const axialNorm = lerp(s, Math.sin((s * Math.PI) / 2), cap.roundness);
    const ringRadius = tipRadius * radiusScale;
    const center = baseCenter.clone().addScaledVector(node.direction, axialMax * axialNorm);
    const ring = emitRing(
      center,
      right,
      up,
      node.direction,
      radialN,
      ringRadius,
      getSmoothAmount(ringRadius, node.length),
      mesh,
      uvY + s,
      node.uRepeat,
    );
    bridgeCircles(previous, ring, radialN, mesh);
    previous = ring;
  }

  // Apex: at s = 1 both profiles give radius 0 and axialNorm 1.
  const apexPosition = baseCenter.clone().addScaledVector(node.direction, axialMax);
  const apexIndex = mesh.addVertex(apexPosition);
  mesh.smoothAmount[apexIndex] = 0;
  mesh.radius[apexIndex] = 0;
  mesh.directionA[apexIndex] = node.direction.clone();
  const apexUvIndex = mesh.uvs.length;
  mesh.uvs.push(new Vector2(0.5 * node.uRepeat, uvY + 1));

  // Fan the last ring to the apex. The duplicated apex corner collapses each quad to a single
  // triangle, with the same winding bridgeCircles uses (outward after to-buffer's reversal).
  for (let i = 0; i < radialN; i++) {
    const p = mesh.addPolygon();
    mesh.polygons[p] = [
      previous.vertexIndex + i,
      previous.vertexIndex + ((i + 1) % radialN),
      apexIndex,
      apexIndex,
    ];
    mesh.uvLoops[p] = [
      previous.uvIndex + i,
      previous.uvIndex + (i + 1),
      apexUvIndex,
      apexUvIndex,
    ];
  }
}

// Close the open trunk base (the start ring) with a flat fan to its centre. The start ring is only
// ever bridged on its upper side, so without this the bottom of the trunk is a hole — visible from
// below (you see up into the hollow trunk) and leaving the surface non-watertight. The fan winding
// is reversed relative to the tip cap so the bottom face normal points down (outward at the base).
function addBaseCap(stem: Stem, startCircle: CircleDesignator, mesh: WeldMesh): void {
  const apexIndex = mesh.addVertex(stem.position.clone());
  mesh.smoothAmount[apexIndex] = 0;
  mesh.radius[apexIndex] = 0;
  mesh.directionA[apexIndex] = stem.node.direction.clone().negate();
  const apexUvIndex = mesh.uvs.length;
  mesh.uvs.push(new Vector2(0.5 * stem.node.uRepeat, 0));

  const radialN = startCircle.radialN;
  for (let i = 0; i < radialN; i++) {
    const p = mesh.addPolygon();
    mesh.polygons[p] = [
      startCircle.vertexIndex + ((i + 1) % radialN),
      startCircle.vertexIndex + i,
      apexIndex,
      apexIndex,
    ];
    mesh.uvLoops[p] = [
      startCircle.uvIndex + (i + 1),
      startCircle.uvIndex + i,
      apexUvIndex,
      apexUvIndex,
    ];
  }
}

function meshNodeRec(
  node: TreeNode,
  nodePosition: Vector3,
  base: CircleDesignator,
  mesh: WeldMesh,
  uvY: number,
  opts: MesherOptions,
): void {
  // v advances by world arc-length / tile size — consistent axial texel density regardless of radius.
  const uvGrowth = node.length / UV_WORLD_PER_TILE;

  if (node.children.length < 2) {
    const childCircle = addCircle(nodePosition, node, 1, base.radialN, mesh, uvY + uvGrowth);
    bridgeCircles(base, childCircle, base.radialN, mesh);
    if (isLeaf(node)) {
      addCap(node, nodePosition, childCircle, opts.caps[node.capGroup], mesh, uvY + uvGrowth);
    } else {
      const childPos = getPositionInNode(nodePosition, node);
      meshNodeRec(node.children[0].node, childPos, childCircle, mesh, uvY + uvGrowth, opts);
    }
    return;
  }

  const endCircle = addCircle(nodePosition, node, 1, base.radialN, mesh, uvY + uvGrowth);
  const childrenRanges = getChildrenRanges(node, base.radialN);
  bridgeCircles(base, endCircle, base.radialN, mesh, childrenRanges);

  for (let i = 0; i < node.children.length; i++) {
    if (i === 0) {
      const childPos = getPositionInNode(nodePosition, node);
      meshNodeRec(node.children[0].node, childPos, endCircle, mesh, uvY + uvGrowth, opts);
    } else {
      const child = node.children[i];
      const childPos = getSideChildPosition(node, child, nodePosition);
      const childBase = addChildCircle(
        node,
        child,
        childPos,
        base,
        childrenRanges[i - 1],
        uvY,
        mesh,
      );
      meshNodeRec(child.node, childPos, childBase, mesh, uvY + uvGrowth, opts);
    }
  }
}

export interface MesherOptions {
  radialResolution: number;
  smoothIterations: number;
  /** Per-group tip-cap shape, keyed by node `capGroup`. */
  caps: Record<CapGroup, CapParams>;
}

/** Mesh a single stem (trunk + welded branches/roots) into one watertight WeldMesh. */
export function meshTree(stem: Stem, opts: MesherOptions): WeldMesh {
  const mesh = new WeldMesh();
  if (stem.node.children.length === 0) return mesh;

  const startCircle: CircleDesignator = {
    vertexIndex: mesh.vertices.length,
    uvIndex: mesh.uvs.length,
    radialN: opts.radialResolution,
  };
  addCircle(stem.position, stem.node, 0, opts.radialResolution, mesh, 0);
  meshNodeRec(stem.node, stem.position, startCircle, mesh, 0, opts);
  addBaseCap(stem, startCircle, mesh);

  if (opts.smoothIterations > 0) {
    smoothMesh(mesh, opts.smoothIterations, 1, mesh.smoothAmount);
  }
  return mesh;
}
