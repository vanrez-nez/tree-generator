import * as THREE from "three";
import type {
  GraphDocument,
  GraphLineDocument,
  GraphPointDocument,
  JointDocument,
  ModifierDocument,
} from "./graph/document";
import type { ModifierEnvelope } from "./graph/modifiers/modifier";
import { cubicBezierEasing, type CubicBezierCurve } from "./graph/curve";
import type { LineTubeOptions } from "./graph/line-tube";

// Domain layer: assembles a tree (trunk, branches, roots) as a plain line graph using the
// generic graph primitives + modifiers. The graph engine stays tree-agnostic; all tree
// knowledge lives here. This is the line graph only — no mesh, radii, or relaxation.
//
// Branches and roots are recursive: an L1 limb forks off the trunk, an L2 forks off each L1,
// an L3 off each L2 — every level connected by a (lean-constrained) joint.

export type TreeOptions = {
  height?: number;
  branchCount?: number;
  branchLevels?: number;
  trunkRadius?: number;
  radiusScale?: number;
  tipScale?: number;
  subdivisions?: number; // global mesh resolution: disc vertex count + density scale
  levelDensity?: number[]; // relative disc-density weights per level (scaled by subdivisions)
  branchLeanAngles?: number[];
  rootLeanAngles?: number[];
  // Roots (point-based, main roots only).
  rootHeight?: number; // trunk parameter (0..0.5) where roots attach
  rootLength?: number; // root polyline length
  rootDownAngle?: number; // initial tilt below horizontal (degrees), outer flare only
  rootDownCurve?: number; // extra downward bend accumulated over the length (degrees), outer flare
  maxRoots?: number; // cap on root count (actual = min(maxRoots, how many fit around the base))
  rootSeparation?: number; // inner descent radial offset, relative to trunk radius (0 = centerline)
  rootLSmooth?: number; // how rounded the base corner is (0 = sharp L, 1 = smooth)
};

type TreeParams = Required<TreeOptions>;

const DEFAULT_OPTIONS: TreeParams = {
  height: 4,
  branchCount: 3,
  branchLevels: 3,
  trunkRadius: 0.45, // master disc radius at the trunk (everything derives from this)
  radiusScale: 0.6, // disc radius multiplier per branching level
  tipScale: 0.12, // each line's radius tapers to this fraction toward its tip
  subdivisions: 16, // = SUBDIVISION_REF: reproduces the current density/segments
  levelDensity: [16, 16, 16, 16], // relative density per level at subdivisions = SUBDIVISION_REF
  // ^ L2 (index 2) is denser than L1: short L2 limbs lose several disks to the inside-parent cull,
  //   so the finer spacing keeps enough alive disks contiguous for the walk to stay connected.
  branchLeanAngles: [30, 60, 70], // joint lean clamp (°) by branch level L1..L3
  rootLeanAngles: [90, 90, 90], // roots stay unconstrained so they descend freely
  rootHeight: 0.1,
  rootLength: 1.6,
  rootDownAngle: 30,
  rootDownCurve: 45,
  maxRoots: 8,
  rootSeparation: 0.6,
  rootLSmooth: 0.5,
};

// Resolved defaults, exported so the UI can initialize its controls.
export const DEFAULT_TREE_OPTIONS: TreeParams = DEFAULT_OPTIONS;

const TUBE_OPACITY = 0.35;
const LINEAR_TAPER: CubicBezierCurve = [0.33, 0.33, 0.66, 0.66];
// Subdivisions value at which the per-level densities apply as-is (and discs are 16-gons).
const SUBDIVISION_REF = 16;
const MIN_SUBDIVISIONS = 3;
// A limb's start radius is capped to this fraction of the parent's radius at the branch point,
// so children are always visibly thinner than the disc they emerge from.
const BRANCH_RADIUS_RATIO = 0.75;

const TRUNK_ID = "trunk";
const TRUNK_COLOR = 0x8a6a4f; // brown
const BRANCH_COLOR = 0x6abf5a; // green
const ROOT_COLOR = 0xd98a3d; // amber

// Per-group recipe shared by every level of a limb system (branches or roots).
type LimbConfig = {
  color: number;
  levels: number; // deepest level to generate (1 = L1 only, 3 = up to L3)
  subCounts: number[]; // children per parent at depth 2, 3, … (indexed by depth - 2)
  verticalSign: number; // +1 limbs rise (branches), -1 limbs descend (roots)
  leanAngles: number[]; // joint lean clamp (°) per level, indexed by level - 1
  directionPoints?: number;
  baseLength: number; // L1 limb length
  lengthScale: number; // length multiplier per deeper level
  modifiers: () => ModifierDocument[]; // fresh objects per limb
};

