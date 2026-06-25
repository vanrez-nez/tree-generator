import * as THREE from "three";
import { type BakeContext, MaterialNode, type NodeKind } from "../engine/node";
import { FULLSCREEN_VERT } from "../glsl/noise";
import { createFloatTarget } from "../engine/targets";

// Cells (JFA flood-fill) — the structure tier. Scatters one sparse seed per jittered grid cell, runs
// the Jump-Flooding Algorithm (log₂N passes) so every texel learns its nearest seed (a tileable
// Voronoi / connected-region label), then carves cell-border CRACKS and applies per-cell random
// height ("flood-fill to random") into the input field. This is what gives bark its plated,
// non-repeating look. Multi-pass with internal float ping-pong targets (JFA needs exact seed coords
// → Float + Nearest). crackDepth = 0 and plateAmount = 0 is passthrough.
//
// Toroidal everywhere (wrap sampling + wrap distance) so the cells tile.

export type CellsParams = {
  cells: number; // grid count per axis (integer, for tiling)
  jitter: number; // 0..1 seed jitter within its cell
  seed: number; // integer
  crackDepth: number; // groove depth carved at cell borders
  crackWidth: number; // border width in texels
  plateAmount: number; // per-cell random height offset
};

export const DEFAULT_CELLS_PARAMS: CellsParams = {
  cells: 8,
  jitter: 0.6,
  seed: 0,
  crackDepth: 0.15,
  crackWidth: 2,
  plateAmount: 0.1,
};

const HASH_GLSL = /* glsl */ `
  float hash1(vec2 p){ p = fract(p * vec2(123.34, 345.45)); p += dot(p, p + 34.345); return fract(p.x * p.y); }
  vec2 hash2(vec2 p){
    return fract(sin(vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)))) * 43758.5453);
  }
  float torDist(vec2 a, vec2 b){ vec2 d = abs(a - b); d = min(d, 1.0 - d); return length(d); }
`;

// Seed init: one seed per grid cell, placed at the single texel nearest its jittered point.
// Seed texels store their own uv in RG and 1 in B (valid flag); others store an invalid sentinel.
const INIT_FRAG = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform vec2 uRes;
  uniform float uCells;
  uniform float uJitter;
  uniform float uSeed;
  ${HASH_GLSL}
  void main(){
    vec2 cell = floor(vUv * uCells);
    vec2 h = hash2(mod(cell, uCells) + uSeed);          // periodic → tiles
    vec2 jp = (cell + 0.5 + (h - 0.5) * uJitter) / uCells;
    bool isSeed = ivec2(vUv * uRes) == ivec2(jp * uRes);
    gl_FragColor = isSeed ? vec4(vUv, 1.0, 1.0) : vec4(0.0, 0.0, 0.0, 1.0);
  }
`;

// One JFA jump: keep the nearest valid seed among the 3×3 neighbourhood at the current step.
const JFA_FRAG = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D uBuf;
  uniform vec2 uRes;
  uniform float uStep;
  ${HASH_GLSL}
  void main(){
    vec4 best = vec4(0.0);
    float bestD = 1e9;
    for (int dy = -1; dy <= 1; dy++) {
      for (int dx = -1; dx <= 1; dx++) {
        vec2 o = vec2(float(dx), float(dy)) * uStep / uRes;
        vec4 s = texture2D(uBuf, vUv + o);
        if (s.b > 0.5) {
          float d = torDist(vUv, s.rg);
          if (d < bestD) { bestD = d; best = s; }
        }
      }
    }
    gl_FragColor = best;
  }
`;

// Combine: carve cracks where the nearest seed changes (cell borders), and offset whole plates by a
// per-cell random value. Applied to the input field (the height).
const COMBINE_FRAG = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D uField;
  uniform sampler2D uBuf;
  uniform vec2 uRes;
  uniform float uCells;
  uniform float uSeed;
  uniform float uCrackDepth;
  uniform float uCrackWidth;
  uniform float uPlateAmount;
  ${HASH_GLSL}
  void main(){
    float h = texture2D(uField, vUv).r;
    vec2 sd = texture2D(uBuf, vUv).rg;

    // Cell border: a neighbour belongs to a different seed.
    float edge = 0.0;
    for (int i = 0; i < 4; i++) {
      vec2 dir = i == 0 ? vec2(1.0, 0.0) : i == 1 ? vec2(-1.0, 0.0) : i == 2 ? vec2(0.0, 1.0) : vec2(0.0, -1.0);
      vec2 nsd = texture2D(uBuf, vUv + dir * uCrackWidth / uRes).rg;
      if (torDist(nsd, sd) > 0.5 / uCells) edge = 1.0;
    }

    vec2 cell = floor(sd * uCells + 0.5);
    float plate = hash1(mod(cell, uCells) + uSeed); // 0..1 per cell
    float outH = h + (plate - 0.5) * uPlateAmount - edge * uCrackDepth;
    gl_FragColor = vec4(vec3(clamp(outH, 0.0, 1.0)), 1.0);
  }
