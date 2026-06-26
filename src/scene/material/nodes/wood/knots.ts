import * as THREE from "three";
import { type BakeContext, MaterialNode, type NodeKind } from "../../engine/node";
import { FULLSCREEN_VERT } from "../../glsl/noise";

// Knots — texture-only circular/ring scars embedded into the shared height field. This deliberately
// does not deform geometry; normals/AO/basecolor pick it up from the final height.

export type KnotsParams = {
  seed: number;
  count: number;
  radius: number;
  ringContrast: number;
  depression: number;
};

export const DEFAULT_KNOTS_PARAMS: KnotsParams = {
  seed: 4,
  count: 5,
  radius: 0.09,
  ringContrast: 0.22,
  depression: 0.18,
};

const HASH_GLSL = /* glsl */ `
  float hash1(vec2 p){ p = fract(p * vec2(123.34, 345.45)); p += dot(p, p + 34.345); return fract(p.x * p.y); }
  vec2 hash2(vec2 p){
    return fract(sin(vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)))) * 43758.5453);
  }
  vec2 torDelta(vec2 a, vec2 b){ vec2 d = a - b; return d - floor(d + 0.5); }
`;

const FRAG = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D uInput;
  uniform float uSeed;
  uniform float uCount;
  uniform float uRadius;
  uniform float uRingContrast;
  uniform float uDepression;

  ${HASH_GLSL}

  void main(){
    float h = texture2D(uInput, vUv).r;
    float rings = 0.0;
    float pit = 0.0;
    float grid = max(1.0, ceil(sqrt(uCount)));
    vec2 cell = floor(vUv * grid);

    for (int oy = -1; oy <= 1; oy++) {
      for (int ox = -1; ox <= 1; ox++) {
        vec2 c = mod(cell + vec2(float(ox), float(oy)), grid);
        float chance = hash1(c + uSeed);
        if (chance > uCount / (grid * grid)) continue;

        vec2 center = (c + hash2(c + uSeed * 3.7)) / grid;
        vec2 d = torDelta(vUv, center);
        d.x *= 1.7;
        float dist = length(d);
        float mask = 1.0 - smoothstep(uRadius * 0.65, uRadius, dist);
        float ring = (0.5 + 0.5 * sin(dist / max(uRadius, 1e-4) * 44.0)) * mask;
        rings = max(rings, ring);
        pit = max(pit, (1.0 - smoothstep(0.0, uRadius * 0.7, dist)) * mask);
      }
    }

    h += rings * uRingContrast - pit * uDepression;
    gl_FragColor = vec4(vec3(clamp(h, 0.0, 1.0)), 1.0);
  }
`;

export class KnotsNode extends MaterialNode {
  readonly kind: NodeKind = "data";
  readonly params: KnotsParams;
  private readonly material: THREE.ShaderMaterial;

  constructor(
    private readonly source: MaterialNode,
    params: Partial<KnotsParams> = {},
  ) {
    super();
    this.params = { ...DEFAULT_KNOTS_PARAMS, ...params };
    this.material = new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: FRAG,
      uniforms: {
        uInput: { value: null },
        uSeed: { value: this.params.seed },
        uCount: { value: this.params.count },
        uRadius: { value: this.params.radius },
        uRingContrast: { value: this.params.ringContrast },
        uDepression: { value: this.params.depression },
      },
    });
  }

  protected override inputs(): MaterialNode[] {
    return [this.source];
  }

  protected paramSignature(): string {
    const p = this.params;
    return `knots:${p.seed}:${p.count}:${p.radius}:${p.ringContrast}:${p.depression}`;
  }

  protected render(ctx: BakeContext, target: THREE.WebGLRenderTarget): void {
    const u = this.material.uniforms;
    u.uInput.value = this.source.resolve(ctx);
    u.uSeed.value = this.params.seed;
    u.uCount.value = this.params.count;
    u.uRadius.value = this.params.radius;
    u.uRingContrast.value = this.params.ringContrast;
    u.uDepression.value = this.params.depression;
    ctx.runner.render(this.material, target);
  }

  override dispose(): void {
    this.material.dispose();
    super.dispose();
  }
}
