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

const frac = (x: number): number => ((x % 1) + 1) % 1;

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
  uPhase: number,
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
    // world texel size), shifted by the tube's constant phase. Seam vertex carries the wrap value
    // u = uRepeat + uPhase, not 1.
    mesh.addUv(new Vector2((i / radialN) * uRepeat + uPhase, uvY));
  }
  mesh.addUv(new Vector2(uRepeat + uPhase, uvY));
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
    node.uPhase,
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
    // by the loop index `i` (NOT the rotated parent-rim `index`), so each ring has uniform u spacing
    // and the band matches the child tube above — no fan/compression. Each ring has N+1 UVs
    // (raw i/i+1 = seam); u values (repeat/phase per ring) come from addChildBaseUvs.
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
// child, N+1 entries for the wrap seam) with the SAME repeat and phase, so the skirt is a uniform,
// shear-free ring band — bark grain runs axially with no fan/compression or rotated island.
// Both rings MUST share one repeat count: a rim-specific repeat (tried once, to match the parent's
// texel density at the cut) makes the two rings' u diverge around the loop — they can only agree at
// the anchor — which shears whole tiles diagonally through the thin band near the wrap seam (dense
// stripes on fat children, i.e. roots). The residual density mismatch at the cut is hidden by the
// cross-fade (uvs2/blend) instead. The shared phase lines u up with the parent's u at the
// attachment angle (see addChildCircle).
// Returns the child-base ring index (the rim ring sits one band-height below it).
function addChildBaseUvs(
  rimV: number,
  baseV: number,
  childRadialN: number,
  childURepeat: number,
  childUPhase: number,
  mesh: WeldMesh,
): number {
  // Rim ring (parent-rim corners of the skirt), one band-height below the child base ring.
  // (applySkirtParentUvs later overwrites these entries' uvs2/blend with the parent chart.)
  for (let i = 0; i < childRadialN; i++) {
    mesh.addUv(new Vector2((i / childRadialN) * childURepeat + childUPhase, rimV));
  }
  mesh.addUv(new Vector2(childURepeat + childUPhase, rimV));

  // Child base ring — continuous with the child tube's first bridge above.
  const ringUvStartIndex = mesh.uvs.length;
  for (let i = 0; i < childRadialN; i++) {
    mesh.addUv(new Vector2((i / childRadialN) * childURepeat + childUPhase, baseV));
  }
  mesh.addUv(new Vector2(childURepeat + childUPhase, baseV));

  return ringUvStartIndex;
}

const wrapToPi = (x: number): number => ((((x + Math.PI) % TAU) + TAU) % TAU) - Math.PI;

// Fill in the skirt band's SECOND UV set: the parent chart, plus a cross-fade weight (1 at the
// parent rim → 0 at the child base). The surface samples both charts inside the band and mixes,
// so at the rim the blend equals the parent faces exactly and at the child base it equals the
// child tube — the chart cut becomes a band-tall fade instead of a hard edge.
// Runs after addChildBaseGeometry so the lifted base-ring vertex positions exist.
function applySkirtParentUvs(
  parent: TreeNode,
  parentPos: Vector3,
  parentBaseV: number,
  parentBase: CircleDesignator,
  childRange: IndexRange,
  childBase: CircleDesignator,
  offset: number,
  mesh: WeldMesh,
): void {
  const radialN = childBase.radialN;
  const half = Math.floor(radialN / 2);
  const uvGrowth = parent.length / UV_WORLD_PER_TILE;
  const rimUvStart = childBase.uvIndex - (radialN + 1);

  // Raw (un-wrapped) angular center of the hole: rim slots run minIndex..minIndex+half-1 WITHOUT
  // the modulo, so u2 stays monotonic even when the hole crosses the parent's own wrap seam
  // (a whole-tile offset is invisible with a tiling texture).
  const slotAngle = TAU / parentBase.radialN;
  const centerAngle = (childRange.minIndex + (half - 1) / 2) * slotAngle;

  // Rim ring: the exact parent-chart uv of each rim vertex (they ARE parent ring vertices; the
  // parent base ring sits at parentBaseV, the end ring one uvGrowth above). Loop slot i maps to
  // childBaseIndices[(i + offset) % N], which is lower-arc slot minIndex+j for j < half and
  // upper-arc slot minIndex+(N-1-j) above it for j >= half (see getChildIndexOrder).
  for (let i = 0; i < radialN; i++) {
    const j = (i + offset) % radialN;
    const lower = j < half;
    const rawSlot = childRange.minIndex + (lower ? j : radialN - 1 - j);
    const u2 = (rawSlot / parentBase.radialN) * parent.uRepeat + parent.uPhase;
    const v2 = lower ? parentBaseV : parentBaseV + uvGrowth;
    mesh.uvs2[rimUvStart + i] = new Vector2(u2, v2);
    mesh.blend[rimUvStart + i] = 1;
  }
  // The extra wrap entry closes the loop in the CHILD chart only; the parent chart is continuous
  // around the rim, so it repeats entry 0.
  mesh.uvs2[rimUvStart + radialN] = mesh.uvs2[rimUvStart].clone();
  mesh.blend[rimUvStart + radialN] = 1;

  // Child base ring: extrapolate each lifted vertex's parent cylinder coordinates (angle around /
  // arc length along the parent), unwrapped around the hole center so the band interpolates within
  // one period. blend stays 0 here — uv2 only steers the interpolation inside the band.
  const right = parent.tangent;
  const up = right.clone().cross(parent.direction);
  for (let i = 0; i < radialN; i++) {
    const p = mesh.vertices[childBase.vertexIndex + i].clone().sub(parentPos);
    const axial = p.dot(parent.direction);
    const radial = p.addScaledVector(parent.direction, -axial);
    const rawAngle = Math.atan2(radial.dot(up), radial.dot(right));
    const angle = centerAngle + wrapToPi(rawAngle - centerAngle);
    const u2 = (angle / TAU) * parent.uRepeat + parent.uPhase;
    const v2 = parentBaseV + axial / UV_WORLD_PER_TILE;
    mesh.uvs2[childBase.uvIndex + i] = new Vector2(u2, v2);
  }
  mesh.uvs2[childBase.uvIndex + radialN] = mesh.uvs2[childBase.uvIndex].clone();
}

