import * as THREE from "three";
import { type BakeContext, MaterialNode, type NodeKind } from "../engine/node";
import { FBM_GLSL, FULLSCREEN_VERT, PERLIN_GLSL } from "../glsl/noise";

// Height generator — a tileable Perlin FBM baked to a LINEAR half-float buffer (8-bit height
// staircases normals). This single height field is the shared substrate the Normal/AO/Curvature
// and basecolor nodes all derive from (coherent PBR derivation). Period doubles each octave and
// `tiles`/`seed` are integers, so it tiles seamlessly over uv = 0..1.

export type HeightParams = {
  seed: number; // integer lattice offset (tiling-safe)
  tiles: number; // integer base period
  octaves: number;
  gain: number;
};

export const DEFAULT_HEIGHT_PARAMS: HeightParams = {
  seed: 0,
  tiles: 6,
  octaves: 5,
  gain: 0.5,
};

const VERT = FULLSCREEN_VERT;

// Periodic Perlin FBM → grayscale height (shared GLSL keeps the tiling hash in one place).
const FRAG = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform float uTiles;
  uniform int   uOctaves;
  uniform float uGain;
  uniform float uSeed;

  ${PERLIN_GLSL}
  ${FBM_GLSL}

  void main(){
    float h = clamp(fbm(vUv, uTiles, uOctaves, uGain, uSeed) * 0.5 + 0.5, 0.0, 1.0);
    gl_FragColor = vec4(vec3(h), 1.0);
  }
`;

export class HeightNode extends MaterialNode {
  readonly kind: NodeKind = "data";
  readonly params: HeightParams;
  private readonly material: THREE.ShaderMaterial;

  constructor(params: Partial<HeightParams> = {}) {
    super();
    this.params = { ...DEFAULT_HEIGHT_PARAMS, ...params };
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uTiles: { value: this.params.tiles },
        uOctaves: { value: this.params.octaves },
        uGain: { value: this.params.gain },
        uSeed: { value: this.params.seed },
      },
    });
  }

  protected paramSignature(): string {
    const p = this.params;
    return `height:${p.seed}:${p.tiles}:${p.octaves}:${p.gain}`;
  }

  protected render(ctx: BakeContext, target: THREE.WebGLRenderTarget): void {
    const u = this.material.uniforms;
    u.uTiles.value = this.params.tiles;
    u.uOctaves.value = this.params.octaves;
    u.uGain.value = this.params.gain;
    u.uSeed.value = this.params.seed;
    ctx.runner.render(this.material, target);
  }

  override dispose(): void {
    this.material.dispose();
    super.dispose();
  }
}
