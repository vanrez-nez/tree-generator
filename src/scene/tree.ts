import * as THREE from "three";
import type {
  GraphDocument,
  GraphLineDocument,
  JointDocument,
  ModifierDocument,
} from "./graph/document";
import type { ModifierEnvelope } from "./graph/modifiers/modifier";
import type { CubicBezierCurve } from "./graph/curve";

// Domain layer: assembles a tree (trunk, branches, roots) as a plain line graph using the
// generic graph primitives + modifiers. The graph engine stays tree-agnostic; all tree
// knowledge lives here. This is the line graph only — no mesh, radii, or relaxation.
//
// Branches and roots are recursive: an L1 limb forks off the trunk, an L2 forks off each L1,
// an L3 off each L2 — every level connected by a (lean-constrained) joint.

export type TreeOptions = {
  height?: number;
  branchCount?: number;
  rootCount?: number;
  branchLevels?: number;
  rootLevels?: number;
  trunkRadius?: number;
  radiusScale?: number;
  tipScale?: number;
  levelDensity?: number[];
  branchLeanAngles?: number[];
  rootLeanAngles?: number[];
};

type TreeParams = Required<TreeOptions>;

const DEFAULT_OPTIONS: TreeParams = {
  height: 4,
  branchCount: 3,
  rootCount: 3,
  branchLevels: 3,
  rootLevels: 3,
  trunkRadius: 0.45, // master disc radius at the trunk (everything derives from this)
  radiusScale: 0.6, // disc radius multiplier per branching level
  tipScale: 0.12, // each line's radius tapers to this fraction toward its tip
  levelDensity: [16, 10, 7, 5], // discs per unit length by level (index 0 = trunk, gets the most)
  branchLeanAngles: [30, 60, 70], // joint lean clamp (°) by branch level L1..L3
  rootLeanAngles: [90, 90, 90], // roots stay unconstrained so they descend freely
};

const TUBE_OPACITY = 0.35;
const LINEAR_TAPER: CubicBezierCurve = [0.33, 0.33, 0.66, 0.66];

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
    ],
  };
}

function rootConfig(params: TreeParams): LimbConfig {
  return {
    color: ROOT_COLOR,
    levels: params.rootLevels,
    subCounts: [1, 1], // L2, L3 children per parent
    verticalSign: -1,
    leanAngles: params.rootLeanAngles, // unconstrained by default: roots descend freely
    baseLength: params.height * 0.4,
    lengthScale: 0.6,
    modifiers: () => [
      { type: "coil", params: { amount: 1, turns: 1.2, bias: 1.5 } },
      { type: "gnarl", params: { amount: 0.6, amplitude: 0.14, cycles: 1.8 } },
    ],
  };
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

// L1 roots fork off the trunk base (low parentT) and recurse into L2/L3. Their wrapping shape
// comes from the coil modifier; the joint is unconstrained so they can descend.
function buildRoots(
  trunkId: string,
  params: TreeParams,
): { lines: GraphLineDocument[]; joints: JointDocument[] } {
  const config = rootConfig(params);
  const lines: GraphLineDocument[] = [];
  const joints: JointDocument[] = [];

  for (let index = 0; index < params.rootCount; index += 1) {
    const azimuth = (index / params.rootCount) * Math.PI * 2;
    const id = `root-${index}`;

    const limb = makeLimb(config, id, trunkId, azimuth, config.baseLength, 0.03, 1);
    lines.push(limb.line);
    joints.push(limb.joint);

    addSubLimbs(config, id, azimuth, config.baseLength, 2, lines, joints);
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

// Give every line a disc tube: max radius set by its branching level (trunk × scale^level),
// tapering to its tip, with a distinct semitransparent color.
function assignTubes(lines: GraphLineDocument[], params: TreeParams): void {
  lines.forEach((line, index) => {
    const level = levelOf(line.id);
    const radius = params.trunkRadius * Math.pow(params.radiusScale, level);
    const density =
      params.levelDensity[Math.min(level, params.levelDensity.length - 1)] ?? 8;
    line.tube = {
      radius,
      density,
      tipScale: params.tipScale,
      color: distinctColor(index),
      opacity: TUBE_OPACITY,
      curve: [...LINEAR_TAPER],
    };
  });
}

export function buildTreeDocument(options: TreeOptions = {}): GraphDocument {
  const params: TreeParams = { ...DEFAULT_OPTIONS, ...options };

  const trunk = buildTrunk(params);
  const branches = buildBranches(trunk.id, params);
  const roots = buildRoots(trunk.id, params);

  const lines = [trunk, ...branches.lines, ...roots.lines];
  assignTubes(lines, params);

  return {
    lines,
    joints: [...branches.joints, ...roots.joints],
  };
}
