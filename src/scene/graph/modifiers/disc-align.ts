import * as THREE from "three";
import { cubicBezierEasing, type CubicBezierCurve } from "../curve";
import {
  createDefaultMask,
  type LineModifier,
  type MaskedLine,
  type ModifierMask,
} from "./modifier";
import { makePerpendicularBasis, sampleSWithArcLength } from "./utils";

export type DiscAlignModifierParams = {
  clearance: number; // the BASE (max) tube radius the discs must clear (injected per line by the tree)
  clearanceTipScale: number; // tube tip radius = clearance * this; 1 = untapered clamp
  clearanceCurve: CubicBezierCurve; // taper easing along s (mirrors the tube's taper curve)
  safety: number; // K: keep radius of curvature >= safety * local clearance
  spacing: number; // target uniform arc-length spacing between points (0 = keep current count)
};

export type DiscAlignModifierOptions = Partial<DiscAlignModifierParams> & {
  enabled?: boolean;
  mask?: ModifierMask;
};

/**
 * Makes a line mesh-ready (`smooth_pipes.md`): the pipe of radius `clearance` is singularity-free
 * only while `clearance < reach`, whose local term is the radius of curvature. So we resample the
 * line to a uniform spacing and hard-clamp the turn per step to
 * `θmax = 2·asin(min(1, s / (2·K·clearance)))`, guaranteeing the discrete radius of curvature
 * `s / (2·sin(θ/2)) >= K·clearance` — i.e. the perpendicular discs can never cross on a bend.
 *
 * The clearance FOLLOWS THE TUBE'S TAPER: at each sample the floor uses the local radius
 * `lerp(clearance, clearance·clearanceTipScale, ease(s))`, not the base radius. A single max-radius
 * floor over-constrains reconstructions living at the thin tip — it unwound the coil modifier's
 * scroll eye ~8x more than disc safety needed (the eye only has to clear the local tip radius).
 *
 * This is a mesh-safety pass meant to run last on the FULL line — it deliberately ignores its mask
 * (a masked safety pass could leave disc-crossing bends outside its range); the tapered floor is
 * what keeps it from over-constraining masked reconstructions like coil.
 */
export class DiscAlignModifier implements LineModifier<DiscAlignModifierParams> {
  readonly name = "discAlign";
  enabled: boolean;
  mask: ModifierMask;
  params: DiscAlignModifierParams;

  constructor({
    clearance = 0,
    clearanceTipScale = 1,
    clearanceCurve = [0.33, 0.33, 0.66, 0.66],
    enabled = true,
    mask = createDefaultMask(),
    safety = 1.1,
    spacing = 0,
  }: DiscAlignModifierOptions = {}) {
    this.enabled = enabled;
    this.mask = mask;
    this.params = {
      clearance,
      clearanceTipScale,
      clearanceCurve,
      safety,
      spacing,
    };
  }

  applyMasked(input: MaskedLine): MaskedLine {
    const { points, s } = input;

    if (points.length < 2) {
      return { points: points.map((point) => point.clone()), s };
    }

    let total = 0;
    for (let index = 1; index < points.length; index += 1) {
      total += points[index - 1].distanceTo(points[index]);
    }
    if (total <= 1e-6) {
      return { points: points.map((point) => point.clone()), s };
    }

    // Uniform resample (carrying s) so the curvature test has a constant step. Never resample COARSER
    // than the incoming segmentation: `spacing` (the mesher's ring density, injected by assignTubes) would
    // otherwise downsample smooth's curve, and the clamp — running on that coarse step — would facet a
    // tight bend (e.g. a root's base corner) into a few hard-angled chords instead of a smooth arc.
    // The incoming count always wins over any cap: coil supersamples its scroll body up to ~1024
    // points, and downsampling that eye here would facet its windings before the clamp even runs.
    // The mesher resamples every line to its own ring density independently (graph-adapter
    // buildLineChain), so keeping the fine density here is free for the mesh.
    const MAX_UPSAMPLE = 2048; // caps only the spacing-driven request
    const requested =
      this.params.spacing > 1e-4 ? Math.round(total / this.params.spacing) : points.length - 1;
    const segments = Math.max(4, points.length - 1, Math.min(requested, MAX_UPSAMPLE));
    const resampled = sampleSWithArcLength(points, s, segments);
    const resampledPoints = resampled.points;
    const step = total / segments;

    const clearance = this.params.clearance;
    if (clearance <= 0) {
      return resampled;
    }

    const safety = Math.max(this.params.safety, 1e-3);
    const { clearanceTipScale, clearanceCurve } = this.params;
    const tapered = clearanceTipScale < 1 - 1e-6;
    // Untapered fast path: one turn cap for the whole line (also the pre-taper behavior).
    const flatSinHalf = THREE.MathUtils.clamp(step / (2 * safety * clearance), 0, 1);
    const flatMaxTurn = 2 * Math.asin(flatSinHalf);

    const result: THREE.Vector3[] = [resampledPoints[0].clone()];
    let heading = resampledPoints[1].clone().sub(resampledPoints[0]).normalize();
    result.push(resampledPoints[0].clone().addScaledVector(heading, step));

    for (let index = 1; index < segments; index += 1) {
      const desired = resampledPoints[index + 1].clone().sub(resampledPoints[index]);

      if (desired.lengthSq() > 1e-12) {
        desired.normalize();
        const angle = Math.acos(THREE.MathUtils.clamp(heading.dot(desired), -1, 1));

        let maxTurn = flatMaxTurn;
        if (tapered) {
          // Local tube radius at this sample's material coordinate. `s` is the REST-line arc
          // fraction while the mesher's radiusAt uses the deformed line's arc fraction — close
          // enough for a safety floor (modifiers shift relative arc length by a few percent at
          // most; `safety` absorbs it). At the tip the clearance → ~0 and the clamp opens up
          // (sinHalf saturates at 1 → maxTurn π), which is correct for a zero-radius tip.
          const eased = cubicBezierEasing(
            THREE.MathUtils.clamp(resampled.s[index], 0, 1),
            clearanceCurve,
          );
          const localClearance = THREE.MathUtils.lerp(
            clearance,
            clearance * clearanceTipScale,
            eased,
          );
          const sinHalf = THREE.MathUtils.clamp(step / (2 * safety * localClearance), 0, 1);
          maxTurn = 2 * Math.asin(sinHalf);
        }

        if (angle > maxTurn + 1e-9) {
          let axis = heading.clone().cross(desired);
          if (axis.lengthSq() < 1e-12) {
            axis = makePerpendicularBasis(heading)[0];
          }
          axis.normalize();
          heading = heading.clone().applyAxisAngle(axis, maxTurn);
        } else {
          heading = desired;
        }
      }

      result.push(result[index].clone().addScaledVector(heading, step));
    }

    return { points: result, s: resampled.s };
  }
}
