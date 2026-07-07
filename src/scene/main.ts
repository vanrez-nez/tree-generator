import * as THREE from "three";
import { Graph } from "./graph/graph";
import type { GraphDocument } from "./graph/document";
import { DEFAULT_SUBDIVISIONS, buildTreeDocument } from "./tree";
import { DEFAULT_FORM, type TreeForm } from "./tree-code";
import { RootSystem } from "./root-system";
import { RootCollar, type RootCollarOptions } from "./root-collar";
import { RootCrossingDebug, type RootCrossingDebugOptions } from "./root-crossing-debug";
import { extractSliceSegments } from "./root-crossings";
import { TreeMesher } from "./mesher/tree-mesher";
import type { MesherOptions } from "./mesher/welding-mesher";
import { MaterialGraphRuntime } from "material-designer-runtime";

// How long graph edits must settle before the (expensive) surface mesh is rebuilt.
const MESH_REBUILD_DEBOUNCE_MS = 200;
// Directional-light shadow map resolution (square). High for crisp baked edges; cost is paid only when the
// shadow re-bakes (tree regen / sun move), not per frame.
const SHADOW_MAP_SIZE = 2048;

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
  readonly treeMaterial = new MaterialGraphRuntime({ source: "tree" });

  // The visual floor: a solid ground plane purely for presentation (not gameplay/collision).
  readonly floorMaterial = new MaterialGraphRuntime({ source: "floor" });
  private floorPlane: THREE.Mesh<THREE.BufferGeometry, THREE.Material>;
  private floorBaseUv: Float32Array; // unscaled [0,1] uv, kept so the tiling control can re-scale it

  // The root collar: mounded dirt where the roots meet the floor, on its own dirt material. Rebuilt
  // in the same debounced pass as the tree surface (see update()).
  readonly collarMaterial = new MaterialGraphRuntime({ source: "collar" });
  private rootCollar!: RootCollar;
  // Debug overlay: the exact slice outline where the tree mesh crosses the ground (the groove source).
  private readonly rootCrossingDebug = new RootCrossingDebug();
  // Shared gate for the slice extraction — drives BOTH the groove bands and the debug outline.
  private crossingNormalAngle = 20;
  // Segments from the last collar rebuild, kept so the overlay can redraw without re-extracting.
  private lastSliceSegments: number[] = [];

  // Scene lighting, exposed so the Scene panel can drive intensity/colour live. The flat ambient is kept
  // low — a shared IBL environment (scene.environment, set up in app.ts) provides the fill that gives the
  // tree form, and a strong flat ambient would wash out the baked AO. The directional is the KEY that casts
  // the tree's (statically-baked) shadow, so it's a real intensity (not a 0.3 fill) — strong enough for the
  // shadow to read against the IBL fill.
  readonly directionalLight = new THREE.DirectionalLight(0xffffff, 1);
  readonly ambientLight = new THREE.AmbientLight(0xffffff, 0.05);

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
  // Collar params changed but the tree didn't: rebuild only the (cheap) collar next frame, skipping
  // the expensive tree-surface + shadow rebuild.
  private collarDirty = false;
  private meshRebuildTimer: ReturnType<typeof setTimeout> | undefined;
  // Last graph-geometry signature we reacted to. The graph is the source of truth: whenever its
  // drawn geometry changes (from any source — UI, joints, root system, code), the signature
  // changes and we schedule a rebuild. Undefined until the first frame so the initial mesh builds.
  private lastSignature: number | undefined;
  // Last graph-INPUT signature we resolved. The graph is camera/time-independent, so when this is
  // unchanged the junction + drawing resolution would recompute identical geometry — skip it and only do
  // the cheap camera-scale refresh. Undefined until the first frame so the initial resolution runs.
  private lastInputSignature: number | undefined;

  constructor() {
    this.scene.background = new THREE.Color(0x111111);
    this.scene.add(this.graph.group);
    this.scene.add(this.mesher.object);
    this.loadTree();

    this.mesher.setSurfaceMaterial(this.treeMaterial.material);
    this.treeMaterial.surface.onRebuilt(() => this.mesher.setSurfaceMaterial(this.treeMaterial.material));

    // Same light DIRECTION as before (the old (2,2,3) ×4), pushed out so it sits well above the tree top —
    // a directional's shading is distance-independent, but the shadow camera must clear the geometry.
    this.directionalLight.position.set(8, 8, 12);
    this.configureShadow();
    this.scene.add(this.directionalLight);
    this.scene.add(this.directionalLight.target); // target at origin; the shadow camera aims here
    this.scene.add(this.ambientLight);

    // Visual floor plane, bound to its own runtime material.
    this.floorPlane = this.createFloorPlane();
    this.floorBaseUv = (this.floorPlane.geometry.getAttribute("uv").array as Float32Array).slice();
    this.setFloorTiling(6);
    this.scene.add(this.floorPlane);
    this.floorMaterial.surface.onRebuilt(() => {
      this.floorPlane.material = this.floorMaterial.material;
    });

    // Root collar: dirt mounds around the tree base, on the dedicated collar material. It sits at
    // y = 0 (0.01 above the floor plane → no z-fighting), catches the tree's baked shadow, and casts
    // none itself (the mounds are low; avoids a VSM/alpha-caster pass). Its geometry is built lazily
    // in update()'s rebuild block once the graph has resolved.
    this.rootCollar = new RootCollar(this.collarMaterial.material);
    this.rootCollar.mesh.receiveShadow = true;
    this.rootCollar.mesh.castShadow = false;
    this.rootCollar.mesh.position.y = 0;
    this.scene.add(this.rootCollar.mesh);
    this.collarMaterial.surface.onRebuilt(() => this.rootCollar.setMaterial(this.collarMaterial.material));
    // Bleed the tree bark into the collar at the root seam: point the collar at the tree's baked
    // base-colour texture (sampled at the tree's world-space triplanar scale/sharpness), and re-apply
    // the mix whenever the tree material re-bakes (its render-target texture can change).
    this.rootCollar.setTreeColorSource({
      getTexture: () => this.treeMaterial.surface.getChannelTexture("baseColor"),
      scale: this.treeMaterial.surface.scaleUniform,
      sharpness: this.treeMaterial.surface.sharpnessUniform,
    });
    this.treeMaterial.surface.onTexturesUpdated(() => this.rootCollar.refreshColor());

    // Root-crossing debug circles overlay (hidden until the debug toggle turns it on).
    this.scene.add(this.rootCrossingDebug.object);

    this.addDebugInstrumentation();
  }

  // A large flat plane at ground level, carrying the floor material. UVs are scaled by setFloorTiling so the
  // material repeats across it; `vertexAo` is filled with 1 (no form occlusion) since the offline surface
  // material multiplies its AO by that attribute (a plane has none of the tree's baked cavity AO).
  private createFloorPlane(): THREE.Mesh<THREE.BufferGeometry, THREE.Material> {
    const geometry = new THREE.PlaneGeometry(24, 24);
    geometry.rotateX(-Math.PI / 2); // lie flat on the XZ ground plane (faces +Y)
    const vertexCount = geometry.getAttribute("position").count;
    geometry.setAttribute("vertexAo", new THREE.Float32BufferAttribute(new Float32Array(vertexCount).fill(1), 1));
    const mesh = new THREE.Mesh(geometry, this.floorMaterial.material);
    mesh.name = "floor";
    mesh.receiveShadow = true; // catches the tree's baked shadow
    mesh.position.y = -0.01; // just under the debug grid to avoid z-fighting
    return mesh;
  }

  // Static, high-quality shadow for the directional KEY light. The map is rendered once and frozen
  // (autoUpdate=false); requestShadowBake() re-renders it on demand (tree regenerated, or the sun moved).
  // VSM (renderer.shadowMap.type) gives soft edges; `radius`/`blurSamples` widen the blur. The ortho frustum
  // is sized to bracket the tree + roots tightly — tighter = sharper texel density for a given map size.
  private configureShadow(): void {
    const light = this.directionalLight;
    light.castShadow = true;
    light.shadow.mapSize.set(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE);

    const cam = light.shadow.camera;
    cam.left = -8;
    cam.right = 8;
    cam.top = 8;
    cam.bottom = -8;
    cam.near = 1;
    cam.far = 40;
    cam.updateProjectionMatrix();

    light.shadow.bias = -0.0008; // nudge to kill self-shadow acne on the trunk
    light.shadow.normalBias = 0.02;
    light.shadow.radius = 5; // VSM blur width → softer edges
    light.shadow.blurSamples = 16;
    light.shadow.autoUpdate = false; // baked: only re-render on requestShadowBake()
  }

  // Re-render the (otherwise frozen) shadow map once on the next frame. Called after a mesh rebuild and
  // whenever the sun's direction changes — the only events that alter the tree's cast shadow.
  requestShadowBake(): void {
    this.directionalLight.shadow.needsUpdate = true;
  }

  // Show/hide the visual floor.
  setFloorVisible(visible: boolean): void {
    this.floorPlane.visible = visible;
  }

  // Show/hide the root-collar dirt mounds. Re-bake the frozen shadow: the collar sits over the tree's
  // baked base shadow, so showing/hiding it changes what's revealed and the map must be refreshed to
  // the current scene (otherwise a stale patch lingers until the next unrelated re-bake).
  setCollarVisible(visible: boolean): void {
    this.rootCollar.setVisible(visible);
    this.requestShadowBake();
  }

  // Toggle the root-collar wireframe overlay (shares the surface wireframe debug checkbox).
  setCollarWireframe(wireframe: boolean): void {
    this.rootCollar.setWireframe(wireframe);
  }

  // Update root-collar shaping params live (from the pane). Schedules a cheap collar-only rebuild.
  setCollarOptions(patch: Partial<RootCollarOptions>): void {
    this.rootCollar.setOptions(patch);
    this.collarDirty = true;
  }

  // Show/hide the debug slice outline (where the tree mesh crosses the ground — the same segments the
  // collar's grooves ring). Showing redraws from the segments extracted by the last collar rebuild.
  setCrossingDebugVisible(visible: boolean): void {
    this.rootCrossingDebug.setVisible(visible);
    if (visible) this.rootCrossingDebug.update(this.lastSliceSegments, this.collarGroundHeight);
  }

  // Tune the crossing detection / overlay live (from the pane). `normalAngle` is the shared gate for
  // BOTH the outline and the grooves, so changing it schedules a collar rebuild (which re-extracts and
  // refreshes the overlay); other keys only restyle the overlay.
  setCrossingDebugOptions(
    patch: Partial<RootCrossingDebugOptions> & { normalAngle?: number },
  ): void {
    const { normalAngle, ...overlayPatch } = patch;
    if (normalAngle !== undefined) {
      this.crossingNormalAngle = normalAngle;
      this.collarDirty = true;
      return;
    }
    this.rootCrossingDebug.setOptions(overlayPatch);
    if (this.rootCrossingDebug.visible) {
      this.rootCrossingDebug.update(this.lastSliceSegments, this.collarGroundHeight);
    }
  }

  // The deformed terrain height under the tree: the collar mound over the flat floor. Used by the
  // overlay for the burial veto + seating the outline on the dirt.
  private readonly collarGroundHeight = (x: number, z: number): number =>
    this.rootCollar.heightAt(x, z);

  // Read-only handle to the already-built tree surface geometry (for mesh-based detection). No mesher
  // change — just reads what the mesher already exposes on its public group.
  private treeSurfaceGeometry(): THREE.BufferGeometry | undefined {
    const surface = this.mesher.object.getObjectByName("tree-surface") as THREE.Mesh | undefined;
    return surface?.geometry;
  }

  // Rebuild the collar against the current trunk + root lines (world points valid for this frame).
  // Extracts the root/floor slice segments from the built tree mesh first — they drive the collar's
  // groove bands (always) and the debug outline (when shown), so both see the same data.
  private rebuildCollar(): void {
    this.lastSliceSegments = extractSliceSegments(
      this.treeSurfaceGeometry(),
      this.crossingNormalAngle,
    );
    this.rootCollar.build(
      this.graph.getLineById("trunk"),
      this.graph
        .getLineEntries()
        .filter(({ id }) => /^root-\d+$/.test(id))
        .map(({ line }) => line),
      this.lastSliceSegments,
    );
    if (this.rootCrossingDebug.visible) {
      this.rootCrossingDebug.update(this.lastSliceSegments, this.collarGroundHeight);
    }
  }

  // Repeat the floor material `tiles` times across the plane (scales the uv attribute from the [0,1] base).
  setFloorTiling(tiles: number): void {
    const uv = this.floorPlane.geometry.getAttribute("uv");
    const arr = uv.array as Float32Array;
    for (let i = 0; i < arr.length; i++) arr[i] = this.floorBaseUv[i] * tiles;
    uv.needsUpdate = true;
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
    // Resolve junctions + line drawing only when an authored input actually changed (generation, slider
    // drags, joint/modifier edits). The graph has no per-frame/animated inputs, so on an idle frame the
    // resolution would reproduce identical geometry — skip it and just keep the debug markers screen-sized.
    const inputSignature = this.graph.getInputSignature();
    if (inputSignature !== this.lastInputSignature) {
      this.lastInputSignature = inputSignature;
      this.graph.update(camera, viewportSize);

      // The graph is the source of truth: react to changes in its drawn geometry, not to UI events.
      const signature = this.graph.getGeometrySignature();
      if (signature !== this.lastSignature) {
        this.lastSignature = signature;
        this.scheduleMeshRebuild();
      }
    } else {
      this.graph.refreshCameraScale(camera);
    }

    if (this.meshDirty) {
      const start = performance.now();
      this.mesher.build(this.graph, this.mesherOptions);
      // Re-mound the dirt collar against the freshly resolved roots + trunk base. Reads world
      // polylines valid for this frame (graph.update ran above, or the memoized cache is still good).
      this.rebuildCollar(); // also re-extracts slice segments + refreshes the overlay when shown
      this.collarDirty = false;
      this.meshStats.geometryMs = performance.now() - start;
      const { vertices, triangles } = this.mesher.getStats();
      this.meshStats.vertices = vertices;
      this.meshStats.triangles = triangles;
      this.meshDirty = false;
      // The surface geometry changed → re-bake the (frozen) shadow map once for the new tree.
      this.requestShadowBake();
    } else if (this.collarDirty) {
      // Collar-only change (a shaping slider moved, or the crossing gate): rebuild just the collar
      // (skip the tree mesh), but still refresh the frozen shadow so the map never lags the collar's
      // footprint at the base. rebuildCollar re-extracts segments + refreshes the overlay when shown.
      this.rebuildCollar();
      this.collarDirty = false;
      this.requestShadowBake();
    }

    // Texture time = the offline channel re-bake (render to RTs); 0 in the live backend. Total = geometry
    // + texture. Refreshed each frame (cheap) so the read-only monitors pick up the latest values.
    this.meshStats.textureMs = this.treeMaterial.surface.getLastBakeMs();
    this.meshStats.totalMs = this.meshStats.geometryMs + this.meshStats.textureMs;
  }
}
