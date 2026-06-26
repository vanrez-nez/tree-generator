import * as THREE from "three";
import { type BakeContext, MaterialNode, type NodeKind } from "../../engine/node";
import { FBM_GLSL, FULLSCREEN_VERT, PERLIN_GLSL } from "../../glsl/noise";

// Bark Fibers — turns a broad height substrate into long axial bark ridges. The result stays a
// tileable height field: all breakup is periodic noise and the dominant bands wrap in U.

export type BarkFibersParams = {
  verticalScale: number;
  ridgeCount: number;
  ridgeSharpness: number;
  ridgeContrast: number;
  waviness: number;
  breakup: number;
};

export const DEFAULT_BARK_FIBERS_PARAMS: BarkFibersParams = {
  verticalScale: 2.5,
  ridgeCount: 18,
  ridgeSharpness: 2.8,
  ridgeContrast: 0.35,
  waviness: 0.18,
  breakup: 0.16,
};

const FRAG = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D uInput;
  uniform float uVerticalScale;
  uniform float uRidgeCount;
  uniform float uRidgeSharpness;
  uniform float uRidgeContrast;
  uniform float uWaviness;
  uniform float uBreakup;

  ${PERLIN_GLSL}
  ${FBM_GLSL}

  void main(){
    float base = texture2D(uInput, vUv).r;

    float flow = fbm(vUv, 4.0, 4, 0.55, 37.0);
    float phase = vUv.x * uRidgeCount + flow * uWaviness;
    float stripe = 0.5 + 0.5 * sin(phase * 6.2831853);
    float ridge = pow(stripe, max(uRidgeSharpness, 0.01));

    float fine = fbm(vUv, max(2.0, uVerticalScale * 2.0), 5, 0.52, 53.0);
    float splinter = smoothstep(0.1, 0.85, ridge + fine * uBreakup);
    float valleys = pow(1.0 - stripe, 2.0);

    float h = base + splinter * uRidgeContrast - valleys * uRidgeContrast * 0.6;
    gl_FragColor = vec4(vec3(clamp(h, 0.0, 1.0)), 1.0);
  }
`;

export class BarkFibersNode extends MaterialNode {
  readonly kind: NodeKind = "data";
  readonly params: BarkFibersParams;
  private readonly material: THREE.ShaderMaterial;

  constructor(
    private readonly source: MaterialNode,
    params: Partial<BarkFibersParams> = {},
  ) {
    super();
    this.params = { ...DEFAULT_BARK_FIBERS_PARAMS, ...params };
    this.material = new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: FRAG,
      uniforms: {
        uInput: { value: null },
        uVerticalScale: { value: this.params.verticalScale },
        uRidgeCount: { value: this.params.ridgeCount },
        uRidgeSharpness: { value: this.params.ridgeSharpness },
        uRidgeContrast: { value: this.params.ridgeContrast },
        uWaviness: { value: this.params.waviness },
        uBreakup: { value: this.params.breakup },
      },
    });
  }

  protected override inputs(): MaterialNode[] {
    return [this.source];
  }

  protected paramSignature(): string {
    const p = this.params;
    return `barkFibers:${p.verticalScale}:${p.ridgeCount}:${p.ridgeSharpness}:${p.ridgeContrast}:${p.waviness}:${p.breakup}`;
  }

  protected render(ctx: BakeContext, target: THREE.WebGLRenderTarget): void {
    const u = this.material.uniforms;
    u.uInput.value = this.source.resolve(ctx);
    u.uVerticalScale.value = this.params.verticalScale;
    u.uRidgeCount.value = this.params.ridgeCount;
    u.uRidgeSharpness.value = this.params.ridgeSharpness;
    u.uRidgeContrast.value = this.params.ridgeContrast;
    u.uWaviness.value = this.params.waviness;
    u.uBreakup.value = this.params.breakup;
    ctx.runner.render(this.material, target);
  }

  override dispose(): void {
    this.material.dispose();
    super.dispose();
  }
}