const SUB_FAN = 0.9; // half-angle (rad) sub-limbs fan around their parent's heading

// One limb: a short line authored locally from its own origin (the joint translates that
// origin onto the parent) plus the joint that attaches + orients it.
function makeLimb(
  config: LimbConfig,
  id: string,
  parentId: string,
  azimuth: number,
  length: number,
  parentT: number,
  level: number,
): { line: GraphLineDocument; joint: JointDocument } {
  const leanAngle =
    config.leanAngles[Math.min(level - 1, config.leanAngles.length - 1)] ?? 90;

  return {
    line: {
      id,
      color: config.color,
      points: [
        [0, 0, 0],
        [
          Math.cos(azimuth) * length,
          config.verticalSign * length * 0.5,
          Math.sin(azimuth) * length,
        ],
      ],
      modifiers: config.modifiers(),
    },
    joint: {
      id: `joint-${id}`,
      parentLineId: parentId,
      parentT,
      childLineId: id,
      childPointIndex: 0,
      maxLeanAngle: leanAngle,
      directionPoints: config.directionPoints,
    },
  };
}

// Recursively fork sub-limbs off a parent limb, fanning around its heading and spreading the
// attach points along its length. Each deeper level is shorter (lengthScale).
function addSubLimbs(
  config: LimbConfig,
  parentId: string,
  parentAzimuth: number,
  parentLength: number,
  depth: number,
  lines: GraphLineDocument[],
  joints: JointDocument[],
): void {
  if (depth > config.levels) {
    return;
  }

  const count = config.subCounts[depth - 2] ?? 0;
  const length = parentLength * config.lengthScale;

  for (let index = 0; index < count; index += 1) {
    const fan = count > 1 ? ((index + 0.5) / count) * 2 - 1 : 0;
    const azimuth = parentAzimuth + fan * SUB_FAN;
    const parentT = count > 1 ? 0.4 + (index / (count - 1)) * 0.45 : 0.6;
    const id = `${parentId}-${index}`;

    const limb = makeLimb(config, id, parentId, azimuth, length, parentT, depth);
    lines.push(limb.line);
    joints.push(limb.joint);

    addSubLimbs(config, id, azimuth, length, depth + 1, lines, joints);
  }
}

// Fades a modifier's displacement in from the base (t = 0), so the ground point is left
// untouched — keeping the trunk anchored at the origin while it gnarls/twists higher up.
function footAnchorEnvelope(): ModifierEnvelope {
  return {
    fadeInEnabled: true,
    fadeIn: { min: 0, max: 0.08 },
    fadeOutEnabled: false,
    fadeOut: { min: 0.5, max: 1 },
    curve: [0.5, 0, 0.5, 1],
  };
}

// The trunk: a single leader from the ground to the tip, gnarled and twisted. Its base point
// stays anchored at the origin (smooth pins endpoints; gnarl/twist fade in from the foot).
function buildTrunk(params: TreeParams): GraphLineDocument {
  return {
    id: TRUNK_ID,
    color: TRUNK_COLOR,
    points: [
      [0, 0, 0],
      [params.height * 0.12, params.height, 0],
    ],
    modifiers: [
      { type: "smooth", params: { mode: "laplacian", segments: 24 } },
      {
        type: "gnarl",
        envelope: footAnchorEnvelope(),
        params: { amount: 1, amplitude: 0.18, cycles: 1.6 },
      },
      {
        type: "twist",
        envelope: footAnchorEnvelope(),
        params: { amount: 0.6, radius: 0.06, turns: 1 },
      },
      // Guarantee the base stands vertical (perpendicular to the floor) regardless of the
      // lean / gnarl / twist above.
      { type: "footAlign", params: { height: 0.15, amount: 1 } },
      // Final: keep the line mesh-ready (radius of curvature >= tube radius). `clearance`/`spacing`
      // are injected from the tube by assignTubes.
      { type: "discAlign", params: { safety: 1.1 } },
    ],
  };
}

function branchConfig(params: TreeParams): LimbConfig {
  return {
    color: BRANCH_COLOR,
    levels: params.branchLevels,
    subCounts: [2, 1], // L2, L3 children per parent
    verticalSign: 1,
    leanAngles: params.branchLeanAngles,
    directionPoints: 2,
    baseLength: params.height * 0.45,
    lengthScale: 0.6,
    modifiers: () => [
      { type: "smooth", params: { mode: "laplacian", segments: 12 } },
      { type: "gnarl", params: { amount: 0.8, amplitude: 0.16, cycles: 1.4 } },
      { type: "discAlign", params: { safety: 1.1 } },
    ],
  };
}

