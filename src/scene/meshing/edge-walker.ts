import * as THREE from "three";
import type { Graph } from "../graph/graph";
import type { GraphLine } from "../graph/line";
import { rotationMinimizingFrames } from "../graph/modifiers/utils";
import { signedDistance, surfaceCrossing, type ParentSurface } from "../graph/collar";

// STEP 1+2+3 — the edge walker, an inside-parent cull, then a weld of the open boundaries.
//
// WALK (step 1). Connectivity stage of surface-reconstruction-from-contours (Fuchs/Kedem/Uselton):
// we read the disks (cross-section rings) our tubes already define and connect their vertices into
// an edge graph following the line paths bottom→top. Two edge sets:
//   - RING edges : around each disk (k → k+1)
//   - WALK edges : longitudinal, disk d vertex i → disk d+1 vertex i, RMF-index-aligned (no twist)
//
// CULL (step 2). A separate cleanup pass — not part of the walk. A child line carries
// `tube.parentClip`, a signed distance field to its DIRECT parent tube (collar.ts). Walking up the
// joint parent chain and collecting each line's `parentClip` yields the surfaces of EVERY ancestor
// (direct parent, grandparent, … up to the trunk). Parents take precedence over their children, so
// a vertex is discarded if it lies inside ANY ancestor's geometry (signedDistance < 0) — an L2
// vertex buried in the trunk is culled even though it sits outside its direct L1 parent. This is
// per-vertex (a straddling disk keeps its outside rim and loses its inside rim). Edges that
// reference a discarded vertex are dropped; the rim simply opens where it crosses into an ancestor.
//
// WELD (step 3). The cull leaves open boundaries: alive vertices whose longitudinal (walk) neighbour
// toward the junction was culled away. Each is closed by, in order:
//   1. PROJECT — march a segment from the vertex along the line's direction (toward the culled
//      interior) until it crosses the direct-parent surface (SDF); weld at that crossing.
//   2. SNAP BY DISTANCE — otherwise connect to the nearest alive vertex on the surface it entered
//      (an ancestor line), if one is within reach (a few local disk spacings).
//   3. LEAVE AS IS — if neither finds a target, no weld.
// SDF used the right way again: a local per-vertex crossing along the walk direction, not a global
// polygonization. Faces over these welded boundaries are a later step.

const MAX_DISKS = 256;
const INSIDE_EPSILON = 1e-4; // keep boundary vertices (sd ≈ 0); discard only those clearly inside
const SNAP_FACTOR = 2.0; // snap reach, in units of the open vertex's local (longitudinal) disk spacing
const PROJECT_OVERSHOOT = 1.25; // march this far past the culled neighbour to land safely inside

type Disk = {
  center: THREE.Vector3;
  normal: THREE.Vector3;
  binormal: THREE.Vector3;
  radius: number;
};

export class EdgeWalker {
  readonly object = new THREE.Group();

  private readonly ringMaterial = new THREE.LineBasicMaterial({
    color: 0x335a66,
    transparent: true,
    opacity: 0.55,
  });
  private readonly walkMaterial = new THREE.LineBasicMaterial({ color: 0x5fd0ff });
  private readonly weldMaterial = new THREE.LineBasicMaterial({ color: 0xffaa33 });
  private readonly ringSegments = new THREE.LineSegments(
    new THREE.BufferGeometry(),
    this.ringMaterial,
  );
  private readonly walkSegments = new THREE.LineSegments(
    new THREE.BufferGeometry(),
    this.walkMaterial,
  );
  private readonly weldSegments = new THREE.LineSegments(
    new THREE.BufferGeometry(),
    this.weldMaterial,
  );

  constructor() {
    this.ringSegments.frustumCulled = false;
    this.walkSegments.frustumCulled = false;
    this.weldSegments.frustumCulled = false;
    this.object.add(this.ringSegments);
    this.object.add(this.walkSegments);
    this.object.add(this.weldSegments);
  }

  setVisible(visible: boolean): void {
    this.object.visible = visible;
  }

