import * as THREE from "three";
import { type BakeContext, MaterialNode, type NodeKind } from "../engine/node";

// Ambient Occlusion from height — cavity darkening: sample the height in a ring around each texel;
// where neighbours rise above the centre, darken. Output linear grayscale bound as aoMap (uses the
// uv1 set). This is a first, honest pass; real quality (multi-radius, more taps) is a later polish
// — the doc flags AO as a quality cliff. The height texture wraps so AO tiles.

export type AoParams = {
  radius: number; // sample radius in texels
  strength: number;
};

export const DEFAULT_AO_PARAMS: AoParams = {
  radius: 6,
  strength: 4,
};

const VERT = /* glsl */ `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const FRAG = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D uHeight;
  uniform vec2 uTexel;
  uniform float uRadius;
  uniform float uStrength;

  const int TAPS = 12;

  void main() {
    float h = texture2D(uHeight, vUv).r;
    float occ = 0.0;
    for (int i = 0; i < TAPS; i++) {
      float a = (float(i) + 0.5) / float(TAPS) * 6.2831853;
      vec2 dir = vec2(cos(a), sin(a)) * uTexel * uRadius;
      float hn = texture2D(uHeight, vUv + dir).r;
      occ += max(0.0, hn - h);
    }
    occ /= float(TAPS);
    float ao = clamp(1.0 - occ * uStrength, 0.0, 1.0);
    gl_FragColor = vec4(vec3(ao), 1.0);
  }
`;

export class AoNode extends MaterialNode {
  readonly kind: NodeKind = "data";
  readonly params: AoParams;
  private readonly material: THREE.ShaderMaterial;

  constructor(
    private readonly height: MaterialNode,
    params: Partial<AoParams> = {},
  ) {
    super();
    this.params = { ...DEFAULT_AO_PARAMS, ...params };
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uHeight: { value: null },
        uTexel: { value: new THREE.Vector2() },
        uRadius: { value: this.params.radius },
        uStrength: { value: this.params.strength },
      },
    });
  }

  protected override inputs(): MaterialNode[] {
    return [this.height];
  }

  protected paramSignature(): string {
    return `ao:${this.params.radius}:${this.params.strength}`;
  }

  protected render(ctx: BakeContext, target: THREE.WebGLRenderTarget): void {
    const u = this.material.uniforms;
    u.uHeight.value = this.height.resolve(ctx);
    (u.uTexel.value as THREE.Vector2).set(1 / ctx.width, 1 / ctx.height);
    u.uRadius.value = this.params.radius;
    u.uStrength.value = this.params.strength;
    ctx.runner.render(this.material, target);
  }

  override dispose(): void {
    this.material.dispose();
    super.dispose();
  }
}
