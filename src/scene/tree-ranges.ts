// Single source of truth for tree generation. The ONE file to edit when retuning.
//
//   RANGES — every form field (the values a tree CODE encodes and the UI exposes). Each field has:
//     • min / max / step — the FULL domain a value can take. This doubles as the codec grid: a tree
//       code stores each value as an index on this grid (see tree-code.ts). Changing min/max/step
//       therefore changes what existing codes decode to — keep these stable once codes are shared.
//     • default — the value the DEFAULT tree uses. DEFAULT_FORM is DERIVED from these (tree-code.ts),
//       so a field's default lives on the SAME line as its range — change it here, nowhere else.
//       Must sit on the min/max/step grid.
//     • randMin / randMax — the window the "Random" button (randomForm) draws from. Narrow these to
//       bias random trees toward good-looking shapes WITHOUT touching the code grid, the default, or
//       what you can dial in by hand. Omit to default to [min, max]. randMin/randMax must lie within
//       [min, max]; randomForm snaps them onto the grid regardless.
//
//   TUNING (below RANGES) — every generation constant that is NOT a form field: colors, proportions,
//     modifier recipes, mask ranges. These aren't encoded in the code and aren't in the UI, but they
//     live here too so retuning the tree means editing this one file. tree.ts imports them.

export type Range = {
  min: number;
  max: number;
  step: number;
  default: number; // the value DEFAULT_FORM uses; must sit on the min/max/step grid
  randMin?: number;
  randMax?: number;
};

export const RANGES = {
  // Jitter PRNG seed: random spans the whole domain (that's the source of per-tree variation).
  seed: { min: 0, max: 1_048_575, step: 1, default: 1 },

  // Trunk + branch topology.
  height: { min: 2, max: 7, step: 0.25, default: 4, randMin: 3, randMax: 6 },
  branchCount: { min: 0, max: 8, step: 1, default: 3, randMin: 2, randMax: 6 },
  branchLevels: { min: 1, max: 3, step: 1, default: 3, randMin: 2, randMax: 3 },
  branchL2: { min: 0, max: 5, step: 1, default: 2, randMin: 1, randMax: 3 }, // L2 children per parent
  branchL3: { min: 0, max: 5, step: 1, default: 1, randMin: 0, randMax: 2 }, // L3 children per parent

  // Root topology.
  rootLevels: { min: 1, max: 3, step: 1, default: 1, randMin: 1, randMax: 1 },
  rootL2: { min: 0, max: 5, step: 1, default: 2, randMin: 1, randMax: 3 },
  rootL3: { min: 0, max: 5, step: 1, default: 1, randMin: 0, randMax: 2 },

  // Proportions.
  trunkRadius: { min: 0.2, max: 0.6, step: 0.01, default: 0.45, randMin: 0.35, randMax: 0.55 },
  radiusScale: { min: 0.4, max: 0.8, step: 0.02, default: 0.6, randMin: 0.5, randMax: 0.7 }, // radius × per level
  tipScale: { min: 0.05, max: 0.25, step: 0.01, default: 0.12, randMin: 0.08, randMax: 0.16 }, // tip taper fraction

  // Branch joint lean clamp (°) at L1..L3.
  branchLean1: { min: 0, max: 90, step: 5, default: 30, randMin: 15, randMax: 40 },
  branchLean2: { min: 0, max: 90, step: 5, default: 60, randMin: 45, randMax: 70 },
  branchLean3: { min: 0, max: 90, step: 5, default: 70, randMin: 55, randMax: 80 },

  // Roots.
  rootRadius: { min: 0.2, max: 0.7, step: 0.01, default: 0.53, randMin: 0.4, randMax: 0.6 },
  rootHeight: { min: 0, max: 0.5, step: 0.01, default: 0.03, randMin: 0, randMax: 0.08 }, // trunk fraction roots attach
  rootLength: { min: 0.5, max: 3, step: 0.05, default: 1.6, randMin: 1.2, randMax: 2.4 },
  rootDownAngle: { min: -90, max: 90, step: 5, default: 0, randMin: -10, randMax: 5 }, // <0 tilts the flare up
  rootDownCurve: { min: -90, max: 90, step: 5, default: 0, randMin: -10, randMax: 10 }, // <0 curves the flare up
  maxRoots: { min: 0, max: 16, step: 1, default: 8, randMin: 5, randMax: 10 },
  rootSeparation: { min: 0, max: 2, step: 0.05, default: 0.6, randMin: 0.4, randMax: 1 },
  rootLSmooth: { min: 0, max: 1, step: 0.05, default: 0.5, randMin: 0.3, randMax: 0.8 },

  // Trunk crown coil (curls the top 20% of the trunk into a scroll). Appended last so the code grid
  // grows here; turns = 0 or amount = 0 disables the coil (identity), so Random can roll it off.
  trunkCoilTurns: { min: 0, max: 1.5, step: 0.05, default: 0.5, randMin: 0.5, randMax: 1 },
  trunkCoilAmount: { min: 0, max: 1, step: 0.05, default: 1, randMin: 0, randMax: 1 },
  trunkCoilBias: { min: 2, max: 4, step: 0.05, default: 1.4, randMin: 0, randMax: 4 },

  // Root scroll coil (curls the tip 40% of every root — main roots and sub-limbs — into a
  // fiddlehead). One shared set drives all root levels. Appended after the trunk coil so the code
  // grid keeps growing at the end; turns = 0 or amount = 0 disables it (identity). Roots allow more
  // turns than the trunk crown since a scroll reads well at the thin root tip.
  rootCoilTurns: { min: 0, max: 3, step: 0.05, default: 2, randMin: 0, randMax: 1 },
  rootCoilAmount: { min: 0, max: 1, step: 0.05, default: 1, randMin: 0.5, randMax: 1 },
  rootCoilBias: { min: 0.5, max: 4, step: 0.05, default: 1.4, randMin: 1, randMax: 4 },
} satisfies Record<string, Range>;