  build(graph: Graph): void {
    const positions: number[] = [];
    const ringIndices: number[] = [];
    const walkIndices: number[] = [];
    // Per-vertex ancestor surfaces (direct parent → … → trunk; empty for the trunk itself),
    // recorded during the walk so the cull pass can test each vertex against its whole chain.
    const vertexAncestors: ParentSurface[][] = [];
    const vertexLine: number[] = []; // per-vertex line index (into the entries order below)
    const parentOf = buildParentMap(graph);

    const entries = graph.getLineEntries();
    const lineIndex = new Map<GraphLine, number>(entries.map(({ line }, i) => [line, i]));
    const lineAncestorSurfaces: ParentSurface[][] = []; // each line's ancestor surfaces (project targets)
    const lineAncestorLines: Set<number>[] = []; // each line's ancestor line indices (snap targets)

    for (const { line } of entries) {
      lineAncestorSurfaces.push(ancestorSurfaces(line, parentOf));
      lineAncestorLines.push(ancestorLineIndices(line, parentOf, lineIndex));
    }

    for (let li = 0; li < entries.length; li += 1) {
      const line = entries[li].line;
      const tube = line.tube;
      if (!tube) continue;

      const disks = lineDisks(line);
      if (disks.length < 1) continue;
      const n = Math.max(3, Math.floor(tube.segments));
      const ancestors = ancestorSurfaces(line, parentOf);

      const diskStarts: number[] = [];
      for (const disk of disks) {
        const start = positions.length / 3;
        diskStarts.push(start);
        for (let k = 0; k < n; k += 1) {
          const angle = (k / n) * Math.PI * 2;
          const cos = Math.cos(angle);
          const sin = Math.sin(angle);
          positions.push(
            disk.center.x + (disk.normal.x * cos + disk.binormal.x * sin) * disk.radius,
            disk.center.y + (disk.normal.y * cos + disk.binormal.y * sin) * disk.radius,
            disk.center.z + (disk.normal.z * cos + disk.binormal.z * sin) * disk.radius,
          );
          vertexAncestors.push(ancestors);
          vertexLine.push(li);
          ringIndices.push(start + k, start + ((k + 1) % n));
        }
      }

      // Walk bottom→top: connect matching vertices of consecutive disks (RMF-aligned).
      for (let d = 0; d < diskStarts.length - 1; d += 1) {
        const a = diskStarts[d];
        const b = diskStarts[d + 1];
        for (let k = 0; k < n; k += 1) {
          walkIndices.push(a + k, b + k);
        }
      }
    }

    // CLEANUP PASS — discard every vertex inside any ancestor's geometry, then drop any edge that
    // touched a discarded vertex. Independent of the walk above.
    const alive = cullInsideParents(positions, vertexAncestors);
    const ring = keepEdges(ringIndices, alive);
    const walk = keepEdges(walkIndices, alive);

    // WELD PASS — close open boundaries (both longitudinal walk cuts and sideways ring cuts, the
    // latter being how a straddling disk — e.g. a buttress root riding the trunk — opens) by
    // projecting onto the ancestor surface, else snapping, else leaving as is.
    const weld = weldOpenBoundaries(positions, walkIndices, ringIndices, alive, {
      vertexLine,
      lineAncestorSurfaces,
      lineAncestorLines,
    });

    setEdges(this.ringSegments, new Float32Array(positions), ring);
    setEdges(this.walkSegments, new Float32Array(positions), walk);
    setEdges(this.weldSegments, new Float32Array(weld.positions), weld.edges);
  }
}

// Maps each child line to its parent line via the joints, so the cull can walk the ancestor chain.
function buildParentMap(graph: Graph): Map<GraphLine, GraphLine> {
  const parentOf = new Map<GraphLine, GraphLine>();
  for (const { joint } of graph.getJointEntries()) {
    if (joint.parentLine !== joint.childLine) {
      parentOf.set(joint.childLine, joint.parentLine);
    }
  }
  return parentOf;
}

// Surfaces of every ancestor of `line`: its direct parent's clip, then the grandparent's, … up to
// the trunk. Each line's `tube.parentClip` is the surface of its DIRECT parent, so collecting one
// per step up the chain gives the whole lineage.
function ancestorSurfaces(
  line: GraphLine,
  parentOf: Map<GraphLine, GraphLine>,
): ParentSurface[] {
  const surfaces: ParentSurface[] = [];
  let current: GraphLine | undefined = line;
  while (current?.tube?.parentClip) {
    surfaces.push(current.tube.parentClip);
    current = parentOf.get(current);
  }
  return surfaces;
}

// The line indices of every ancestor of `line` (direct parent → … → trunk), used as snap targets.
function ancestorLineIndices(
  line: GraphLine,
  parentOf: Map<GraphLine, GraphLine>,
  lineIndex: Map<GraphLine, number>,
): Set<number> {
  const indices = new Set<number>();
  let current = parentOf.get(line);
  while (current) {
    const idx = lineIndex.get(current);
    if (idx !== undefined) indices.add(idx);
    current = parentOf.get(current);
  }
  return indices;
}

