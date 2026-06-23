import * as THREE from "three";
import { Graph } from "./graph/graph";

export class MainScene {
  readonly scene = new THREE.Scene();
  readonly graph = new Graph();

  constructor() {
    this.scene.background = new THREE.Color(0x111111);
    this.scene.add(this.graph.group);

    this.graph.addLine({
      color: 0x8fd3ff,
      debugT: 0.35,
      points: [
        new THREE.Vector3(-1.5, -0.75, 0),
        new THREE.Vector3(-0.5, 0.75, 0),
        new THREE.Vector3(0.5, -0.25, 0),
        new THREE.Vector3(1.5, 0.9, 0),
      ],
      smooth: true,
      thickness: 1,
    });

    this.graph.addLine({
      color: 0xffc857,
      debugT: 0.65,
      points: [
        new THREE.Vector3(-1.4, 0.7, -0.25),
        new THREE.Vector3(-0.3, -0.55, -0.25),
        new THREE.Vector3(0.8, 0.5, -0.25),
      ],
      style: "dashed",
    });

    const light = new THREE.DirectionalLight(0xffffff, 3);
    light.position.set(2, 2, 3);
    this.scene.add(light);
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.8));
  }

  update(_deltaTime: number, camera: THREE.Camera): void {
    this.graph.update(camera);
  }
}
