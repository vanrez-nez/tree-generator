import type { MaterialNodeDef } from "./types";
import { fbmNode } from "./nodes/fbm";
import { domainWarpNode } from "./nodes/domain-warp";
import { voronoiNode } from "./nodes/voronoi";
import { anisotropicStripesNode } from "./nodes/anisotropic-stripes";
import { mathNode } from "./nodes/math";
import { levelsNode } from "./nodes/levels";
import { colorRampNode } from "./nodes/color-ramp";
import { blendNode } from "./nodes/blend";
import { luminanceNode, splitChannelsNode, combineChannelsNode } from "./nodes/adapters";
import { constantFieldNode, constantColorNode } from "./nodes/constant";
import { normalFromHeightNode } from "./nodes/normal-from-height";
import { pbrOutputNode } from "./nodes/pbr-output";

// Maps node type -> definition. The single source of truth for ports, params, and the TSL builder.
export class NodeRegistry {
  private readonly defs = new Map<string, MaterialNodeDef>();

  register(def: MaterialNodeDef): this {
    if (this.defs.has(def.type)) throw new Error(`Duplicate node type: ${def.type}`);
    this.defs.set(def.type, def);
    return this;
  }

  get(type: string): MaterialNodeDef {
    const def = this.defs.get(type);
    if (!def) throw new Error(`Unknown node type: ${type}`);
    return def;
  }

  has(type: string): boolean {
    return this.defs.has(type);
  }

  all(): MaterialNodeDef[] {
    return [...this.defs.values()];
  }
}

// Only generic nodes register by default; wood-specific nodes stay out of the registry (and out of the
// palette) — bark is expressed as a preset document wiring these generics (material-graph-plan.md).
export function createDefaultRegistry(): NodeRegistry {
  return new NodeRegistry()
    .register(fbmNode)
    .register(domainWarpNode)
    .register(voronoiNode)
    .register(anisotropicStripesNode)
    .register(mathNode)
    .register(levelsNode)
    .register(colorRampNode)
    .register(blendNode)
    .register(luminanceNode)
    .register(splitChannelsNode)
    .register(combineChannelsNode)
    .register(constantFieldNode)
    .register(constantColorNode)
    .register(normalFromHeightNode)
    .register(pbrOutputNode);
}

export const defaultRegistry = createDefaultRegistry();
