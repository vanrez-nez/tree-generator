import * as THREE from "three";
import { type BakeContext, MaterialNode, type NodeKind } from "../engine/node";
import { FULLSCREEN_VERT } from "../glsl/noise";
import { createDataTarget } from "../engine/targets";

// Slope Blur — the #1 weathering operator. Iteratively smears the input DOWNHILL along the gradient
// of a guide field (here the input itself), producing erosion-like streaks that break up procedural
// regularity. This is a multi-pass node: it ping-pongs between two scratch targets for `iterations`
// steps, then copies the result into its output. iterations = 0 is passthrough. Tileable because
// every tap wraps (RepeatWrapping).

export type SlopeBlurParams = {
  iterations: number; // ping-pong steps (0 = off)
  intensity: number; // downhill step in texels per iteration
};

export const DEFAULT_SLOPE_BLUR_PARAMS: SlopeBlurParams = {
  iterations: 0,
  intensity: 2,
};

const ITER_FRAG = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D uInput;  // current smeared field
  uniform sampler2D uGuide;  // fixed guide (original field) — gradient direction
  uniform vec2 uTexel;
  uniform float uIntensity;
  void main(){
    float gL = texture2D(uGuide, vUv - vec2(uTexel.x, 0.0)).r;
    float gR = texture2D(uGuide, vUv + vec2(uTexel.x, 0.0)).r;
    float gD = texture2D(uGuide, vUv - vec2(0.0, uTexel.y)).r;
    float gU = texture2D(uGuide, vUv + vec2(0.0, uTexel.y)).r;
    vec2 grad = vec2(gR - gL, gU - gD);
    vec2 dir = length(grad) > 1e-5 ? normalize(grad) : vec2(0.0);
    // Average a few taps stepping downhill (-gradient) → smear along slopes.
    float acc = texture2D(uInput, vUv).r;
    float w = 1.0;
    for (int i = 1; i <= 3; i++) {
      vec2 off = dir * uTexel * uIntensity * float(i);
      acc += texture2D(uInput, vUv - off).r;
      w += 1.0;
    }
    gl_FragColor = vec4(vec3(acc / w), 1.0);
  }
`;

const COPY_FRAG = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D uTex;
  void main(){ gl_FragColor = texture2D(uTex, vUv); }
`;

export class SlopeBlurNode extends MaterialNode {
  readonly kind: NodeKind = "data";
  readonly params: SlopeBlurParams;

  private readonly iterMaterial: THREE.ShaderMaterial;
  private readonly copyMaterial: THREE.ShaderMaterial;
  private scratchA: THREE.WebGLRenderTarget | null = null;
  private scratchB: THREE.WebGLRenderTarget | null = null;

  constructor(
    private readonly source: MaterialNode,
    params: Partial<SlopeBlurParams> = {},
  ) {
    super();
    this.params = { ...DEFAULT_SLOPE_BLUR_PARAMS, ...params };
    this.iterMaterial = new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: ITER_FRAG,
      uniforms: {
        uInput: { value: null },
        uGuide: { value: null },
        uTexel: { value: new THREE.Vector2() },
        uIntensity: { value: this.params.intensity },
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
    return `slopeBlur:${this.params.iterations}:${this.params.intensity}`;
  }

  protected render(ctx: BakeContext, target: THREE.WebGLRenderTarget): void {
    const guide = this.source.resolve(ctx);
    const iterations = Math.max(0, Math.round(this.params.iterations));

    if (iterations === 0) {
      this.copyMaterial.uniforms.uTex.value = guide; // passthrough
      ctx.runner.render(this.copyMaterial, target);
      return;
    }

    if (!this.scratchA) this.scratchA = createDataTarget(ctx.width, ctx.height);
    if (!this.scratchB) this.scratchB = createDataTarget(ctx.width, ctx.height);

    const u = this.iterMaterial.uniforms;
    (u.uTexel.value as THREE.Vector2).set(1 / ctx.width, 1 / ctx.height);
    u.uIntensity.value = this.params.intensity;
    u.uGuide.value = guide; // fixed gradient source

    let read = guide;
    let write = this.scratchA;
    let other = this.scratchB;
    for (let i = 0; i < iterations; i++) {
      u.uInput.value = read;
      ctx.runner.render(this.iterMaterial, write);
      read = write.texture;
      const swap = write;
      write = other;
      other = swap;
    }

    this.copyMaterial.uniforms.uTex.value = read;
    ctx.runner.render(this.copyMaterial, target);
  }

  override dispose(): void {
    this.iterMaterial.dispose();
    this.copyMaterial.dispose();
    this.scratchA?.dispose();
    this.scratchB?.dispose();
    this.scratchA = null;
    this.scratchB = null;
    super.dispose();
  }
}
