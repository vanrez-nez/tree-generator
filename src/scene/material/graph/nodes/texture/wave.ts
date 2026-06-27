import type { MaterialNodeDef } from "../../types";
import { blenderWave } from "../../../tsl/blender-wave";

const WAVE_TYPES = ["bands", "rings"];
const DIRS = ["x", "y", "z", "diagonal"];
const PROFILES = ["sine", "saw", "triangle"];

// Wave Texture (Blender ShaderNodeTexWave, Fac output) — faithful port (tsl/blender-wave.ts). `scale`
// multiplies the domain; type/direction/profile are build-time selects; phase/distortion/detail-scale/
// detail-roughness are live uniforms; detail (octaves) is a build-time loop count for the fBm distortion.
export const waveNode: MaterialNodeDef = {
  type: "wave",
  nodeClass: "texture",
  label: "Wave",
  inputs: [{ key: "coord", kind: "vector" }],
  outputs: [{ key: "field", kind: "float" }],
  params: [
    { key: "scale", label: "scale", type: "float", min: 0.1, max: 8, step: 0.05, default: 1 },
    { key: "waveType", label: "type", type: "select", options: WAVE_TYPES, default: "bands" },
    { key: "direction", label: "direction", type: "select", options: DIRS, default: "x" },
    { key: "profile", label: "profile", type: "select", options: PROFILES, default: "sine" },
    { key: "phase", label: "phase", type: "float", min: 0, max: 20, step: 0.1, default: 0 },
    { key: "distortion", label: "distortion", type: "float", min: 0, max: 10, step: 0.1, default: 0 },
    { key: "detail", label: "detail", type: "int", min: 0, max: 8, step: 1, default: 2 },
    { key: "detailScale", label: "detail scale", type: "float", min: 0, max: 8, step: 0.1, default: 1 },
    { key: "detailRoughness", label: "detail rough", type: "float", min: 0, max: 1, step: 0.01, default: 0.5 },
  ],
  build(ctx) {
    const p = (ctx.inputs.coord ?? ctx.coord).mul(ctx.uniforms.scale);
    const opts = {
      waveType: Math.max(0, WAVE_TYPES.indexOf(ctx.params.waveType as string)),
      dir: Math.max(0, DIRS.indexOf(ctx.params.direction as string)),
      profile: Math.max(0, PROFILES.indexOf(ctx.params.profile as string)),
      withDistortion: Number(ctx.params.distortion ?? 0) > 0,
      detail: (ctx.params.detail as number) ?? 2,
    };
    return {
      field: blenderWave(
        p,
        ctx.uniforms.phase,
        ctx.uniforms.distortion,
        ctx.uniforms.detailScale,
        ctx.uniforms.detailRoughness,
        opts,
      ),
    };
  },
};
