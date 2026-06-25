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

// --- Triplanar (world-space) sampling, injected into the PBR surface material ----------------
// The tree's tubular UVs distort at junctions (separate cylinder charts → seams, shear, grain
// rotation). Triplanar bypasses UVs entirely: it projects each baked channel from the three world
// axes and blends by the world normal, so there are no charts and the scale is world-consistent.
// We inject it into MeshStandardMaterial via onBeforeCompile so all PBR lighting/shadows survive —
// only the four map *samples* change. `uTriEnabled` is a uniform (not a #define), so the A/B toggle
// flips live without a recompile, and the UV path (vMapUv etc.) stays intact for comparison.

const TRIPLANAR_VARYINGS_VERT = /* glsl */ `
  varying vec3 vWorldPos;
  varying vec3 vWorldNormal;
`;

// Fragment helpers. triSample takes the sampler as a parameter, so it references no global map
// uniform and is safe to declare ahead of three's <*_pars_fragment> sampler declarations.
const TRIPLANAR_PARS_FRAG = /* glsl */ `
  uniform float uWorldPerTile;
  uniform float uTriSharpness;
  uniform float uTriEnabled;
  varying vec3 vWorldPos;
  varying vec3 vWorldNormal;

  vec3 triBlendWeights(vec3 wn) {
    vec3 b = pow(abs(wn), vec3(uTriSharpness));
    return b / max(b.x + b.y + b.z, 1e-4);
  }
  vec4 triSample(sampler2D tex, vec3 wp, vec3 b) {
    float s = 1.0 / uWorldPerTile;
    return texture2D(tex, wp.zy * s) * b.x
         + texture2D(tex, wp.xz * s) * b.y
         + texture2D(tex, wp.xy * s) * b.z;
  }
`;

// Full replacement for <normal_fragment_maps>: tangent-space triplanar via the whiteout/swizzle
// blend (Golus). Needs no per-vertex tangents — it folds the geometric world normal into each
// plane's sampled tangent normal, then swizzles each back to world space and blends, finally
// rotating the result into view space (where the lighting code expects `normal`). The UV branch is
// three's original tangent-space path, kept verbatim for the A/B toggle.
const TRIPLANAR_NORMAL_MAPS = /* glsl */ `
#ifdef USE_NORMALMAP_OBJECTSPACE
  normal = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;
  #ifdef FLIP_SIDED
    normal = - normal;
  #endif
  #ifdef DOUBLE_SIDED
    normal = normal * faceDirection;
  #endif
  normal = normalize( normalMatrix * normal );
#elif defined( USE_NORMALMAP_TANGENTSPACE )
  if ( uTriEnabled > 0.5 ) {
    vec3 wn = normalize( vWorldNormal ) * faceDirection;
    vec3 b = triBlendWeights( wn );
    float s = 1.0 / uWorldPerTile;
    vec3 nx = texture2D( normalMap, vWorldPos.zy * s ).xyz * 2.0 - 1.0;
    vec3 ny = texture2D( normalMap, vWorldPos.xz * s ).xyz * 2.0 - 1.0;
    vec3 nz = texture2D( normalMap, vWorldPos.xy * s ).xyz * 2.0 - 1.0;
    nx.xy *= normalScale; ny.xy *= normalScale; nz.xy *= normalScale;
    nx = vec3( nx.xy + wn.zy, nx.z * wn.x );
    ny = vec3( ny.xy + wn.xz, ny.z * wn.y );
    nz = vec3( nz.xy + wn.xy, nz.z * wn.z );
    vec3 worldN = normalize( nx.zyx * b.x + ny.xzy * b.y + nz.xyz * b.z );
    normal = normalize( ( viewMatrix * vec4( worldN, 0.0 ) ).xyz );
  } else {
    vec3 mapN = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;
    mapN.xy *= normalScale;
    normal = normalize( tbn * mapN );
  }
#elif defined( USE_BUMPMAP )
  normal = perturbNormalArb( - vViewPosition, normal, dHdxy_fwd(), faceDirection );
#endif
`;

function triplanarColorSample(sampler: string, uvVarying: string): string {
  return (
    `( uTriEnabled > 0.5 ? triSample( ${sampler}, vWorldPos, triBlendWeights( normalize( vWorldNormal ) ) )` +
    ` : texture2D( ${sampler}, ${uvVarying} ) )`
  );
}

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

  // Triplanar uniforms, shared by reference into the compiled program (see installTriplanar). They
  // outlive recompiles, so the Mapping controls mutate `.value` and the change takes effect next
  // frame with no rebuild. Default scale matches the old UV_WORLD_PER_TILE so bark size is unchanged.
  private readonly triUniforms = {
    uWorldPerTile: { value: 1.2 },
    uTriSharpness: { value: 8.0 },
    uTriEnabled: { value: 1.0 },
  };

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
    this.installTriplanar();
  }

  // Inject world-space triplanar sampling into the PBR surface shader. Keeps all of three's lighting
  // and just swaps how the four baked channels are sampled (UV → triplanar), behind the uTriEnabled
  // uniform so the UV path stays available for A/B comparison.
  private installTriplanar(): void {
    this.solidMaterial.onBeforeCompile = (shader) => {
      shader.uniforms.uWorldPerTile = this.triUniforms.uWorldPerTile;
      shader.uniforms.uTriSharpness = this.triUniforms.uTriSharpness;
      shader.uniforms.uTriEnabled = this.triUniforms.uTriEnabled;

      // Vertex: carry world position + geometric world normal to the fragment stage.
      shader.vertexShader = (TRIPLANAR_VARYINGS_VERT + shader.vertexShader)
        .replace(
          "#include <begin_vertex>",
          "#include <begin_vertex>\n  vWorldPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;",
        )
        .replace(
          "#include <beginnormal_vertex>",
          "#include <beginnormal_vertex>\n  vWorldNormal = mat3( modelMatrix ) * objectNormal;",
        );

      // Fragment: helpers up front, then redirect each channel's sample through triplanar. Basecolor
      // is an sRGB texture, so the hardware decodes it on sample — triSample reuses the same sampler,
      // so its three reads are decoded identically and blended in linear space (correct).
      shader.fragmentShader = (TRIPLANAR_PARS_FRAG + shader.fragmentShader)
        .replace("texture2D( map, vMapUv )", triplanarColorSample("map", "vMapUv"))
        .replace(
          "texture2D( roughnessMap, vRoughnessMapUv )",
          triplanarColorSample("roughnessMap", "vRoughnessMapUv"),
        )
        .replace("texture2D( aoMap, vAoMapUv )", triplanarColorSample("aoMap", "vAoMapUv"))
        .replace("#include <normal_fragment_maps>", TRIPLANAR_NORMAL_MAPS);
    };
    this.solidMaterial.needsUpdate = true;
  }

  // Mapping controls (Texture tab). Each mutates a shared uniform — no recompile, takes effect next
  // frame. `worldPerTile` is the single master bark-scale knob (replaces UV_WORLD_PER_TILE).
  setTriplanarEnabled(enabled: boolean): void {
    this.triUniforms.uTriEnabled.value = enabled ? 1 : 0;
  }
  setTriplanarScale(worldPerTile: number): void {
    this.triUniforms.uWorldPerTile.value = worldPerTile;
  }
  setTriplanarSharpness(sharpness: number): void {
    this.triUniforms.uTriSharpness.value = sharpness;
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
