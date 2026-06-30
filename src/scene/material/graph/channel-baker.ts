import { QuadMesh, RenderTarget, MeshBasicNodeMaterial, type WebGPURenderer } from "three/webgpu";
import { NoColorSpace, NearestFilter, RepeatWrapping } from "three";
import { vec3, vec2, sRGBTransferOETF, texture, uniform, uv, normalize } from "three/tsl";
import type { MaterialValue, PbrSocket } from "./types";

// Colour-management convention (plan L5 / Phase 6): the graph works in LINEAR space, and a baked texture
// follows texture convention — colour channels are sRGB-encoded (display), data channels stay linear.
// Scalar-field channels render as linear grayscale; colour channels get the sRGB OETF; normal is already
// an encoded [0,1] vector (from normal-from-height) and stays linear/raw.
export const FIELD_CHANNELS: PbrSocket[] = ["roughness", "metallic", "ambientOcclusion"];
export const COLOR_CHANNELS: PbrSocket[] = ["baseColor", "emission"];

// Per-channel encoding into a renderable colorNode. Shared by the channel baker (preview/PNG) and the
// offline surface baker so both produce identical texels (and the offline RT's colorSpace lines up).
export function encodeChannel(node: MaterialValue, channel: PbrSocket): MaterialValue {
  if (FIELD_CHANNELS.includes(channel)) return vec3(node); // linear grayscale data
  if (COLOR_CHANNELS.includes(channel)) return sRGBTransferOETF(node); // sRGB-encode (display convention)
  return node; // normal / other: already-encoded vector data, leave linear
}

// Supersampled fullscreen-quad baker. A single-sample point bake aliases any high-frequency procedural
// content (Wave at tens–hundreds of cycles, near-step Color Ramps, noise) into hard edges — and makes the
// screen-space normal derivative unusable except at a near-zero strength. So we render the channel at SS×
// the target into a raw high-res RT, then box-downsample SS×SS taps into the destination — matching
// Blender's anti-aliased bake. (MSAA on the RT would not help: it only anti-aliases geometry edges, not
// the shader content of a fullscreen quad.) Module-level singletons: bakes are synchronous.
const SS = 4;
const bakeMaterial = new MeshBasicNodeMaterial();
const bakeQuad = new QuadMesh(bakeMaterial);

// Raw high-res intermediate: stores the already-encoded channel values verbatim (no colorspace / filtering
// so the box taps read exact texels). Resized in place so the prebuilt downsample nodes keep referencing it.
const ssRT = new RenderTarget(SS, SS);
ssRT.texture.colorSpace = NoColorSpace;
ssRT.texture.minFilter = ssRT.texture.magFilter = NearestFilter;
ssRT.texture.wrapS = ssRT.texture.wrapT = RepeatWrapping; // box taps at tile edges wrap, not clamp
const ssTexel = uniform(vec2(1 / SS, 1 / SS)); // 1 / high-res size, set per bake

// Box filter: average the SS×SS high-res texels covering each destination texel. The normal channel must
// average decoded vectors (raw encoded [0,1] normals don't average linearly), then renormalize + re-encode.
function downsampleNode(isNormal: boolean): MaterialValue {
  const c = (SS - 1) / 2;
  let acc: MaterialValue = vec3(0, 0, 0);
  for (let j = 0; j < SS; j++)
    for (let i = 0; i < SS; i++) {
      const off = vec2(i - c, j - c).mul(ssTexel);
      let s: MaterialValue = texture(ssRT.texture, uv().add(off)).xyz;
      if (isNormal) s = s.mul(2).sub(1);
      acc = acc.add(s);
    }
  acc = acc.div(SS * SS);
  return isNormal ? normalize(acc).mul(0.5).add(0.5) : acc;
}
const downColorMat = new MeshBasicNodeMaterial();
downColorMat.colorNode = downsampleNode(false);
const downNormalMat = new MeshBasicNodeMaterial();
downNormalMat.colorNode = downsampleNode(true);
const downColorQuad = new QuadMesh(downColorMat);
const downNormalQuad = new QuadMesh(downNormalMat);

// Render `colorNode` into `rt`, supersampled. `isNormal` switches the downsample to vector-correct averaging.
export function renderColorNodeToTarget(
  renderer: WebGPURenderer,
  colorNode: MaterialValue,
  rt: RenderTarget,
  isNormal = false,
): void {
  const w = rt.width;
  const h = rt.height;
  if (ssRT.width !== w * SS || ssRT.height !== h * SS) ssRT.setSize(w * SS, h * SS);
  ssTexel.value.set(1 / (w * SS), 1 / (h * SS));
  bakeMaterial.colorNode = colorNode;
  bakeMaterial.needsUpdate = true;
  const previous = renderer.getRenderTarget();
  renderer.setRenderTarget(ssRT); // 1) render the channel at SS×
  bakeQuad.render(renderer);
  renderer.setRenderTarget(rt); // 2) box-downsample into the destination
  (isNormal ? downNormalQuad : downColorQuad).render(renderer);
  renderer.setRenderTarget(previous);
}
