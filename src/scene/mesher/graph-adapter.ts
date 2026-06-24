import * as THREE from "three";
import type { Graph } from "../graph/graph";
import type { GraphLine } from "../graph/line";
import { createNode, getOrthogonalVector, type Stem, type TreeNode } from "./tree-node";

// Adapts the app's runtime Graph (independent lines connected by joints) into the welding mesher's
// `Stem` hierarchy. Each line's deformed centerline becomes a chain of single-segment TreeNodes
// (children[0] = the continuation); every joint grafts a child line's chain onto the parent node it
// attaches to as a side child (children[1..]). The result is one connected hierarchy rooted at the
// trunk, which the welding mesher fuses into a single watertight surface.
//
// Must run after `graph.update()` so each line carries its final, settled draw points. Works in the
// graph's world space directly (the graph group and the mesher group share the scene root with no
// transform), so the produced positions/directions need no remapping.

const MIN_SAMPLES = 2;
const MAX_SAMPLES = 256;
const CHILD_RADIUS_FACTOR = 0.95; // keep a branch base just under its parent ring so the weld is sane

type LineChain = {
  /** the line's segments, head first; node[i].children[0] === node[i + 1] */
  nodes: TreeNode[];
};

export function buildStemFromGraph(graph: Graph): Stem | undefined {
  const chains = new Map<GraphLine, LineChain>();

  for (const { line } of graph.getLineEntries()) {
    const chain = buildLineChain(line);
    if (chain) chains.set(line, chain);
  }

  // Graft each child line onto its parent node as a side branch.
  for (const { joint } of graph.getJointEntries()) {
    if (joint.parentLine === joint.childLine) continue;

    const parentChain = chains.get(joint.parentLine);
    const childChain = chains.get(joint.childLine);
    if (!parentChain || !childChain) continue;

    const segmentCount = parentChain.nodes.length;
    const index = THREE.MathUtils.clamp(
      Math.floor(THREE.MathUtils.clamp(joint.parentT, 0, 1) * segmentCount),
      0,
      segmentCount - 1,
    );
    const parentNode = parentChain.nodes[index];
    const positionInParent = THREE.MathUtils.clamp(
      joint.parentT * segmentCount - index,
      0,
      1,
    );

    const childHead = childChain.nodes[0];
    // Keep the branch base under the parent ring radius so the hole-punch stays well-formed.
    childHead.radius = Math.min(childHead.radius, parentNode.radius * CHILD_RADIUS_FACTOR);
    parentNode.children.push({ node: childHead, positionInParent });
  }

  const trunk = graph.getLineById("trunk") ?? graph.getLineEntries()[0]?.line;
  if (!trunk) return undefined;

  const trunkChain = chains.get(trunk);
  if (!trunkChain || trunkChain.nodes.length === 0) return undefined;

  const trunkPoints = trunk.virtual.getDrawPoints();
  return {
    node: trunkChain.nodes[0],
    position: trunkPoints[0].clone(),
  };
}

// Sample a line's deformed centerline by arc length into a chain of single-segment nodes. Sample
// density matches the line's tube (discs per unit length) so the meshed surface follows the same
// resolution the editing overlay shows.
function buildLineChain(line: GraphLine): LineChain | undefined {
  const tube = line.tube;
  if (!tube) return undefined;

  const points = line.virtual.getDrawPoints();
  if (points.length < 2) return undefined;

  const cumulative = cumulativeLengths(points);
  const total = cumulative[cumulative.length - 1];
  if (total <= 1e-9) return undefined;

  const sampleCount = THREE.MathUtils.clamp(
    Math.round(tube.density * total),
    MIN_SAMPLES,
    MAX_SAMPLES,
  );

  const samples: THREE.Vector3[] = [];
  for (let i = 0; i < sampleCount; i += 1) {
    const t = i / (sampleCount - 1);
    samples.push(sampleByArc(points, cumulative, total, t * total));
  }

  const nodes: TreeNode[] = [];
  let parentTangent: THREE.Vector3 | undefined;

  for (let i = 0; i < samples.length - 1; i += 1) {
    const delta = samples[i + 1].clone().sub(samples[i]);
    const length = delta.length();
    if (length <= 1e-9) continue; // skip coincident samples (degenerate direction)

    const direction = delta.divideScalar(length);
    const baseT = i / (samples.length - 1);
    const radius = tube.radiusAt(baseT);

    const seed = parentTangent ?? getOrthogonalVector(direction);
    const node = createNode(direction, seed, length, radius);
    parentTangent = node.tangent;

    const previous = nodes[nodes.length - 1];
    if (previous) previous.children.push({ node, positionInParent: 1 });
    nodes.push(node);
  }

  if (nodes.length === 0) return undefined;
  return { nodes };
}

function cumulativeLengths(points: THREE.Vector3[]): number[] {
  const distances = [0];
  for (let i = 1; i < points.length; i += 1) {
    distances.push(distances[i - 1] + points[i].distanceTo(points[i - 1]));
  }
  return distances;
}

function sampleByArc(
  points: THREE.Vector3[],
  cumulative: number[],
  total: number,
  distance: number,
): THREE.Vector3 {
  const target = THREE.MathUtils.clamp(distance, 0, total);

  for (let i = 1; i < cumulative.length; i += 1) {
    if (cumulative[i] >= target) {
      const span = cumulative[i] - cumulative[i - 1];
      const local = span <= 1e-9 ? 0 : (target - cumulative[i - 1]) / span;
      return points[i - 1].clone().lerp(points[i], local);
    }
  }

  return points[points.length - 1].clone();
}
