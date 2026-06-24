import * as THREE from "three";
import { Graph } from "./graph/graph";
import { DEFAULT_TREE_OPTIONS, buildTreeDocument, type TreeOptions } from "./tree";
import { RootSystem } from "./root-system";
import { TreeMesher } from "./mesher/tree-mesher";
import type { MesherOptions } from "./mesher/welding-mesher";

export const DEFAULT_MESHER_OPTIONS: MesherOptions = {
  radialResolution: 32,
  smoothIterations: 4,
};

export class MainScene {
  readonly scene = new THREE.Scene();
  readonly graph = new Graph();
  readonly mesher = new TreeMesher();

  selectedLineId = "trunk";

  private treeOptions: TreeOptions = {};
  private rootSystem: RootSystem | undefined;
  private mesherOptions: MesherOptions = { ...DEFAULT_MESHER_OPTIONS };
  private discsVisible = false;
  private debugHelpers: THREE.Group | undefined;
  // Global debug-point config, persisted here so it survives graph rebuilds (loadTree creates
  // fresh lines). Defaults mirror GraphLine's own defaults.
  private debugPointVisible = true;
  private debugLinePointsVisible = false;
  private debugT = 0.5;
  private meshDirty = true;

  constructor() {
    this.scene.background = new THREE.Color(0x111111);
    this.scene.add(this.graph.group);
    this.scene.add(this.mesher.object);
    this.loadTree();

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
    this.debugHelpers = debug;
  }

  // Toggle the whole line skeleton (drawn as an always-visible overlay).
  setGraphVisible(visible: boolean): void {
    this.graph.group.visible = visible;
  }

  // Toggle the spatial-reference helpers (ground plane, grid, axes).
  setDebugHelpersVisible(visible: boolean): void {
    if (this.debugHelpers) this.debugHelpers.visible = visible;
  }

  setDebugPointVisible(visible: boolean): void {
    this.debugPointVisible = visible;
    this.applyDebugConfig();
  }

  setDebugLinePointsVisible(visible: boolean): void {
    this.debugLinePointsVisible = visible;
    this.applyDebugConfig();
  }

  setDebugT(t: number): void {
    this.debugT = t;
    this.applyDebugConfig();
  }

  private applyDebugConfig(): void {
    for (const { line } of this.graph.getLineEntries()) {
      line.debugPointVisible = this.debugPointVisible;
      line.debugLinePointsVisible = this.debugLinePointsVisible;
      line.debugT = this.debugT;
    }
  }

  // Merge new tree options and rebuild the graph from scratch (count/topology may change).
  setTreeOptions(options: TreeOptions): void {
    this.treeOptions = { ...this.treeOptions, ...options };
    this.loadTree();
  }

  private loadTree(): void {
    const document = buildTreeDocument(this.treeOptions);
    this.graph.loadDocument(document);
    this.selectedLineId = document.lines[0]?.id ?? "trunk";

    const params = { ...DEFAULT_TREE_OPTIONS, ...this.treeOptions };
    const trunk = this.graph.getLineById("trunk");
    const rootLines = this.graph
      .getLineEntries()
      .filter(({ id }) => /^root-\d+$/.test(id))
      .map(({ line }) => line);
    this.rootSystem = new RootSystem(trunk, rootLines, params);
    // Reapply the persisted disc-overlay visibility: loadTree creates fresh tubes (visible by
    // default), so without this a rebuild from any control would silently re-show the discs.
    this.applyDiscsVisibility();
    this.applyDebugConfig();
    this.meshDirty = true;
  }

  // The disc overlay (per-line cross-section rings) is an editing aid, owned here so its
  // visibility survives graph rebuilds. Off by default.
  setDiscsVisible(visible: boolean): void {
    this.discsVisible = visible;
    this.applyDiscsVisibility();
  }

  private applyDiscsVisibility(): void {
    for (const { line } of this.graph.getLineEntries()) {
      if (line.tube) line.tube.visible = this.discsVisible;
    }
  }

  // Merge new mesher options and rebuild the surface on the next update.
  setMesherOptions(options: Partial<MesherOptions>): void {
    this.mesherOptions = { ...this.mesherOptions, ...options };
    this.meshDirty = true;
  }

  // Rebuild the surface mesh on the next update, once the graph geometry has settled.
  rebuildMesh(): void {
    this.meshDirty = true;
  }

  update(_deltaTime: number, camera: THREE.Camera, viewportSize?: THREE.Vector2): void {
    this.graph.update(camera, viewportSize, () => this.rootSystem?.update());

    if (this.meshDirty) {
      this.mesher.build(this.graph, this.mesherOptions);
      this.meshDirty = false;
    }
  }
}
