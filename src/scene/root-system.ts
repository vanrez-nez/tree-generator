import * as THREE from "three";
import type { GraphLine } from "./graph/line";
import { rootFlareOffsets } from "./tree";

// Root shaping (tree domain). Each main root is a parent-riding limb whose world shape is two parts:
//   1. an inner descent that rides the TRUNK's live drawn line from the root height down to the
//      base, offset radially by `rootSeparation` (relative to the trunk radius) — the bulge;
//   2. the unchanged outer flare anchored at the base corner.
// This shape can't be baked statically (the trunk's gnarl/twist deform differently at each height),
// so it's supplied as a `restWorldOverride` on each root's attachment: the world assembler pulls it
// each frame and re-bases its base onto the trunk connection point — so a root can never detach.

export type RootSystemParams = {
  rootHeight: number;
  rootLength: number;
  rootDownAngle: number;
  rootDownCurve: number;
  rootSeparation: number;
  rootLSmooth: number;
};

const INNER_STEPS = 12; // samples down the trunk for the inner descent
const FLARE_STEPS = 9; // samples for the outer flare
const NECK_FRACTION = 0.3; // descent fraction over which separation ramps in from the connection

type RootEntry = { line: GraphLine; azimuth: number };

export class RootSystem {
  private readonly roots: RootEntry[];

  constructor(
    private readonly trunk: GraphLine | undefined,
    rootLines: GraphLine[],
    private readonly params: RootSystemParams,
  ) {
    const count = rootLines.length;
    this.roots = rootLines.map((line, index) => ({
      line,
      azimuth: count > 0 ? (index / count) * Math.PI * 2 : 0,
    }));

    // Wire each main root's attachment to ride the trunk. The anchor is the trunk point at the root
    // height; the override supplies the descent+flare shape (which starts at that same point). The
    // assembler re-bases the base onto the anchor, guaranteeing the connection.
    for (const entry of this.roots) {
      entry.line.attachment = {
        pivot: 0,
        anchor: () => this.anchor(),
        orient: () => new THREE.Quaternion(),
        restWorldOverride: () => this.computeRoot(entry),
      };
    }
  }

  // The trunk point where the roots connect (arc-fraction `rootHeight` down the trunk).
  private anchor(): THREE.Vector3 {
    const sampled = this.sampleTrunk();
    return sampled
      ? sampleByArc(sampled.points, sampled.cumulative, sampled.total, this.rootHeightFraction())
      : new THREE.Vector3();
  }

  private computeRoot(entry: RootEntry): THREE.Vector3[] {
    const sampled = this.sampleTrunk();
    if (!sampled) {
      return entry.line.points.map((point) => point.clone());
    }

    const { points: trunkPoints, cumulative, total } = sampled;
    const trunkTube = this.trunk?.tube;
    const radiusAt = (t: number): number => (trunkTube ? trunkTube.radiusAt(t) : 0);
    const p = this.params;
    const rootHeight = this.rootHeightFraction();
    const azimuth = entry.azimuth;
    const azDir = new THREE.Vector3(Math.cos(azimuth), 0, Math.sin(azimuth));

    // Inner descent: ride the trunk from the root height down to the base, offset radially.
    // Separation necks in from 0 at the connecting point (step 0), so the root stays attached
    // to the trunk there while the rest of the descent pulls out to form the bulge.
    const inner: THREE.Vector3[] = [];
    for (let step = 0; step <= INNER_STEPS; step += 1) {
      const u = step / INNER_STEPS; // 0 at the trunk connection, 1 at the base
      const t = rootHeight * (1 - u);
      const center = sampleByArc(trunkPoints, cumulative, total, t);
      const neck = smoothstep(Math.min(1, u / NECK_FRACTION));
      inner.push(center.addScaledVector(azDir, p.rootSeparation * radiusAt(t) * neck));
    }

    // Outer flare anchored at the base corner (unchanged shape).
    const corner = inner[inner.length - 1];
    const flare = rootFlareOffsets(
      azimuth,
      p.rootLength,
      p.rootDownAngle,
      p.rootDownCurve,
      FLARE_STEPS,
    );
    const outer = flare.slice(1).map((offset) => corner.clone().add(offset));

    return roundCorner([...inner, ...outer], inner.length - 1, p.rootLSmooth);
  }

  private rootHeightFraction(): number {
    return THREE.MathUtils.clamp(this.params.rootHeight, 0, 1);
  }

  private sampleTrunk():
    | { points: THREE.Vector3[]; cumulative: number[]; total: number }
    | undefined {
    if (!this.trunk) {
      return undefined;
    }
    const points = this.trunk.virtual.getDrawPoints();
    if (points.length < 2) {
      return undefined;
    }
    const cumulative = cumulativeLengths(points);
    const total = cumulative[cumulative.length - 1];
    return total <= 1e-6 ? undefined : { points, cumulative, total };
  }
}

function smoothstep(x: number): number {
  const c = THREE.MathUtils.clamp(x, 0, 1);
  return c * c * (3 - 2 * c);
}

function cumulativeLengths(points: THREE.Vector3[]): number[] {
  const distances = [0];
  for (let index = 1; index < points.length; index += 1) {
    distances[index] = distances[index - 1] + points[index - 1].distanceTo(points[index]);
  }
  return distances;
}

function sampleByArc(
  points: THREE.Vector3[],
  cumulative: number[],
  total: number,
  t: number,
): THREE.Vector3 {
  const distance = THREE.MathUtils.clamp(t, 0, 1) * total;
  const last = points.length - 1;
  let index = 0;

  while (index < last - 1 && cumulative[index + 1] < distance) {
    index += 1;
  }

  const segmentLength = Math.max(1e-9, cumulative[index + 1] - cumulative[index]);
  const local = THREE.MathUtils.clamp((distance - cumulative[index]) / segmentLength, 0, 1);
  return points[index].clone().lerp(points[index + 1], local);
}

// Round the corner at `cornerIndex` by replacing a window (∝ lSmooth) around it with a quadratic
// Bézier through the corner. lSmooth = 0 leaves the sharp L.
function roundCorner(
  points: THREE.Vector3[],
  cornerIndex: number,
  lSmooth: number,
): THREE.Vector3[] {
  const smooth = THREE.MathUtils.clamp(lSmooth, 0, 1);

  if (smooth <= 0) {
    return points;
  }

  const maxWindow = Math.min(cornerIndex, points.length - 1 - cornerIndex, 5);

  if (maxWindow < 1) {
    return points;
  }

  const window = Math.max(1, Math.round(smooth * maxWindow));
  const a = points[cornerIndex - window];
  const c = points[cornerIndex];
  const b = points[cornerIndex + window];
  const out = points.map((point) => point.clone());
  const span = window * 2;

  for (let k = 0; k <= span; k += 1) {
    const u = k / span;
    const mt = 1 - u;
    out[cornerIndex - window + k] = a
      .clone()
      .multiplyScalar(mt * mt)
      .addScaledVector(c, 2 * mt * u)
      .addScaledVector(b, u * u);
  }

  return out;
}
