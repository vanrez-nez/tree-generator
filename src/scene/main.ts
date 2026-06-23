import * as THREE from "three";
import { Graph } from "./graph/graph";
import type { GraphLine } from "./graph/line";
import { GnarlModifier } from "./graph/modifiers/gnarl";
import { SmoothModifier } from "./graph/modifiers/smooth";
import { TwistModifier } from "./graph/modifiers/twist";

export class MainScene {
  readonly scene = new THREE.Scene();
  readonly graph = new Graph();
  readonly gnarlModifier = new GnarlModifier({ amount: 1 });
  readonly smoothModifier = new SmoothModifier({ enabled: true, mode: "laplacian" });
  readonly twistModifier = new TwistModifier({ amount: 1 });
  readonly line: GraphLine;

  constructor() {
    this.scene.background = new THREE.Color(0x111111);
    this.scene.add(this.graph.group);

    this.line = this.graph.addLine({
      color: 0x8fd3ff,
      debugT: 0.5,
      points: [
        new THREE.Vector3(0, -1.2, 0),
        new THREE.Vector3(0, 1.2, 0),
      ],
      modifiers: [this.gnarlModifier, this.twistModifier, this.smoothModifier],
      segments: 16,
      thickness: 1,
    });

    const light = new THREE.DirectionalLight(0xffffff, 3);
    light.position.set(2, 2, 3);
    this.scene.add(light);
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.8));
  }

  update(_deltaTime: number, camera: THREE.Camera, viewportSize?: THREE.Vector2): void {
    this.graph.update(camera, viewportSize);
  }
}
