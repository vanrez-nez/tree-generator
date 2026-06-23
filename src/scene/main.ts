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

    this.addDebugInstrumentation();
  }

  // Debug instrumentation: a ground plane at y = 0 and origin axis helpers (X/Y/Z) for spatial
  // reference. The plane is translucent and non-occluding so the descending roots stay visible.
  private addDebugInstrumentation(): void {
    const debug = new THREE.Group();
    debug.name = "debug";

    const planeSize = 16;
    const plane = new THREE.Mesh(
      new THREE.PlaneGeometry(planeSize, planeSize),
      new THREE.MeshBasicMaterial({
        color: 0x3a3a3a,
        transparent: true,
        opacity: 0.12,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    plane.rotation.x = -Math.PI / 2; // lay the plane flat on the XZ ground plane

    const grid = new THREE.GridHelper(planeSize, planeSize, 0x555555, 0x333333);
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.4;

    const axes = new THREE.AxesHelper(4);

    debug.add(plane, grid, axes);
    this.scene.add(debug);
  }

  update(_deltaTime: number, camera: THREE.Camera, viewportSize?: THREE.Vector2): void {
    this.graph.update(camera, viewportSize);
  }
}
