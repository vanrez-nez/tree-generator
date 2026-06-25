// Shared tileable-noise GLSL (the doc's "tiling is an invariant" — one periodic hash reused
// everywhere). Stefan Gustavson periodic ("classic") Perlin noise (public domain) + an FBM helper
// whose period doubles each octave, so results tile seamlessly over uv = 0..1 when `tiles`/`seed`
// are integers. Inline these strings into a fragment shader before `main`.

export const PERLIN_GLSL = /* glsl */ `
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
`;

// fbm(uv, tiles, octaves, gain, seed) -> ~[-1, 1]. Tiles/seed integer for exact tiling.
export const FBM_GLSL = /* glsl */ `
  float fbm(vec2 uv, float tiles, int octaves, float gain, float seed){
    const int MAX_OCTAVES = 8;
    float freq = tiles, amp = 1.0, sum = 0.0, norm = 0.0;
    vec2 seedOff = vec2(seed * 7.0, seed * 13.0); // integer lattice offset, tiling-safe
    for (int o = 0; o < MAX_OCTAVES; o++){
      if (o >= octaves) break;
      sum  += amp * pnoise(uv * freq + seedOff, vec2(freq));
      norm += amp;
      amp  *= gain;
      freq *= 2.0;
    }
    return sum / max(norm, 1e-5);
  }
`;

// Full-screen quad vertex shader shared by every generator/filter pass.
export const FULLSCREEN_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;
