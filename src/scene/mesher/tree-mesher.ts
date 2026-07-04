import * as THREE from "three";
import { MeshStandardNodeMaterial } from "three/webgpu";
import type { Graph } from "../graph/graph";
import { buildStemFromGraph } from "./graph-adapter";
import { meshTree, type MesherOptions } from "./welding-mesher";
import { weldMeshToBufferGeometry } from "./to-buffer-geometry";
import { createUvDebugMaterial } from "./uv-debug-material";

// Surface mesher for the whole tree. Reconstructs a welded skeleton from the graph, runs the
// welding mesher, and exposes the result under `object`.
//
// The result is rendered as two independent, composable layers sharing one geometry: a shaded
// solid and a wireframe overlay, toggled separately. The solid is pushed back with polygonOffset so
// the wireframe sits on top of it.
//
// The solid's surface material is supplied by the runtime and pushed in via setSurfaceMaterial.
// The solid mesh can be swapped to a debug visualiser: "normals" (MeshNormalMaterial) or "uv" (TSL).
export type DebugView = "surface" | "normals" | "uv";

export class TreeMesher {
  readonly object = new THREE.Group();

  // Placeholder until MainScene pushes the runtime material. Never rendered in practice.
  private surfaceMaterial: MeshStandardNodeMaterial = new MeshStandardNodeMaterial({
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  });
  private currentView: DebugView = "surface";

  // Debug visualizers swapped onto the solid mesh (see setDebugView).
  private readonly normalDebugMaterial = new THREE.MeshNormalMaterial({
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  });
  private readonly uvDebugMaterial = createUvDebugMaterial();

  private readonly wireMaterial = new THREE.MeshBasicMaterial({
    color: 0x9ad1ff,
    wireframe: true,
  });

  private readonly solidMesh: THREE.Mesh<THREE.BufferGeometry, THREE.Material> = new THREE.Mesh(
    new THREE.BufferGeometry(),
    this.surfaceMaterial,
  );
  private readonly wireMesh = new THREE.Mesh(this.solidMesh.geometry, this.wireMaterial);

  // The surface starts hidden: its geometry is an empty placeholder until build() runs, and rendering a
  // TSL node material against geometry with no position/uv attributes spams "attribute not found" warnings
  // (and, before the needsUpdate fix below, cached a broken pipeline). Shown once real geometry exists.
  private surfaceVisibleWanted = true;

  constructor() {
    this.solidMesh.name = "tree-surface";
    // The tree surface both casts shadows (onto the floor and itself) and receives them (branches shadow the
    // trunk). The wireframe overlay stays shadow-free. Shadows are baked once per generation, not per frame.
    this.solidMesh.castShadow = true;
    this.solidMesh.receiveShadow = true;
    this.wireMesh.name = "tree-wireframe";
    this.solidMesh.visible = false; // no geometry yet — revealed by build()
    this.wireMesh.visible = false; // wireframe overlay off by default
    this.object.add(this.solidMesh, this.wireMesh);
  }

  // Visible only when the user wants the surface AND there's geometry to draw (avoids empty-geometry
  // renders that make the node material warn about missing attributes).
  private updateSurfaceVisibility(): void {
    const hasGeometry = (this.solidMesh.geometry.getAttribute("position")?.count ?? 0) > 0;
    this.solidMesh.visible = this.surfaceVisibleWanted && hasGeometry;
  }

  // Swap in a surface material. needsUpdate forces a node-material recompile against the current geometry
  // (the empty-geometry pipeline gotcha — see build()). The previous material is disposed.
  setSurfaceMaterial(material: MeshStandardNodeMaterial): void {
    if (material === this.surfaceMaterial) return;
    const previous = this.surfaceMaterial;
    this.surfaceMaterial = material;
    material.needsUpdate = true;
    if (this.currentView === "surface") this.solidMesh.material = material;
    previous.dispose();
  }

  build(graph: Graph, opts: MesherOptions): void {
    const stem = buildStemFromGraph(graph);

    this.solidMesh.geometry.dispose();
    const geometry = stem ? weldMeshToBufferGeometry(meshTree(stem, opts)) : new THREE.BufferGeometry();
    this.solidMesh.geometry = geometry;
    this.wireMesh.geometry = geometry;
    // Force a node-material recompile against the new geometry. The surface starts with an empty
    // placeholder geometry (no `position` attribute); a TSL material's first compile caches a broken
    // WGSL pipeline that would otherwise be reused once the real geometry arrives (invisible surface).
    this.surfaceMaterial.needsUpdate = true;
    this.updateSurfaceVisibility(); // reveal now that real geometry exists (or hide if the stem is empty)
  }

  // Vertex/triangle counts of the current surface geometry, for the stats readout.
  getStats(): { vertices: number; triangles: number } {
    const geometry = this.solidMesh.geometry;
    const position = geometry.getAttribute("position");
    const vertices = position ? position.count : 0;
    const index = geometry.getIndex();
    const triangles = index ? index.count / 3 : Math.floor(vertices / 3);
    return { vertices, triangles };
  }

  // Swap the solid mesh's material to a debug visualizer (or back to the shaded PBR surface).
  setDebugView(view: DebugView): void {
    this.currentView = view;
    this.solidMesh.material =
      view === "normals"
        ? this.normalDebugMaterial
        : view === "uv"
          ? this.uvDebugMaterial
          : this.surfaceMaterial;
  }

  setSurfaceVisible(visible: boolean): void {
    this.surfaceVisibleWanted = visible;
    this.updateSurfaceVisibility();
  }

  setSurfaceWireframe(wireframe: boolean): void {
    this.wireMesh.visible = wireframe;
  }

  dispose(): void {
    this.solidMesh.geometry.dispose();
    this.surfaceMaterial.dispose();
    this.normalDebugMaterial.dispose();
    this.uvDebugMaterial.dispose();
    this.wireMaterial.dispose();
  }
}
