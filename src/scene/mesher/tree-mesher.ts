import * as THREE from "three";
import type { Graph } from "../graph/graph";
import { buildStemFromGraph } from "./graph-adapter";
import { meshTree, type MesherOptions } from "./welding-mesher";
import { weldMeshToBufferGeometry } from "./to-buffer-geometry";

// Surface mesher for the whole tree. Reconstructs a welded skeleton from the graph, runs the
// welding mesher, and exposes the result under `object`.
//
// The result is rendered as two independent, composable layers sharing one geometry: a shaded
// solid and a wireframe overlay. Their visibility is toggled separately, so "solid", "wire", or
// "solid + wire" all work. The solid is pushed back with polygonOffset so the wireframe sits on
// top of it instead of z-fighting or being masked.
export class TreeMesher {
  readonly object = new THREE.Group();

  private readonly solidMaterial = new THREE.MeshStandardMaterial({
    color: 0x8a6a4a,
    roughness: 0.85,
    metalness: 0.0,
    flatShading: false,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  });

  private readonly wireMaterial = new THREE.MeshBasicMaterial({
    color: 0x9ad1ff,
    wireframe: true,
  });

  private readonly solidMesh = new THREE.Mesh(new THREE.BufferGeometry(), this.solidMaterial);
  private readonly wireMesh = new THREE.Mesh(this.solidMesh.geometry, this.wireMaterial);

  constructor() {
    this.solidMesh.name = "tree-surface";
    this.wireMesh.name = "tree-wireframe";
    this.wireMesh.visible = false; // wireframe overlay off by default
    this.object.add(this.solidMesh, this.wireMesh);
  }

  build(graph: Graph, opts: MesherOptions): void {
    const stem = buildStemFromGraph(graph);

    this.solidMesh.geometry.dispose();
    const geometry = stem ? weldMeshToBufferGeometry(meshTree(stem, opts)) : new THREE.BufferGeometry();
    this.solidMesh.geometry = geometry;
    this.wireMesh.geometry = geometry;
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

  // Attach (or clear) the color map for the solid surface. The material is persistent — only the
  // geometry is replaced in `build()` — so a map set here survives every tree/mesh rebuild.
  setTextureMap(texture: THREE.Texture | null): void {
    this.solidMaterial.map = texture;
    this.solidMaterial.needsUpdate = true;
  }

  setSurfaceVisible(visible: boolean): void {
    this.solidMesh.visible = visible;
  }

  setSurfaceWireframe(wireframe: boolean): void {
    this.wireMesh.visible = wireframe;
  }

  dispose(): void {
    this.solidMesh.geometry.dispose();
    this.solidMaterial.dispose();
    this.wireMaterial.dispose();
  }
}
