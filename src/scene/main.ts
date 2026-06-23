import * as THREE from "three";
import { Graph } from "./graph/graph";
import type { GraphLine } from "./graph/line";
import { GnarlModifier } from "./graph/modifiers/gnarl";
import { SmoothModifier } from "./graph/modifiers/smooth";
import { TwistModifier } from "./graph/modifiers/twist";

export type LinePreset = "vertical" | "l-line";

export class MainScene {
  readonly scene = new THREE.Scene();
  readonly graph = new Graph();
  readonly gnarlModifier = new GnarlModifier({ amount: 1 });
  readonly smoothModifier = new SmoothModifier({
    enabled: true,
    mode: "laplacian",
    segments: 16,
  });
  readonly twistModifier = new TwistModifier({ amount: 1 });
  readonly line: GraphLine;
  private currentLinePreset: LinePreset = "vertical";

  constructor() {
    this.scene.background = new THREE.Color(0x111111);
    this.scene.add(this.graph.group);

    this.line = this.graph.addLine({
      color: 0x8fd3ff,
      debugT: 0.5,
      points: getLinePresetPoints(this.currentLinePreset),
      modifiers: [this.smoothModifier, this.gnarlModifier, this.twistModifier],
      thickness: 1,
    });

    const light = new THREE.DirectionalLight(0xffffff, 3);
    light.position.set(2, 2, 3);
    this.scene.add(light);
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.8));
  }

  get linePreset(): LinePreset {
    return this.currentLinePreset;
  }

  set linePreset(preset: LinePreset) {
    this.currentLinePreset = preset;
    this.line.points = getLinePresetPoints(preset);
  }

  update(_deltaTime: number, camera: THREE.Camera, viewportSize?: THREE.Vector2): void {
    this.graph.update(camera, viewportSize);
  }
}

function getLinePresetPoints(preset: LinePreset): THREE.Vector3[] {
  if (preset === "l-line") {
    return [
      new THREE.Vector3(-0.8, 1.2, 0),
      new THREE.Vector3(-0.8, -1.2, 0),
      new THREE.Vector3(0.8, -1.2, 0),
    ];
  }

  return [
    new THREE.Vector3(0, -1.2, 0),
    new THREE.Vector3(0, 1.2, 0),
  ];
}
