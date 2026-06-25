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
//
// The solid mesh's material can be swapped to a debug visualizer: "normals" (MeshNormalMaterial
// carrying the baked normalMap → shows the normal-mapped relief in view-space colour) or "uv" (a
// UV checker → reveals the mapping, seam and tiling).
export type DebugView = "surface" | "normals" | "uv";

const UV_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const UV_FRAG = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  void main() {
    vec3 col = vec3(vUv, 0.0);                                   // R = u, G = v gradient
    float checker = mod(floor(vUv.x * 16.0) + floor(vUv.y * 16.0), 2.0);
    col = mix(col * 0.45, col, checker);                         // alternate squares
    gl_FragColor = vec4(col, 1.0);
  }
`;

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

  // Debug visualizers swapped onto the solid mesh (see setDebugView).
  private readonly normalDebugMaterial = new THREE.MeshNormalMaterial({
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  });
  private readonly uvDebugMaterial = new THREE.ShaderMaterial({
    vertexShader: UV_VERT,
    fragmentShader: UV_FRAG,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  });

  private readonly wireMaterial = new THREE.MeshBasicMaterial({
    color: 0x9ad1ff,
    wireframe: true,
  });

  private readonly solidMesh: THREE.Mesh<THREE.BufferGeometry, THREE.Material> = new THREE.Mesh(
    new THREE.BufferGeometry(),
    this.solidMaterial,
  );
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

  // Bind the baked PBR channel textures onto the solid surface. The material is persistent — only
  // the geometry is replaced in `build()` — so maps set here survive every tree/mesh rebuild.
  // aoMap uses the geometry's `uv1` set (a copy of `uv`, see to-buffer-geometry).
  setMaterialMaps(maps: {
    map?: THREE.Texture | null;
    normalMap?: THREE.Texture | null;
    aoMap?: THREE.Texture | null;
    roughnessMap?: THREE.Texture | null;
  }): void {
    if ("map" in maps) this.solidMaterial.map = maps.map ?? null;
    if ("normalMap" in maps) {
      this.solidMaterial.normalMap = maps.normalMap ?? null;
      // Mirror onto the debug visualizer so "Normals" view shows the actual normal-mapped relief.
      this.normalDebugMaterial.normalMap = maps.normalMap ?? null;
      this.normalDebugMaterial.needsUpdate = true;
    }
    if ("aoMap" in maps) this.solidMaterial.aoMap = maps.aoMap ?? null;
    if ("roughnessMap" in maps) {
      this.solidMaterial.roughnessMap = maps.roughnessMap ?? null;
      // The map drives roughness; keep the scalar at 1 so it isn't double-attenuated.
      this.solidMaterial.roughness = 1;
    }
    this.solidMaterial.needsUpdate = true;
  }

  // Swap the solid mesh's material to a debug visualizer (or back to the shaded PBR surface).
  setDebugView(view: DebugView): void {
    this.solidMesh.material =
      view === "normals"
        ? this.normalDebugMaterial
        : view === "uv"
          ? this.uvDebugMaterial
          : this.solidMaterial;
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
    this.normalDebugMaterial.dispose();
    this.uvDebugMaterial.dispose();
    this.wireMaterial.dispose();
  }
}
