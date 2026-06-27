import type { MaterialGraphDocument } from "../graph/types";
import defaultDoc from "./default.json";
import checkersDoc from "./checkers.json";
import voronoiCellsDoc from "./voronoi-cells.json";
import zincDoc from "./zinc.json";
import rustyMetalDoc from "./rusty-metal.json";
import woodPlanksDoc from "./wood-planks.json";
import asphaltDoc from "./asphalt.json";
import barkDoc from "./bark.json";

// Material preset registry. Each preset is a plain JSON MaterialGraphDocument under presets/. Add a new
// `<name>.json` and one entry here to surface it in the Material panel's preset selector.
interface Preset {
  key: string;
  label: string;
  doc: MaterialGraphDocument;
}

export const MATERIAL_PRESETS: Preset[] = [
  { key: "empty", label: "Empty", doc: defaultDoc as MaterialGraphDocument },
  { key: "checkers", label: "Checkers", doc: checkersDoc as MaterialGraphDocument },
  { key: "voronoi-cells", label: "Voronoi Cells", doc: voronoiCellsDoc as MaterialGraphDocument },
  { key: "zinc", label: "Zinc", doc: zincDoc as MaterialGraphDocument },
  { key: "rusty-metal", label: "Rusty Metal", doc: rustyMetalDoc as MaterialGraphDocument },
  { key: "wood-planks", label: "Wood Planks", doc: woodPlanksDoc as MaterialGraphDocument },
  { key: "asphalt", label: "Asphalt", doc: asphaltDoc as MaterialGraphDocument },
  { key: "bark", label: "Bark", doc: barkDoc as MaterialGraphDocument },
];
export const DEFAULT_PRESET = "empty"; // presets/default.json — the document loaded on a fresh session

// Deep-clone the preset (the imported JSON is shared; loadDocument mutates the doc, so callers need a copy).
export function makePreset(key: string): MaterialGraphDocument {
  const preset = MATERIAL_PRESETS.find((p) => p.key === key) ?? MATERIAL_PRESETS[0];
  return structuredClone(preset.doc);
}

// The document loaded on a fresh session / reset (no persisted graph).
export function createDefaultDocument(): MaterialGraphDocument {
  return makePreset(DEFAULT_PRESET);
}
