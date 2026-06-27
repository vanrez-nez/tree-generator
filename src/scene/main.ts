import * as THREE from "three";
import { Graph } from "./graph/graph";
import type { GraphDocument } from "./graph/document";
import { DEFAULT_SUBDIVISIONS, buildTreeDocument } from "./tree";
import { DEFAULT_FORM, type TreeForm } from "./tree-code";
import { RootSystem } from "./root-system";
import { TreeMesher } from "./mesher/tree-mesher";
import type { MesherOptions } from "./mesher/welding-mesher";
import { MaterialGraphController } from "./material/graph/controller";

// How long graph edits must settle before the (expensive) surface mesh is rebuilt.
const MESH_REBUILD_DEBOUNCE_MS = 200;

export const DEFAULT_MESHER_OPTIONS: MesherOptions = {
  radialResolution: 32,
  smoothIterations: 4,
  caps: {
    trunk: { length: 1, roundness: 1 },
    branch: { length: 1, roundness: 1 },
    root: { length: 1.5, roundness: 0.3 },
  },
};

export class MainScene {
  readonly scene = new THREE.Scene();
  readonly graph = new Graph();
  readonly mesher = new TreeMesher();
  // Owns the editable material graph document + the compiled surface material (src/scene/material/graph).
  readonly materialController = new MaterialGraphController();

  // Scene lighting, exposed so the Scene panel can drive intensity/colour live. The flat ambient is kept
  // low — a shared IBL environment (scene.environment, set up in app.ts) provides the fill that gives the
  // tree form, and a strong flat ambient would wash out the baked AO. Directional stays as a cheap key.
  readonly directionalLight = new THREE.DirectionalLight(0xffffff, 3);
  readonly ambientLight = new THREE.AmbientLight(0xffffff, 0.15);

  selectedLineId = "trunk";

  // Last surface generation: build time + geometry size, surfaced in the pane's stats readout.
  readonly meshStats = { geometryMs: 0, textureMs: 0, totalMs: 0, vertices: 0, triangles: 0 };

  // The tree's form (everything that shapes the graph) and the mesh resolution. The form
  // round-trips through the reversible tree code; subdivisions is a pure resolution knob.
  private form: TreeForm = { ...DEFAULT_FORM };
  private subdivisions = DEFAULT_SUBDIVISIONS;
  private currentDocument: GraphDocument = { lines: [], joints: [] };
  private mesherOptions: MesherOptions = { ...DEFAULT_MESHER_OPTIONS };
  private discsVisible = false;
  private debugHelpers: THREE.Group | undefined;
  // Global debug-point config, persisted here so it survives graph rebuilds (loadTree creates
  // fresh lines). Defaults mirror GraphLine's own defaults.
  private debugPointVisible = true;
  private debugLinePointsVisible = false;
  private debugT = 0.5;
  private meshDirty = false;
  private meshRebuildTimer: ReturnType<typeof setTimeout> | undefined;
  // Last graph-geometry signature we reacted to. The graph is the source of truth: whenever its
  // drawn geometry changes (from any source — UI, joints, root system, code), the signature
  // changes and we schedule a rebuild. Undefined until the first frame so the initial mesh builds.
  private lastSignature: number | undefined;

