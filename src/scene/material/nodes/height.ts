import * as THREE from "three";
import { type BakeContext, MaterialNode, type NodeKind } from "../engine/node";

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

const VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

// Stefan Gustavson periodic ("classic") Perlin noise (public domain) + FBM → grayscale height.
const FRAG = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform float uTiles;
  uniform int   uOctaves;
  uniform float uGain;
  uniform float uSeed;

  const int MAX_OCTAVES = 8;

  vec4 mod289(vec4 x){ return x - floor(x * (1.0/289.0)) * 289.0; }
  vec4 permute(vec4 x){ return mod289(((x*34.0)+1.0)*x); }
  vec4 taylorInvSqrt(vec4 r){ return 1.79284291400159 - 0.85373472095314 * r; }
  vec2 fade(vec2 t){ return t*t*t*(t*(t*6.0-15.0)+10.0); }

  float pnoise(vec2 P, vec2 rep){
    vec4 Pi = floor(P.xyxy) + vec4(0.0,0.0,1.0,1.0);
    vec4 Pf = fract(P.xyxy) - vec4(0.0,0.0,1.0,1.0);
    Pi = mod(Pi, rep.xyxy);
    Pi = mod289(Pi);
    vec4 ix = Pi.xzxz; vec4 iy = Pi.yyww;
    vec4 fx = Pf.xzxz; vec4 fy = Pf.yyww;
    vec4 i = permute(permute(ix) + iy);
    vec4 gx = fract(i * (1.0/41.0)) * 2.0 - 1.0;
    vec4 gy = abs(gx) - 0.5;
    vec4 tx = floor(gx + 0.5);
    gx = gx - tx;
    vec2 g00 = vec2(gx.x,gy.x), g10 = vec2(gx.y,gy.y), g01 = vec2(gx.z,gy.z), g11 = vec2(gx.w,gy.w);
    vec4 norm = taylorInvSqrt(vec4(dot(g00,g00),dot(g01,g01),dot(g10,g10),dot(g11,g11)));
    g00 *= norm.x; g01 *= norm.y; g10 *= norm.z; g11 *= norm.w;
    float n00 = dot(g00, vec2(fx.x,fy.x));
    float n10 = dot(g10, vec2(fx.y,fy.y));
    float n01 = dot(g01, vec2(fx.z,fy.z));
    float n11 = dot(g11, vec2(fx.w,fy.w));
    vec2 fade_xy = fade(Pf.xy);
    vec2 n_x = mix(vec2(n00,n01), vec2(n10,n11), fade_xy.x);
    return 2.3 * mix(n_x.x, n_x.y, fade_xy.y);
  }

  void main(){
    float freq = uTiles;
    float amp = 1.0, sum = 0.0, norm = 0.0;
    vec2 seedOff = vec2(uSeed * 7.0, uSeed * 13.0);
    for (int o = 0; o < MAX_OCTAVES; o++) {
      if (o >= uOctaves) break;
      sum  += amp * pnoise(vUv * freq + seedOff, vec2(freq));
      norm += amp;
      amp  *= uGain;
      freq *= 2.0;
    }
    float h = clamp(sum / max(norm, 1e-5) * 0.5 + 0.5, 0.0, 1.0);
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
