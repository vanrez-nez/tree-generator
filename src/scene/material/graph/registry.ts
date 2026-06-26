import type { GraphNode, MaterialNodeDef, PortDef } from "./types";
import { fbmNode } from "./nodes/fbm";
import { domainWarpNode } from "./nodes/domain-warp";
import { voronoiNode } from "./nodes/voronoi";
import { gradientNode } from "./nodes/gradient";
import { waveNode } from "./nodes/wave";
import { anisotropicStripesNode } from "./nodes/anisotropic-stripes";
import { mathNode } from "./nodes/math";
import { levelsNode } from "./nodes/levels";
import { colorRampNode } from "./nodes/color-ramp";
import { blendNode } from "./nodes/blend";
import { invertNode } from "./nodes/invert";
import { brightContrastNode } from "./nodes/bright-contrast";
import { hueSatValNode } from "./nodes/hue-sat-val";
import { rgbCurvesNode } from "./nodes/rgb-curves";
import { luminanceNode, splitChannelsNode, combineChannelsNode } from "./nodes/adapters";
import { clampNode } from "./nodes/clamp";
import { separateXyzNode, combineXyzNode } from "./nodes/xyz";
import { constantFieldNode, constantColorNode } from "./nodes/constant";
import { texCoordNode } from "./nodes/tex-coordinate";
import { vectorMathNode } from "./nodes/vector-math";
import { normalFromHeightNode } from "./nodes/normal-from-height";
import { normalMapNode } from "./nodes/normal-map";
import { mappingNode } from "./nodes/mapping";
import { principledBsdfNode } from "./nodes/principled-bsdf";
import { emissionNode } from "./nodes/emission";
import { materialOutputNode } from "./nodes/material-output";
import { groupNode, groupInputNode, groupOutputNode } from "./nodes/group";

// A node's effective ports: instance-specific (group / group-input / group-output carry `ports`), then a
// mode-driven `declare(params)` interface, else the static MaterialNodeDef. The single lookup used by the
// compiler, controller, and editor adapter.
export function nodePorts(
  node: GraphNode,
  registry: NodeRegistry,
): { inputs: PortDef[]; outputs: PortDef[] } {
  if (node.ports) return node.ports;
  const def = registry.get(node.type);
  if (def.declare) return def.declare(node.params);
  return { inputs: def.inputs, outputs: def.outputs };
}

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
    .register(gradientNode)
    .register(waveNode)
    .register(anisotropicStripesNode)
    .register(mathNode)
    .register(levelsNode)
    .register(colorRampNode)
    .register(blendNode)
    .register(invertNode)
    .register(brightContrastNode)
    .register(hueSatValNode)
    .register(rgbCurvesNode)
    .register(luminanceNode)
    .register(splitChannelsNode)
    .register(combineChannelsNode)
    .register(clampNode)
    .register(separateXyzNode)
    .register(combineXyzNode)
    .register(constantFieldNode)
    .register(constantColorNode)
    .register(texCoordNode)
    .register(vectorMathNode)
    .register(normalFromHeightNode)
    .register(normalMapNode)
    .register(mappingNode)
    .register(principledBsdfNode)
    .register(emissionNode)
    .register(materialOutputNode)
    .register(groupNode)
    .register(groupInputNode)
    .register(groupOutputNode);
}

export const defaultRegistry = createDefaultRegistry();
