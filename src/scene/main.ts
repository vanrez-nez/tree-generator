import * as THREE from "three";
import { Graph } from "./graph/graph";
import { buildTreeDocument } from "./tree";

const TREE_GRAPH_DOCUMENT = buildTreeDocument();

export class MainScene {
  readonly scene = new THREE.Scene();
  readonly graph = new Graph();

  selectedLineId = TREE_GRAPH_DOCUMENT.lines[0].id;

  constructor() {
    this.scene.background = new THREE.Color(0x111111);
    this.scene.add(this.graph.group);
    this.graph.loadDocument(TREE_GRAPH_DOCUMENT);

    const light = new THREE.DirectionalLight(0xffffff, 3);
    light.position.set(2, 2, 3);
    this.scene.add(light);
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.8));
  }

  update(_deltaTime: number, camera: THREE.Camera, viewportSize?: THREE.Vector2): void {
    this.graph.update(camera, viewportSize);
  }
}
