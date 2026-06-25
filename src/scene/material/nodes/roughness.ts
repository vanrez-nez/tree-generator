import * as THREE from "three";
import { type BakeContext, MaterialNode, type NodeKind } from "../engine/node";
import { FULLSCREEN_VERT } from "../glsl/noise";

// Roughness from height — maps the shared height field into a roughness range (optionally inverted
// so cavities read rougher). Output is linear grayscale bound as MeshStandardMaterial.roughnessMap
// (sampled from the G channel, multiplied by material.roughness = 1). Keeps roughness coherent with
// the same masks driving normal/AO/basecolor.

export type RoughnessParams = {
  min: number; // roughness at height 0
  max: number; // roughness at height 1
  invert: boolean;
};

export const DEFAULT_ROUGHNESS_PARAMS: RoughnessParams = {
  min: 0.6,
  max: 0.95,
  invert: false,
};

const FRAG = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D uInput;
  uniform float uMin;
  uniform float uMax;
  uniform float uInvert;
  void main(){
    float t = texture2D(uInput, vUv).r;
    t = mix(t, 1.0 - t, uInvert);
    float r = mix(uMin, uMax, t);
    gl_FragColor = vec4(vec3(r), 1.0);
  }
`;

export class RoughnessNode extends MaterialNode {
  readonly kind: NodeKind = "data";
  readonly params: RoughnessParams;
  private readonly material: THREE.ShaderMaterial;

  constructor(
    private readonly source: MaterialNode,
    params: Partial<RoughnessParams> = {},
  ) {
    super();
    this.params = { ...DEFAULT_ROUGHNESS_PARAMS, ...params };
    this.material = new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: FRAG,
      uniforms: {
        uInput: { value: null },
        uMin: { value: this.params.min },
        uMax: { value: this.params.max },
        uInvert: { value: this.params.invert ? 1 : 0 },
      },
    });
  }

  protected override inputs(): MaterialNode[] {
    return [this.source];
  }

  protected paramSignature(): string {
    const p = this.params;
    return `roughness:${p.min}:${p.max}:${p.invert}`;
  }

  protected render(ctx: BakeContext, target: THREE.WebGLRenderTarget): void {
    const u = this.material.uniforms;
    u.uInput.value = this.source.resolve(ctx);
    u.uMin.value = this.params.min;
    u.uMax.value = this.params.max;
    u.uInvert.value = this.params.invert ? 1 : 0;
    ctx.runner.render(this.material, target);
  }

  override dispose(): void {
    this.material.dispose();
    super.dispose();
  }
}