type WeldContext = {
  vertexLine: number[];
  lineAncestorSurfaces: ParentSurface[][];
  lineAncestorLines: Set<number>[];
};

// Closes the open boundaries the cull left behind. An "open" vertex is an alive vertex with a culled
// neighbour — longitudinal (walk) OR sideways (ring): a straddling disk that crosses the parent
// surface opens in the ring direction, which is how a buttress root riding the trunk opens all the
// way down. Its inward direction is the sum of the steps toward every culled neighbour. Each open
// vertex is resolved by project → snap → leave.
function weldOpenBoundaries(
  positions: number[],
  walkIndices: number[],
  ringIndices: number[],
  alive: boolean[],
  ctx: WeldContext,
): { positions: number[]; edges: number[] } {
  const count = positions.length / 3;
  // Accumulate, per open vertex, the inward direction and a representative local disk spacing.
  const inward = new Map<number, { dir: THREE.Vector3; span: number; n: number }>();
  const note = (a: number, b: number) => {
    const dir = new THREE.Vector3(
      positions[b * 3] - positions[a * 3],
      positions[b * 3 + 1] - positions[a * 3 + 1],
      positions[b * 3 + 2] - positions[a * 3 + 2],
    );
    const span = dir.length();
    const entry = inward.get(a);
    if (entry) {
      entry.dir.add(dir);
      entry.span += span;
      entry.n += 1;
    } else {
      inward.set(a, { dir, span, n: 1 });
    }
  };
  const noteCuts = (indices: number[]) => {
    for (let i = 0; i < indices.length; i += 2) {
      const a = indices[i];
      const b = indices[i + 1];
      if (alive[a] && !alive[b]) note(a, b);
      else if (alive[b] && !alive[a]) note(b, a);
    }
  };
  noteCuts(walkIndices); // longitudinal openings
  noteCuts(ringIndices); // sideways openings (straddling disks, e.g. buttress roots)

  // Candidate snap targets, grouped per line so an open vertex only searches its ancestor lines.
  const aliveByLine = new Map<number, number[]>();
  for (let v = 0; v < count; v += 1) {
    if (!alive[v]) continue;
    const li = ctx.vertexLine[v];
    const list = aliveByLine.get(li);
    if (list) list.push(v);
    else aliveByLine.set(li, [v]);
  }

  const weldPositions = positions.slice();
  const edges: number[] = [];
  const a = new THREE.Vector3();
  const probe = new THREE.Vector3();
  let snapped = 0;
  let projected = 0;
  let left = 0;

  for (const [vertex, { dir, span, n }] of inward) {
    const spacing = n > 0 ? span / n : 0;
    a.set(positions[vertex * 3], positions[vertex * 3 + 1], positions[vertex * 3 + 2]);
    const li = ctx.vertexLine[vertex];

    // 1) Project along the line direction until it crosses an ancestor surface. The culled walk-
    //    neighbour (averaged, in `dir`) is itself inside the ancestor that culled it, so marching a
    //    hair past it guarantees the segment a→probe crosses that surface — no overshoot through a
    //    near-tangent chord, which a fixed-distance probe suffered from. A branch may be cut by a
    //    deeper ancestor (e.g. an L2 buried in the trunk), so test every ancestor and take the
    //    nearest crossing — the surface actually in front of the open boundary.
    const surfaces = ctx.lineAncestorSurfaces[li];
    if (surfaces.length > 0 && n > 0 && dir.lengthSq() > 1e-12) {
      probe.copy(a).addScaledVector(dir, PROJECT_OVERSHOOT / n);
      let hit: THREE.Vector3 | null = null;
      let hitSq = Infinity;
      for (const surface of surfaces) {
        if (signedDistance(surface, probe) < 0) {
          const cross = surfaceCrossing(a, probe, surface);
          const sq = cross.distanceToSquared(a);
          if (sq < hitSq) {
            hitSq = sq;
            hit = cross;
          }
        }
      }
      if (hit) {
        const w = weldPositions.length / 3;
        weldPositions.push(hit.x, hit.y, hit.z);
        edges.push(vertex, w);
        projected += 1;
        continue;
      }
    }

    // 2) Snap by distance: nearest alive vertex on an ancestor line, within SNAP_FACTOR spacings.
    const ancestors = ctx.lineAncestorLines[li];
    const snapMax = SNAP_FACTOR * spacing;
    let best = -1;
    let bestSq = snapMax * snapMax;
    for (const ancestorLine of ancestors) {
      const list = aliveByLine.get(ancestorLine);
      if (!list) continue;
      for (const c of list) {
        const dx = positions[c * 3] - a.x;
        const dy = positions[c * 3 + 1] - a.y;
        const dz = positions[c * 3 + 2] - a.z;
        const sq = dx * dx + dy * dy + dz * dz;
        if (sq < bestSq) {
          bestSq = sq;
          best = c;
        }
      }
    }
    if (best >= 0) {
      edges.push(vertex, best);
      snapped += 1;
      continue;
    }

    // 3) Found nothing — leave the boundary as is.
    left += 1;
  }

  // eslint-disable-next-line no-console
  console.log(`[edge-walker] weld: open=${inward.size} projected=${projected} snapped=${snapped} left=${left}`);

  return { positions: weldPositions, edges };
}

