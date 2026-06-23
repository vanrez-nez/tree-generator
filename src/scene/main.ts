import * as THREE from "three";
import type { GraphDocument } from "./graph/document";
import { Graph } from "./graph/graph";

const DEMO_GRAPH_DOCUMENT: GraphDocument = {
  lines: [
    {
      id: "trunk",
      color: 0x8fd3ff,
      debugT: 0.5,
      points: [
        [0, -1.2, 0],
        [0, 1.2, 0],
      ],
      thickness: 1,
      modifiers: [
        {
          type: "smooth",
          enabled: true,
          params: {
            mode: "laplacian",
            segments: 16,
          },
        },
        {
          type: "gnarl",
          enabled: true,
          params: {
            amount: 1,
          },
        },
        {
          type: "twist",
          enabled: true,
          params: {
            amount: 1,
          },
        },
      ],
    },
    {
      id: "branch",
      color: 0xffd36a,
      debugT: 0.5,
      points: [
        [0.4, 0, 0],
        [1.3, 0.7, 0],
      ],
      thickness: 1,
      modifiers: [
        {
          type: "smooth",
          enabled: true,
          params: {
            mode: "laplacian",
            segments: 12,
          },
        },
      ],
    },
  ],
  joints: [
    {
      id: "trunk-to-branch",
      sourceLineId: "trunk",
      sourceT: 0.5,
      targetLineId: "branch",
      targetPointIndex: 0,
    },
  ],
};

export class MainScene {
  readonly scene = new THREE.Scene();
  readonly graph = new Graph();

  selectedLineId = DEMO_GRAPH_DOCUMENT.lines[0].id;

  constructor() {
    this.scene.background = new THREE.Color(0x111111);
    this.scene.add(this.graph.group);
    this.graph.loadDocument(DEMO_GRAPH_DOCUMENT);

    const light = new THREE.DirectionalLight(0xffffff, 3);
    light.position.set(2, 2, 3);
    this.scene.add(light);
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.8));
  }

  update(_deltaTime: number, camera: THREE.Camera, viewportSize?: THREE.Vector2): void {
    this.graph.update(camera, viewportSize);
  }
}
