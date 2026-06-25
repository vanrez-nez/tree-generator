import * as THREE from "three";
import { type BakeContext, MaterialNode, type NodeKind } from "../engine/node";

// Gradient Map — maps an input grayscale field (the height) to colour via a two-stop ramp. Outputs
// sRGB basecolor. Colours are picked as sRGB; THREE.Color holds them linearized and the renderer
// re-encodes to the sRGB color target, so picker colours round-trip onto the material.map.

export type GradientMapParams = {
  colorA: string; // hex, low
  colorB: string; // hex, high
};

export const DEFAULT_GRADIENT_MAP_PARAMS: GradientMapParams = {
  colorA: "#2a1d10",
  colorB: "#9c7a4a",
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
  void main() {
    float t = texture2D(uInput, vUv).r;
    gl_FragColor = vec4(mix(uColorA, uColorB, t), 1.0);
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
      },
    });
  }

  protected override inputs(): MaterialNode[] {
    return [this.source];
  }

  protected paramSignature(): string {
    return `gradientMap:${this.params.colorA}:${this.params.colorB}`;
  }

  protected render(ctx: BakeContext, target: THREE.WebGLRenderTarget): void {
    const u = this.material.uniforms;
    u.uInput.value = this.source.resolve(ctx);
    (u.uColorA.value as THREE.Color).set(this.params.colorA);
    (u.uColorB.value as THREE.Color).set(this.params.colorB);
    ctx.runner.render(this.material, target);
  }

  override dispose(): void {
    this.material.dispose();
    super.dispose();
  }
}
