import type {
  CubicBezierApi,
  CubicBezierObject,
} from "@tweakpane/plugin-essentials";
import type { ContainerApi } from "@tweakpane/core";
import type { LineModifier } from "../scene/graph/modifiers/modifier";

// Controls for a modifier's `mask`: the arc-length span it acts on (`range`), the fade-in/out ramp widths
// at the span edges, and the easing curve of those ramps. Replaces the old fadeIn/fadeOut envelope UI.
export function addModifierEnvelopeControls(
  folder: ContainerApi,
  modifier: LineModifier,
): void {
  folder.addBinding(modifier.mask, "range", {
    label: "range",
    min: 0,
    max: 1,
    step: 0.01,
  });

  folder.addBinding(modifier.mask, "fadeIn", {
    label: "fadeIn",
    min: 0,
    max: 0.5,
    step: 0.01,
  });

  folder.addBinding(modifier.mask, "fadeOut", {
    label: "fadeOut",
    min: 0,
    max: 0.5,
    step: 0.01,
  });

  const curveBlade = folder
    .addBlade({
      view: "cubicbezier",
      value: modifier.mask.curve,
      expanded: false,
      label: "fadeCurve",
      picker: "inline",
    }) as CubicBezierApi;

  curveBlade.on("change", (event) => {
    modifier.mask.curve = event.value.toObject() as CubicBezierObject;
  });
}
