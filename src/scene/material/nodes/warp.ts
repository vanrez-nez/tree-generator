import * as THREE from "three";
import { type BakeContext, MaterialNode, type NodeKind } from "../engine/node";
import { FBM_GLSL, FULLSCREEN_VERT, PERLIN_GLSL } from "../glsl/noise";

// Directional/Vector Warp — displaces the input field's sample positions by a tileable noise vector
// field (the #1 organic break-up alongside slope blur). Warping a tileable input by a periodic warp
// vector keeps the result tileable. intensity 0 = passthrough. Output matches the input kind (data),
// so it slots transparently between the height and the PBR channels (which then derive from the
// warped height — coherent).

export type WarpParams = {
  intensity: number; // warp amount in UV units (0 = off)
  tiles: number; // integer guide-noise period
  octaves: number;
};

export const DEFAULT_WARP_PARAMS: WarpParams = {
  intensity: 0.15,
  tiles: 3,
  octaves: 4,
};

const FRAG = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D uInput;
  uniform float uIntensity;
  uniform float uTiles;
  uniform int   uOctaves;

  ${PERLIN_GLSL}
  ${FBM_GLSL}

  void main(){
    // Two decorrelated periodic FBMs form the warp vector (integer seed offsets keep it tiling-safe).
    float wx = fbm(vUv, uTiles, uOctaves, 0.5, 11.0);
    float wy = fbm(vUv, uTiles, uOctaves, 0.5, 91.0);
    vec2 warped = vUv + vec2(wx, wy) * uIntensity;
    gl_FragColor = texture2D(uInput, warped); // input wraps → tiling preserved
  }
`;

export class WarpNode extends MaterialNode {
  readonly kind: NodeKind = "data";
  readonly params: WarpParams;
  private readonly material: THREE.ShaderMaterial;

  constructor(
    private readonly source: MaterialNode,
    params: Partial<WarpParams> = {},
  ) {
    super();
    this.params = { ...DEFAULT_WARP_PARAMS, ...params };
    this.material = new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: FRAG,
      uniforms: {
        uInput: { value: null },
        uIntensity: { value: this.params.intensity },
        uTiles: { value: this.params.tiles },
        uOctaves: { value: this.params.octaves },
      },
    });
  }

  protected override inputs(): MaterialNode[] {
    return [this.source];
  }

  protected paramSignature(): string {
    const p = this.params;
    return `warp:${p.intensity}:${p.tiles}:${p.octaves}`;
  }

  protected render(ctx: BakeContext, target: THREE.WebGLRenderTarget): void {
    const u = this.material.uniforms;
    u.uInput.value = this.source.resolve(ctx);
    u.uIntensity.value = this.params.intensity;
    u.uTiles.value = this.params.tiles;
    u.uOctaves.value = this.params.octaves;
    ctx.runner.render(this.material, target);
  }

  override dispose(): void {
    this.material.dispose();
    super.dispose();
  }
}