// The trunk tube radius at fraction t (trunk is level 0). Matches the taper assignTubes uses,
// so root packing/sizing stays consistent with how the trunk disc actually renders there.
function trunkRadiusAt(params: TreeParams, t: number): number {
  const eased = cubicBezierEasing(THREE.MathUtils.clamp(t, 0, 1), LINEAR_TAPER);
  return THREE.MathUtils.lerp(
    params.trunkRadius,
    params.trunkRadius * params.tipScale,
    eased,
  );
}

// The outer root flare as offsets from its start: heads outward (azimuth) tilted `downAngle`
// below horizontal, then curves further down to `downAngle + downCurve` across the length. Pure
// points — no modifiers. offsets[0] is (0,0,0); RootSystem anchors these at the base corner.
export function rootFlareOffsets(
  azimuth: number,
  length: number,
  downAngleDeg: number,
  downCurveDeg: number,
  steps: number,
): THREE.Vector3[] {
  const downAngle = THREE.MathUtils.degToRad(downAngleDeg);
  const downCurve = THREE.MathUtils.degToRad(downCurveDeg);
  const outX = Math.cos(azimuth);
  const outZ = Math.sin(azimuth);
  const stepLength = length / steps;

  const offsets = [new THREE.Vector3()];
  let x = 0;
  let y = 0;
  let z = 0;

  for (let s = 1; s <= steps; s += 1) {
    const tilt = downAngle + downCurve * ((s - 0.5) / steps);
    const horizontal = Math.cos(tilt) * stepLength;
    x += outX * horizontal;
    y -= Math.sin(tilt) * stepLength;
    z += outZ * horizontal;
    offsets.push(new THREE.Vector3(x, y, z));
  }

  return offsets;
}

function rootPoints(
  azimuth: number,
  length: number,
  downAngleDeg: number,
  downCurveDeg: number,
  steps: number,
): GraphPointDocument[] {
  return rootFlareOffsets(azimuth, length, downAngleDeg, downCurveDeg, steps).map(
    (v) => [v.x, v.y, v.z],
  );
}

// L1 branches fork off the trunk at spread heights and recurse into L2/L3.
function buildBranches(
  trunkId: string,
  params: TreeParams,
): { lines: GraphLineDocument[]; joints: JointDocument[] } {
  const config = branchConfig(params);
  const lines: GraphLineDocument[] = [];
  const joints: JointDocument[] = [];

  for (let index = 0; index < params.branchCount; index += 1) {
    const azimuth = (index / params.branchCount) * Math.PI * 2 + 0.7;
    const parentT = 0.35 + (index / Math.max(1, params.branchCount - 1)) * 0.55;
    const id = `branch-${index}`;

    const limb = makeLimb(config, id, trunkId, azimuth, config.baseLength, parentT, 1);
    lines.push(limb.line);
    joints.push(limb.joint);

    addSubLimbs(config, id, azimuth, config.baseLength, 2, lines, joints);
  }

  return { lines, joints };
}

const ROOT_STEPS = 9; // authored polyline samples per root (before smooth)

// Main roots attach low on the trunk and flare outward + down. Their shape is authored entirely
// in the points (down angle + down curve); only `smooth` rounds/densifies it. Count is how many
// fit around the trunk at the attach height, capped by `maxRoots`. The joint stays unconstrained
// (rootLeanAngles[0] = 90) so the authored down direction is preserved.
function buildRoots(
  trunkId: string,
  params: TreeParams,
): { lines: GraphLineDocument[]; joints: JointDocument[] } {
  const lines: GraphLineDocument[] = [];
  const joints: JointDocument[] = [];

  const rootHeight = THREE.MathUtils.clamp(params.rootHeight, 0, 0.5);
  const trunkR = trunkRadiusAt(params, rootHeight);
  const rootLevelRadius = params.trunkRadius * params.radiusScale;
  const rootBaseRadius = Math.min(rootLevelRadius, BRANCH_RADIUS_RATIO * trunkR);
  const discDiameter = Math.max(1e-4, rootBaseRadius * 2);

  const fitCount = Math.floor((2 * Math.PI * trunkR) / discDiameter);
  const count = Math.max(0, Math.min(Math.round(params.maxRoots), fitCount));

  for (let index = 0; index < count; index += 1) {
    const azimuth = (index / count) * Math.PI * 2;
    const id = `root-${index}`;

    lines.push({
      id,
      color: ROOT_COLOR,
      points: rootPoints(
        azimuth,
        params.rootLength,
        params.rootDownAngle,
        params.rootDownCurve,
        ROOT_STEPS,
      ),
      // Segments high enough to keep the runtime trunk-following detail; light strength so the
      // descent isn't flattened away from the trunk.
      modifiers: [
        { type: "smooth", params: { mode: "laplacian", segments: 32, strength: 0.3 } },
        { type: "discAlign", params: { safety: 1.1 } },
      ],
    });

    joints.push({
      id: `joint-${id}`,
      parentLineId: trunkId,
      parentT: rootHeight,
      childLineId: id,
      childPointIndex: 0,
      maxLeanAngle: params.rootLeanAngles[0],
      directionPoints: 1,
    });
  }

  return { lines, joints };
}

