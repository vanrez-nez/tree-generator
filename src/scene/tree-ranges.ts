// Single source of truth for every tree form field's range. This is the one file to edit when
// retuning generation.
//
// Each field has:
//   • min / max / step — the FULL domain a value can take. This doubles as the codec grid: a tree
//     code stores each value as an index on this grid (see tree-code.ts). Changing min/max/step
//     therefore changes what existing codes decode to — keep these stable once codes are shared.
//   • randMin / randMax — the window the "Random" button (randomForm) draws from. Narrow these to
//     bias random trees toward good-looking shapes WITHOUT touching the code grid or limiting what
//     you can dial in by hand. Omit to default to [min, max].
//
// randMin/randMax must lie within [min, max]; randomForm snaps them onto the grid regardless.

export type Range = {
  min: number;
  max: number;
  step: number;
  randMin?: number;
  randMax?: number;
};

export const RANGES = {
  // Jitter PRNG seed: random spans the whole domain (that's the source of per-tree variation).
  seed: { min: 0, max: 1_048_575, step: 1 },

  // Trunk + branch topology.
  height: { min: 2, max: 7, step: 0.25, randMin: 3, randMax: 6 },
  branchCount: { min: 0, max: 8, step: 1, randMin: 2, randMax: 6 },
  branchLevels: { min: 1, max: 3, step: 1, randMin: 2, randMax: 3 },
  branchL2: { min: 0, max: 5, step: 1, randMin: 1, randMax: 3 }, // L2 children per parent
  branchL3: { min: 0, max: 5, step: 1, randMin: 0, randMax: 2 }, // L3 children per parent

  // Root topology.
  rootLevels: { min: 1, max: 3, step: 1, randMin: 1, randMax: 1 },
  rootL2: { min: 0, max: 5, step: 1, randMin: 1, randMax: 3 },
  rootL3: { min: 0, max: 5, step: 1, randMin: 0, randMax: 2 },

  // Proportions.
  trunkRadius: { min: 0.2, max: 0.6, step: 0.01, randMin: 0.35, randMax: 0.55 },
  radiusScale: { min: 0.4, max: 0.8, step: 0.02, randMin: 0.5, randMax: 0.7 }, // radius × per level
  tipScale: { min: 0.05, max: 0.25, step: 0.01, randMin: 0.08, randMax: 0.16 }, // tip taper fraction

  // Branch joint lean clamp (°) at L1..L3.
  branchLean1: { min: 0, max: 90, step: 5, randMin: 15, randMax: 40 },
  branchLean2: { min: 0, max: 90, step: 5, randMin: 45, randMax: 70 },
  branchLean3: { min: 0, max: 90, step: 5, randMin: 55, randMax: 80 },

  // Roots.
  rootRadius: { min: 0.2, max: 0.7, step: 0.01, randMin: 0.4, randMax: 0.6 },
  rootHeight: { min: 0, max: 0.5, step: 0.01, randMin: 0, randMax: 0.08 }, // trunk fraction roots attach
  rootLength: { min: 0.5, max: 3, step: 0.05, randMin: 1.2, randMax: 2.4 },
  rootDownAngle: { min: -90, max: 90, step: 5, randMin: -10, randMax: 5 }, // <0 tilts the flare up
  rootDownCurve: { min: -90, max: 90, step: 5, randMin: -10, randMax: 10 }, // <0 curves the flare up
  maxRoots: { min: 0, max: 16, step: 1, randMin: 5, randMax: 10 },
  rootSeparation: { min: 0, max: 2, step: 0.05, randMin: 0.4, randMax: 1 },
  rootLSmooth: { min: 0, max: 1, step: 0.05, randMin: 0.3, randMax: 0.8 },

  // Trunk crown coil (curls the top 20% of the trunk into a scroll). Appended last so the code grid
  // grows here; turns = 0 or amount = 0 disables the coil (identity), so Random can roll it off.
  trunkCoilTurns: { min: 0, max: 1, step: 0.05, randMin: 0, randMax: 1 },
  trunkCoilAmount: { min: 0, max: 1, step: 0.05, randMin: 0, randMax: 1 },
  trunkCoilBias: { min: 0, max: 2, step: 0.05, randMin: 0, randMax: 2 },
} satisfies Record<string, Range>;
