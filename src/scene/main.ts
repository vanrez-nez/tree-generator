import * as THREE from "three";
import { Graph } from "./graph/graph";
import { DEFAULT_TREE_OPTIONS, buildTreeDocument, type TreeOptions } from "./tree";
import { RootSystem } from "./root-system";
import { LineMesher } from "./meshing/line-mesher";
import { createRootInfluenceDeformer } from "./meshing/tube-deformer";

export class MainScene {
  readonly scene = new THREE.Scene();
  readonly graph = new Graph();
  readonly mesher = new LineMesher();

  selectedLineId = "trunk";

  private treeOptions: TreeOptions = {};
  private rootSystem: RootSystem | undefined;
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
    this.meshDirty = true;
  }

  // Rebuild the line meshes on the next update, once the graph geometry has settled.
  rebuildMesh(): void {
    this.meshDirty = true;
  }

  update(_deltaTime: number, camera: THREE.Camera, viewportSize?: THREE.Vector2): void {
    this.graph.update(camera, viewportSize, () => {
      this.rootSystem?.update();
      this.applyRootInfluenceDeformer();
    });

    if (this.meshDirty) {
      this.mesher.build(this.graph);
      this.meshDirty = false;
    }
  }

  private applyRootInfluenceDeformer(): void {
    const params = { ...DEFAULT_TREE_OPTIONS, ...this.treeOptions };
    const deformer = createRootInfluenceDeformer(
      this.rootSystem?.getInnerInfluences() ?? [],
      THREE.MathUtils.clamp(params.rootInfluence, 0, 1),
    );

    for (const { id, line } of this.graph.getLineEntries()) {
      if (!line.tube) continue;
      line.tube.deformer = id === "trunk" ? deformer : undefined;
    }
  }
}