`;

const COPY_FRAG = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D uTex;
  void main(){ gl_FragColor = texture2D(uTex, vUv); }
`;

export class CellsNode extends MaterialNode {
  readonly kind: NodeKind = "data";
  readonly params: CellsParams;

  private readonly initMaterial: THREE.ShaderMaterial;
  private readonly jfaMaterial: THREE.ShaderMaterial;
  private readonly combineMaterial: THREE.ShaderMaterial;
  private readonly copyMaterial: THREE.ShaderMaterial;
  private scratchA: THREE.WebGLRenderTarget | null = null;
  private scratchB: THREE.WebGLRenderTarget | null = null;

  constructor(
    private readonly source: MaterialNode,
    params: Partial<CellsParams> = {},
  ) {
    super();
    this.params = { ...DEFAULT_CELLS_PARAMS, ...params };
    const res = new THREE.Vector2();
    this.initMaterial = new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: INIT_FRAG,
      uniforms: {
        uRes: { value: res },
        uCells: { value: this.params.cells },
        uJitter: { value: this.params.jitter },
        uSeed: { value: this.params.seed },
      },
    });
    this.jfaMaterial = new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: JFA_FRAG,
      uniforms: { uBuf: { value: null }, uRes: { value: res }, uStep: { value: 1 } },
    });
    this.combineMaterial = new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: COMBINE_FRAG,
      uniforms: {
        uField: { value: null },
        uBuf: { value: null },
        uRes: { value: res },
        uCells: { value: this.params.cells },
        uSeed: { value: this.params.seed },
        uCrackDepth: { value: this.params.crackDepth },
        uCrackWidth: { value: this.params.crackWidth },
        uPlateAmount: { value: this.params.plateAmount },
      },
    });
    this.copyMaterial = new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: COPY_FRAG,
      uniforms: { uTex: { value: null } },
    });
  }

  protected override inputs(): MaterialNode[] {
    return [this.source];
  }

  protected paramSignature(): string {
    const p = this.params;
    return `cells:${p.cells}:${p.jitter}:${p.seed}:${p.crackDepth}:${p.crackWidth}:${p.plateAmount}`;
  }

  protected render(ctx: BakeContext, target: THREE.WebGLRenderTarget): void {
    const field = this.source.resolve(ctx);

    // Passthrough when the node has no effect (avoids the JFA cost entirely).
    if (this.params.crackDepth <= 0 && this.params.plateAmount === 0) {
      this.copyMaterial.uniforms.uTex.value = field;
      ctx.runner.render(this.copyMaterial, target);
      return;
    }

    if (!this.scratchA) this.scratchA = createFloatTarget(ctx.width, ctx.height);
    if (!this.scratchB) this.scratchB = createFloatTarget(ctx.width, ctx.height);

    const res = new THREE.Vector2(ctx.width, ctx.height);
    (this.initMaterial.uniforms.uRes.value as THREE.Vector2).copy(res);
    this.initMaterial.uniforms.uCells.value = this.params.cells;
    this.initMaterial.uniforms.uJitter.value = this.params.jitter;
    this.initMaterial.uniforms.uSeed.value = this.params.seed;
    ctx.runner.render(this.initMaterial, this.scratchA);

    // JFA: step from N/2 down to 1, halving.
    (this.jfaMaterial.uniforms.uRes.value as THREE.Vector2).copy(res);
    let read = this.scratchA;
    let write = this.scratchB;
    for (let step = Math.floor(Math.max(ctx.width, ctx.height) / 2); step >= 1; step = Math.floor(step / 2)) {
      this.jfaMaterial.uniforms.uBuf.value = read.texture;
      this.jfaMaterial.uniforms.uStep.value = step;
      ctx.runner.render(this.jfaMaterial, write);
      const swap = read;
      read = write;
      write = swap;
    }

    const c = this.combineMaterial.uniforms;
    (c.uRes.value as THREE.Vector2).copy(res);
    c.uField.value = field;
    c.uBuf.value = read.texture;
    c.uCells.value = this.params.cells;
    c.uSeed.value = this.params.seed;
    c.uCrackDepth.value = this.params.crackDepth;
    c.uCrackWidth.value = this.params.crackWidth;
    c.uPlateAmount.value = this.params.plateAmount;
    ctx.runner.render(this.combineMaterial, target);
  }

  override dispose(): void {
    this.initMaterial.dispose();
    this.jfaMaterial.dispose();
    this.combineMaterial.dispose();
    this.copyMaterial.dispose();
    this.scratchA?.dispose();
    this.scratchB?.dispose();
    this.scratchA = null;
    this.scratchB = null;
    super.dispose();
  }
}