// Branching level encoded in the line id: trunk = 0, `branch-0` / `root-0` = 1,
// `branch-0-1` = 2, `branch-0-1-0` = 3, … (one segment per level).
function levelOf(id: string): number {
  if (id === TRUNK_ID) {
    return 0;
  }
  return id.split("-").length - 1;
}

// A distinct, evenly-spread hue per line (golden-angle), so each branch's disc tube reads as
// its own color.
function distinctColor(index: number): number {
  const hue = ((index * 137.508) % 360) / 360;
  return new THREE.Color().setHSL(hue, 0.65, 0.55).getHex();
}

// The parent tube's radius where a child attaches (parentT along the parent), following the
// parent's taper. Used to cap the child's start radius so a limb is never fatter than the
// parent disc it sprouts from.
function parentRadiusAtBranch(parent: LineTubeOptions, parentT: number): number {
  const tipScale = parent.tipScale ?? 0.12;
  const curve = parent.curve ?? LINEAR_TAPER;
  const eased = cubicBezierEasing(THREE.MathUtils.clamp(parentT, 0, 1), curve);
  return THREE.MathUtils.lerp(parent.radius, parent.radius * tipScale, eased);
}

// Give every line a disc tube: max radius from its branching level (trunk × scale^level), but
// capped at the parent's radius at the branch point so limbs never start fatter than the disc
// they emerge from. Lines are sized parent-first (ascending level) so the cap chains down
// levels. Each tube tapers to its tip with a distinct semitransparent color.
function assignTubes(
  lines: GraphLineDocument[],
  joints: JointDocument[],
  params: TreeParams,
): void {
  const byId = new Map(lines.map((line) => [line.id, line]));
  const jointByChild = new Map(joints.map((joint) => [joint.childLineId, joint]));
  const colorIndex = new Map(lines.map((line, index) => [line.id, index]));

  const ordered = [...lines].sort((a, b) => levelOf(a.id) - levelOf(b.id));

  for (const line of ordered) {
    const level = levelOf(line.id);
    const levelRadius = params.trunkRadius * Math.pow(params.radiusScale, level);
    let radius = levelRadius;

    const joint = jointByChild.get(line.id);
    const parent = joint ? byId.get(joint.parentLineId)?.tube : undefined;

    if (joint && parent) {
      const cap = parentRadiusAtBranch(parent, joint.parentT) * BRANCH_RADIUS_RATIO;
      radius = Math.min(levelRadius, cap);
    }

    // Global subdivisions drives both axes of mesh resolution: the per-level density (scaled) and
    // the disc vertex count.
    const subdivisions = Math.max(MIN_SUBDIVISIONS, Math.round(params.subdivisions));
    const levelWeight =
      params.levelDensity[Math.min(level, params.levelDensity.length - 1)] ?? 8;
    const density = levelWeight * (subdivisions / SUBDIVISION_REF);

    line.tube = {
      radius,
      density,
      segments: subdivisions,
      tipScale: params.tipScale,
      color: distinctColor(colorIndex.get(line.id) ?? 0),
      opacity: TUBE_OPACITY,
      curve: [...LINEAR_TAPER],
    };

    // Feed the disc-align modifier the tube it must keep clear of: discs space ~1/density apart,
    // and the curvature limit uses the (max) tube radius as the clearance.
    const discAlign = line.modifiers?.find((modifier) => modifier.type === "discAlign");
    if (discAlign) {
      discAlign.params = { ...discAlign.params, clearance: radius, spacing: 1 / density };
    }
  }
}

export function buildTreeDocument(options: TreeOptions = {}): GraphDocument {
  const params: TreeParams = { ...DEFAULT_OPTIONS, ...options };

  const trunk = buildTrunk(params);
  const branches = buildBranches(trunk.id, params);
  const roots = buildRoots(trunk.id, params);

  const lines = [trunk, ...branches.lines, ...roots.lines];
  const joints = [...branches.joints, ...roots.joints];
  assignTubes(lines, joints, params);

  return {
    lines,
    joints,
  };
}