  constructor() {
    this.scene.background = new THREE.Color(0x111111);
    this.scene.add(this.graph.group);
    this.scene.add(this.mesher.object);
    this.loadTree();

    // Bind the compiled material graph to the surface, and re-push it whenever the graph recompiles
    // (topology / backend / structural-param edits from the node editor).
    this.mesher.setSurfaceMaterial(this.materialController.material);
    this.materialController.onRecompile(() =>
      this.mesher.setSurfaceMaterial(this.materialController.material),
    );

    this.directionalLight.position.set(2, 2, 3);
    this.scene.add(this.directionalLight);
    this.scene.add(this.ambientLight);

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

  // Replace the tree's form and rebuild the graph from scratch (count/topology may change).
  setTreeForm(form: TreeForm): void {
    this.form = { ...form };
    this.loadTree();
  }

  // Change the global mesh resolution (disc vertex count + density) and rebuild. Form is unchanged.
  setSubdivisions(subdivisions: number): void {
    this.subdivisions = subdivisions;
    this.loadTree();
  }

  // The most recent generated document, exposed for export.
  getDocument(): GraphDocument {
    return this.currentDocument;
  }

  private loadTree(): void {
    const { document, params } = buildTreeDocument(this.form, this.subdivisions);
    this.currentDocument = document;
    this.graph.loadDocument(document);
    this.selectedLineId = document.lines[0]?.id ?? "trunk";

    const trunk = this.graph.getLineById("trunk");
    const rootLines = this.graph
      .getLineEntries()
      .filter(({ id }) => /^root-\d+$/.test(id))
      .map(({ line }) => line);
    // Wire the main roots' parent-riding attachments. RootSystem is now a wiring helper, not a
    // per-frame driver: the root lines retain it via their attachment closures and pull it lazily.
    new RootSystem(trunk, rootLines, params);
    // Reapply the persisted disc-overlay visibility: loadTree creates fresh tubes (visible by
    // default), so without this a rebuild from any control would silently re-show the discs.
    this.applyDiscsVisibility();
    this.applyDebugConfig();
    // No explicit rebuild trigger here: loadTree replaces the lines, so the graph signature
    // changes and `update` schedules the rebuild on the next frame.
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

  // Merge new mesher options and rebuild the surface (debounced).
  setMesherOptions(options: Partial<MesherOptions>): void {
    this.mesherOptions = { ...this.mesherOptions, ...options };
    this.scheduleMeshRebuild();
  }

  // Rebuild the surface mesh immediately on the next update (the manual "Rebuild mesh" button).
  rebuildMesh(): void {
    if (this.meshRebuildTimer !== undefined) {
      clearTimeout(this.meshRebuildTimer);
      this.meshRebuildTimer = undefined;
    }
    this.meshDirty = true;
  }

  // Coalesce bursts of graph edits (slider drags, typing) into a single rebuild: each call resets
  // the timer, so the surface is rebuilt once the user pauses. The build itself runs on the next
  // frame in `update`, after `graph.update` has settled the geometry the mesher reads.
  scheduleMeshRebuild(): void {
    if (this.meshRebuildTimer !== undefined) {
      clearTimeout(this.meshRebuildTimer);
    }
    this.meshRebuildTimer = setTimeout(() => {
      this.meshRebuildTimer = undefined;
      this.meshDirty = true;
    }, MESH_REBUILD_DEBOUNCE_MS);
  }

  update(_deltaTime: number, camera: THREE.Camera, viewportSize?: THREE.Vector2): void {
    this.graph.update(camera, viewportSize);

    // The graph is the source of truth: react to changes in its drawn geometry, not to UI events.
    const signature = this.graph.getGeometrySignature();
    if (signature !== this.lastSignature) {
      this.lastSignature = signature;
      this.scheduleMeshRebuild();
    }

    if (this.meshDirty) {
      const start = performance.now();
      this.mesher.build(this.graph, this.mesherOptions);
      this.meshStats.geometryMs = performance.now() - start;
      const { vertices, triangles } = this.mesher.getStats();
      this.meshStats.vertices = vertices;
      this.meshStats.triangles = triangles;
      this.meshDirty = false;
    }

    // Texture time = the offline channel re-bake (render to RTs); 0 in the live backend. Total = geometry
    // + texture. Refreshed each frame (cheap) so the read-only monitors pick up the latest values.
    this.meshStats.textureMs = this.materialController.lastBakeMs;
    this.meshStats.totalMs = this.meshStats.geometryMs + this.meshStats.textureMs;
  }
}