// Marks each vertex alive unless it lies inside any ancestor's tube (signedDistance < 0).
// Vertices on the trunk (no ancestors) are always alive.
function cullInsideParents(positions: number[], vertexAncestors: ParentSurface[][]): boolean[] {
  const alive: boolean[] = new Array(vertexAncestors.length);
  const p = new THREE.Vector3();
  for (let i = 0; i < vertexAncestors.length; i += 1) {
    const ancestors = vertexAncestors[i];
    p.set(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
    let kept = true;
    for (const surface of ancestors) {
      if (signedDistance(surface, p) < -INSIDE_EPSILON) {
        kept = false;
        break;
      }
    }
    alive[i] = kept;
  }
  return alive;
}

// Keeps only the edges whose both endpoints survived the cull.
function keepEdges(indices: number[], alive: boolean[]): number[] {
  const kept: number[] = [];
  for (let i = 0; i < indices.length; i += 2) {
    const a = indices[i];
    const b = indices[i + 1];
    if (alive[a] && alive[b]) kept.push(a, b);
  }
  return kept;
}

function setEdges(
  segments: THREE.LineSegments,
  positions: Float32Array,
  indices: number[],
): void {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  segments.geometry.dispose();
  segments.geometry = geometry;
}

// Replicates LineTube's disk sampling (density along the drawn spine + taper + one RMF) so the
// edge walker uses the very same disks the tube renders.
function lineDisks(line: GraphLine): Disk[] {
  const tube = line.tube;
  const points = line.virtual.getDrawPoints();
  if (!tube || points.length < 2) return [];

  const cumulative = [0];
  for (let i = 1; i < points.length; i += 1) {
    cumulative[i] = cumulative[i - 1] + points[i - 1].distanceTo(points[i]);
  }
  const total = cumulative[cumulative.length - 1];
  if (total <= 1e-6) return [];

  const count = THREE.MathUtils.clamp(Math.round(tube.density * total), 2, MAX_DISKS);
  const centers: THREE.Vector3[] = [];
  const tangents: THREE.Vector3[] = [];
  const radii: number[] = [];
  for (let i = 0; i < count; i += 1) {
    const t = i / (count - 1);
    const sample = sampleAt(points, cumulative, total * t);
    centers.push(sample.position);
    tangents.push(sample.tangent);
    radii.push(tube.radiusAt(t));
  }

  const frames = rotationMinimizingFrames(centers, tangents);
  return centers.map((center, i) => ({
    center,
    normal: frames[i].normal,
    binormal: frames[i].binormal,
    radius: radii[i],
  }));
}

function sampleAt(
  points: THREE.Vector3[],
  cumulative: number[],
  distance: number,
): { position: THREE.Vector3; tangent: THREE.Vector3 } {
  const last = points.length - 1;
  let i = 0;
  while (i < last - 1 && cumulative[i + 1] < distance) i += 1;
  const segLen = Math.max(1e-9, cumulative[i + 1] - cumulative[i]);
  const local = THREE.MathUtils.clamp((distance - cumulative[i]) / segLen, 0, 1);
  const position = points[i].clone().lerp(points[i + 1], local);
  const tangent = points[i + 1].clone().sub(points[i]);
  return {
    position,
    tangent: tangent.lengthSq() <= 1e-12 ? new THREE.Vector3(0, 1, 0) : tangent.normalize(),
  };
}