function addChildCircle(
  parent: TreeNode,
  child: NodeChild,
  childPos: Vector3,
  parentPos: Vector3,
  parentBase: CircleDesignator,
  childRange: IndexRange,
  uvAttach: number,
  mesh: WeldMesh,
): { circle: CircleDesignator; childStartUvY: number } {
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

  // Parent-chart u at the attachment angle — the anchor the child chart phase-locks to.
  const branchAngle = getBranchAngleAroundParent(parent, child.node);
  const parentU = (branchAngle / TAU) * parent.uRepeat + parent.uPhase;

  // The graph adapter aims the child head tangent (u = 0, the wrap seam) down the parent axis, so
  // loop index N/2 — u at half the repeat — faces up it: anchoring that u to parentU makes the
  // texture phase continuous at the crotch top, with the wrap seam hidden on the underside.
  const childUPhase = frac(parentU - 0.5 * child.node.uRepeat);
  // The whole child tube adopts the phase (meshNodeRec copies it down children[0]).
  child.node.uPhase = childUPhase;

  const childBase: CircleDesignator = {
    vertexIndex: mesh.vertices.length,
    // Skirt uvs are pushed AFTER the geometry so the band height can be measured from the actual
    // vertex positions; the rim ring's N+1 entries come first, then the child base ring.
    uvIndex: mesh.uvs.length + childRadialN + 1,
    radialN: childRadialN,
  };
  addChildBaseGeometry(
    childBaseIndices,
    childBase,
    child.node.radius,
    childPos,
    offset,
    smoothAmount,
    mesh,
  );

  // Band v-span from the MEASURED rim→base gap (mean, in tile units), so texel density inside the
  // band matches the world like everywhere else. A fixed parent.radius band is wrong for fat
  // children (roots): their big hole leaves only a thin physical band, and a tall v-span compresses
  // the texture into stripes there.
  let gap = 0;
  for (let i = 0; i < childRadialN; i++) {
    gap += mesh.vertices[childBaseIndices[(i + offset) % childRadialN]].distanceTo(
      mesh.vertices[childBase.vertexIndex + i],
    );
  }
  const bandHeight = Math.max(0.02, gap / childRadialN / UV_WORLD_PER_TILE);

  const baseRingUvIndex = addChildBaseUvs(
    uvAttach,
    uvAttach + bandHeight,
    childRadialN,
    child.node.uRepeat,
    childUPhase,
    mesh,
  );
  if (baseRingUvIndex !== childBase.uvIndex) {
    // addChildBaseGeometry already keyed its uvLoops on the predicted index — a desync here means
    // something new pushed uvs between the prediction and this call.
    throw new Error("welding-mesher: skirt uv index prediction desynced");
  }
  // uvGrowth of the parent segment: the hole spans [parentBaseV, parentBaseV + uvGrowth] and
  // uvAttach sits at its center.
  const parentBaseV = uvAttach - parent.length / UV_WORLD_PER_TILE / 2;
  applySkirtParentUvs(
    parent,
    parentPos,
    parentBaseV,
    parentBase,
    childRange,
    childBase,
    offset,
    mesh,
  );
  return { circle: childBase, childStartUvY: uvAttach + bandHeight };
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
      node.uPhase,
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
  const apexUvIndex = mesh.addUv(new Vector2(0.5 * node.uRepeat + node.uPhase, uvY + 1));

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
  const apexUvIndex = mesh.addUv(new Vector2(0.5 * stem.node.uRepeat + stem.node.uPhase, 0));

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
      node.children[0].node.uPhase = node.uPhase; // continuation: same tube, same chart
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
      node.children[0].node.uPhase = node.uPhase; // continuation: same tube, same chart
      const childPos = getPositionInNode(nodePosition, node);
      meshNodeRec(node.children[0].node, childPos, endCircle, mesh, uvY + uvGrowth, opts);
    } else {
      const child = node.children[i];
      const childPos = getSideChildPosition(node, child, nodePosition);
      // The hole spans this segment's full v range [uvY, uvY + uvGrowth]; anchor the child chart at
      // its centre so v is phase-continuous with the parent at the crotch. The skirt band rises by
      // its measured physical height from there, and the child tube's own v continues from the top
      // of the band at exact arc-length density.
      const uvAttach = uvY + uvGrowth / 2;
      const { circle: childBase, childStartUvY } = addChildCircle(
        node,
        child,
        childPos,
        nodePosition,
        base,
        childrenRanges[i - 1],
        uvAttach,
        mesh,
      );
      meshNodeRec(child.node, childPos, childBase, mesh, childStartUvY, opts);
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