// Non-form generation constants: colors, proportions, silhouette ratios, modifier recipes, and mask
// s-ranges. These aren't encoded in the tree code and aren't in the UI — but they live here so
// retuning the tree is a one-file edit. tree.ts imports TUNING and applies it.
export const TUNING = {
  // Per-limb-system disc-tube colors.
  colors: {
    trunk: 0x8a6a4f, // brown
    branch: 0x6abf5a, // green
    root: 0xd98a3d, // amber
  },

  // Mesh / proportion constants.
  tubeOpacity: 0.35,
  taperCurve: [0.33, 0.33, 0.66, 0.66] as [number, number, number, number], // linear taper, base→tip
  subdivisionRef: 16, // subdivisions at which per-level densities apply as-is (discs are 16-gons)
  minSubdivisions: 3,
  defaultSubdivisions: 6, // initial mesh resolution (not part of the form/code; a pure resolution knob)
  branchRadiusRatio: 0.75, // a limb's start radius is capped to this × the parent radius at the branch
  levelDensity: [16, 16, 16, 16], // mesher ring density per branch level
  rootLeanAngles: [90, 90, 90], // roots stay unconstrained so the authored down direction is preserved

  // Limb silhouette ratios.
  subFan: 0.9, // half-angle (rad) sub-limbs fan around their parent's heading
  trunkLeanX: 0.12, // trunk tip x-offset as a fraction of height (a slight lean)
  branchLengthFrac: 0.45, // L1 branch length as a fraction of trunk height
  limbLengthScale: 0.6, // limb length multiplier per deeper level
  limbRise: 0.5, // limb tip vertical rise (branches) / drop (roots) as a fraction of its length
  rootSteps: 9, // authored polyline samples per root (before smooth)

  // Modifier mask s-ranges (where each displacement acts along the line).
  masks: {
    easeCurve: [0.5, 0, 0.5, 1] as [number, number, number, number], // shared fade easing
    footAnchorFadeIn: 0.08, // trunk gnarl/twist fade in over the base 8% (pins the ground point)
    rootScrollStart: 0.6, // roots: gnarled shank 0..0.6, curled scroll tip 0.6..1
    trunkCrownStart: 0.8, // trunk crown coil acts on the top 20% (0.8..1)
  },

  // Radius-of-curvature safety margin the discAlign mesh-safety pass keeps (× the local tube radius).
  discAlignSafety: 1.1,

  // Displacement-modifier recipes per limb system. The coil params that come from the form (trunk +
  // root coil) are applied where the stacks are built, not here.
  modifiers: {
    trunk: {
      smooth: { mode: "laplacian", segments: 24 },
      gnarl: { amount: 1, amplitude: 0.18, cycles: 1.6 },
      twist: { amount: 0.6, radius: 0.06, turns: 1 },
      footAlign: { height: 0.15, amount: 1 },
    },
    branch: {
      smooth: { mode: "laplacian", segments: 12 },
      gnarl: { amount: 0.8, amplitude: 0.16, cycles: 1.4 },
    },
    rootMain: {
      smooth: { mode: "laplacian", segments: 32, strength: 0.3 },
      gnarl: { amount: 0.7, amplitude: 0.14, cycles: 1.4 },
    },
    rootSub: {
      smooth: { mode: "laplacian", segments: 12 },
      gnarl: { amount: 0.7, amplitude: 0.14, cycles: 1.4 },
    },
  } as const,
};
