import * as THREE from "three";
import { type BakeContext, MaterialNode, type NodeKind } from "../engine/node";

// Normal from height — central-difference slope → tangent-space normal, encoded to [0,1]. Output is
// a linear half-float buffer bound as MeshStandardMaterial.normalMap. Tangent basis matches our UV
// (x = around the trunk, y = axial); the height texture wraps, so neighbour taps cross the seam and
// the normals tile. Flip `normalScale.y` on the material if green reads inverted.

export type NormalParams = {
  strength: number;
};

export const DEFAULT_NORMAL_PARAMS: NormalParams = {
  strength: 8.0,
};

const VERT = /* glsl */ `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const FRAG = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D uHeight;
  uniform vec2 uTexel;     // 1 / resolution
  uniform float uStrength;
  void main() {
    float hL = texture2D(uHeight, vUv - vec2(uTexel.x, 0.0)).r;
    float hR = texture2D(uHeight, vUv + vec2(uTexel.x, 0.0)).r;
    float hD = texture2D(uHeight, vUv - vec2(0.0, uTexel.y)).r;
    float hU = texture2D(uHeight, vUv + vec2(0.0, uTexel.y)).r;
    // Per-texel slope × strength (height is 0..1, so adjacent diffs are small — strength is the
    // bump-intensity knob). x = around (U), y = axial (V).
    vec3 n = normalize(vec3((hL - hR) * uStrength, (hD - hU) * uStrength, 1.0));
    gl_FragColor = vec4(n * 0.5 + 0.5, 1.0);
  }
`;

export class NormalNode extends MaterialNode {
  readonly kind: NodeKind = "data";
  readonly params: NormalParams;
  private readonly material: THREE.ShaderMaterial;

  constructor(
    private readonly height: MaterialNode,
    params: Partial<NormalParams> = {},
  ) {
    super();
    this.params = { ...DEFAULT_NORMAL_PARAMS, ...params };
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uHeight: { value: null },
        uTexel: { value: new THREE.Vector2() },
        uStrength: { value: this.params.strength },
      },
    });
  }

  protected override inputs(): MaterialNode[] {
    return [this.height];
  }

  protected paramSignature(): string {
    return `normal:${this.params.strength}`;
  }

  protected render(ctx: BakeContext, target: THREE.WebGLRenderTarget): void {
    const u = this.material.uniforms;
    u.uHeight.value = this.height.resolve(ctx);
    (u.uTexel.value as THREE.Vector2).set(1 / ctx.width, 1 / ctx.height);
    u.uStrength.value = this.params.strength;
    ctx.runner.render(this.material, target);
  }

  override dispose(): void {
    this.material.dispose();
    super.dispose();
  }
}
