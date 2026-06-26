import * as THREE from "three";
import { type BakeContext, MaterialNode, type NodeKind } from "../../engine/node";
import { FBM_GLSL, PERLIN_GLSL } from "../../glsl/noise";

// Layered bark basecolor — maps the shared height field to bark colour and overlays procedural
// cavity darkening, exposed warm wood, and moss/lichen streaks. Colours are picked as sRGB;
// THREE.Color holds them linearized and the renderer re-encodes to the sRGB color target.

export type GradientMapParams = {
  colorA: string; // low/cavity bark
  colorB: string; // high/dry bark
  exposedWood: string;
  cavityColor: string;
  mossColor: string;
  mossAmount: number;
  mossScale: number;
  mossStreaks: number;
  exposedAmount: number;
  cavityDarkening: number;
};

export const DEFAULT_GRADIENT_MAP_PARAMS: GradientMapParams = {
  colorA: "#21160d",
  colorB: "#8a704f",
  exposedWood: "#b5652f",
  cavityColor: "#070504",
  mossColor: "#718a25",
  mossAmount: 0.28,
  mossScale: 9,
  mossStreaks: 0.45,
  exposedAmount: 0.22,
  cavityDarkening: 0.65,
};

const VERT = /* glsl */ `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const FRAG = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D uInput;
  uniform vec3 uColorA;
  uniform vec3 uColorB;
  uniform vec3 uExposedWood;
  uniform vec3 uCavityColor;
  uniform vec3 uMossColor;
  uniform float uMossAmount;
  uniform float uMossScale;
  uniform float uMossStreaks;
  uniform float uExposedAmount;
  uniform float uCavityDarkening;

  ${PERLIN_GLSL}
  ${FBM_GLSL}

  void main() {
    float h = texture2D(uInput, vUv).r;
    float t = smoothstep(0.05, 0.95, h);
    vec3 bark = mix(uColorA, uColorB, t);

    float cavity = 1.0 - smoothstep(0.0, 0.42, h);
    bark = mix(bark, uCavityColor, cavity * uCavityDarkening);

    float fiber = fbm(vUv, 8.0, 4, 0.55, 121.0);
    float exposedBands = 0.5 + 0.5 * sin(vUv.x * 18.0 * 6.2831853 + fiber * 1.2);
    float exposed = smoothstep(0.72, 0.95, exposedBands + h * 0.35) * uExposedAmount;
    bark = mix(bark, uExposedWood, exposed);

    float streakNoise = fbm(vUv, 5.0, 5, 0.55, 211.0);
    float vertical = smoothstep(
      0.0,
      1.0,
      1.0 - abs(fract(vUv.x * uMossScale + streakNoise * 0.4) - 0.5) * 2.0
    );
    float moss = smoothstep(0.58, 0.9, streakNoise + cavity * 0.7 + vertical * uMossStreaks);
    moss *= uMossAmount;
    bark = mix(bark, uMossColor, moss);

    gl_FragColor = vec4(bark, 1.0);
  }
`;

export class GradientMapNode extends MaterialNode {
  readonly kind: NodeKind = "color";
  readonly params: GradientMapParams;
  private readonly material: THREE.ShaderMaterial;

  constructor(
    private readonly source: MaterialNode,
    params: Partial<GradientMapParams> = {},
  ) {
    super();
    this.params = { ...DEFAULT_GRADIENT_MAP_PARAMS, ...params };
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uInput: { value: null },
        uColorA: { value: new THREE.Color(this.params.colorA) },
        uColorB: { value: new THREE.Color(this.params.colorB) },
        uExposedWood: { value: new THREE.Color(this.params.exposedWood) },
        uCavityColor: { value: new THREE.Color(this.params.cavityColor) },
        uMossColor: { value: new THREE.Color(this.params.mossColor) },
        uMossAmount: { value: this.params.mossAmount },
        uMossScale: { value: this.params.mossScale },
        uMossStreaks: { value: this.params.mossStreaks },
        uExposedAmount: { value: this.params.exposedAmount },
        uCavityDarkening: { value: this.params.cavityDarkening },
      },
    });
  }

  protected override inputs(): MaterialNode[] {
    return [this.source];
  }

  protected paramSignature(): string {
    const p = this.params;
    return `gradientMap:${p.colorA}:${p.colorB}:${p.exposedWood}:${p.cavityColor}:${p.mossColor}:${p.mossAmount}:${p.mossScale}:${p.mossStreaks}:${p.exposedAmount}:${p.cavityDarkening}`;
  }

  protected render(ctx: BakeContext, target: THREE.WebGLRenderTarget): void {
    const u = this.material.uniforms;
    u.uInput.value = this.source.resolve(ctx);
    (u.uColorA.value as THREE.Color).set(this.params.colorA);
    (u.uColorB.value as THREE.Color).set(this.params.colorB);
    (u.uExposedWood.value as THREE.Color).set(this.params.exposedWood);
    (u.uCavityColor.value as THREE.Color).set(this.params.cavityColor);
    (u.uMossColor.value as THREE.Color).set(this.params.mossColor);
    u.uMossAmount.value = this.params.mossAmount;
    u.uMossScale.value = this.params.mossScale;
    u.uMossStreaks.value = this.params.mossStreaks;
    u.uExposedAmount.value = this.params.exposedAmount;
    u.uCavityDarkening.value = this.params.cavityDarkening;
    ctx.runner.render(this.material, target);
  }

  override dispose(): void {
    this.material.dispose();
    super.dispose();
  }
}
