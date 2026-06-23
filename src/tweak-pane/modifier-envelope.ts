import type {
  CubicBezierApi,
  CubicBezierObject,
} from "@tweakpane/plugin-essentials";
import type { FolderApi } from "tweakpane";
import type { LineModifier } from "../scene/graph/modifiers/modifier";

export function addModifierEnvelopeControls(
  folder: FolderApi,
  modifier: LineModifier,
): void {
  folder.addBinding(modifier.envelope, "fadeInEnabled", {
    label: "fadeIn",
  });

  folder.addBinding(modifier.envelope, "fadeIn", {
    label: "fadeInRange",
    min: 0,
    max: 1,
    step: 0.01,
  });

  folder.addBinding(modifier.envelope, "fadeOutEnabled", {
    label: "fadeOut",
  });

  folder.addBinding(modifier.envelope, "fadeOut", {
    label: "fadeOutRange",
    min: 0,
    max: 1,
    step: 0.01,
  });

  const curveBlade = folder
    .addBlade({
      view: "cubicbezier",
      value: modifier.envelope.curve,
      expanded: false,
      label: "fadeCurve",
      picker: "inline",
    }) as CubicBezierApi;

  curveBlade.on("change", (event) => {
    modifier.envelope.curve = event.value.toObject() as CubicBezierObject;
  });
}
