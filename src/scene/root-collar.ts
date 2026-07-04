import * as THREE from "three";
import { attribute } from "three/tsl";
import type { MeshStandardNodeMaterial } from "three/webgpu";
import type { GraphLine } from "./graph/line";
import {
  makeParentSurface,
  nearestSurfaceSample,
  type ParentSurface,
} from "./graph/collar";
import { hashNoise, smoothstep } from "./graph/modifiers/utils";

// The "root collar" is the disturbed soil where the roots meet the floor: a low, cheap radial disc
// centred on the trunk base whose vertices are pushed UP against the root + trunk tubes (the union
// signed-distance field from collar.ts), so dirt mounds against and between the root flares and
// tapers back to floor level. It is a separate mesh (blending into the floor texture alone can't add
// relief) carrying its own dirt material, alpha-feathered at the rim so it dissolves into the floor.
//
// Rebuilt in the same debounced pass as the tree surface (MainScene), so it re-mounds whenever a root
// parameter changes. World space == graph space here (no group transforms), and the trunk base sits at
// the world origin with the ground at y = 0 — so a ground sample is simply the disc vertex (x, 0, z).

export interface RootCollarOptions {
  ringCount?: number; // concentric rings (radial resolution)
  sectorCount?: number; // vertices per ring (angular resolution)
  radialExponent?: number; // r_k = R*(k/K)^exp — clusters rings near the centre where roots converge
  reachMargin?: number; // extra radius past the roots' horizontal reach
  minRadius?: number; // floor on the disc radius (roots absent / very short)
  moundReach?: number; // horizontal falloff distance past the tube surface
  moundAmplitude?: number; // peak dirt height above the floor
  capFraction?: number; // mound height cap = capFraction * local tube radius (roots stay exposed)
  aboveBand?: number; // ground band above y = 0 that contributes soil
  belowBand?: number; // ground band below y = 0 that contributes soil
  noiseAmplitude?: number; // value-noise height detail
  noiseFrequency?: number; // noise cells per world unit
  rimJitter?: number; // world-space jitter of the alpha-feather rim (breaks the clean circle)
  seed?: number;
}

const DEFAULTS: Required<RootCollarOptions> = {
  ringCount: 22,
  sectorCount: 64,
  radialExponent: 1.8,
  reachMargin: 0.35,
  minRadius: 0.8,
  moundReach: 0.25,
  moundAmplitude: 0.14,
  capFraction: 0.6,
  aboveBand: 0.15,
  belowBand: 0.6,
  noiseAmplitude: 0.05,
  noiseFrequency: 1.6,
  rimJitter: 0.12,
  seed: 1337,
};

// A near-ground tube (root or trunk base) the mound field is built against.
type GroundSurface = ParentSurface;

const _p = new THREE.Vector3();

export class RootCollar {
  readonly mesh: THREE.Mesh<THREE.BufferGeometry, THREE.Material>;
  private readonly opts: Required<RootCollarOptions>;
  private material: THREE.Material;
  private pipelinePrimed = false;
  // Wireframe overlay (shares the solid geometry), toggled with the tree's wireframe debug checkbox.
  private readonly wireMesh: THREE.Mesh<THREE.BufferGeometry, THREE.Material>;

  constructor(material: THREE.Material, options: RootCollarOptions = {}) {
    this.opts = { ...DEFAULTS, ...options };
    this.material = material;
    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), material);
    this.mesh.name = "root-collar";
    this.mesh.visible = false; // no geometry until build() runs
    this.mesh.frustumCulled = true;

    // Wire overlay parented to the solid so it inherits its transform + visibility and enters the
    // scene with it. The solid's material carries polygonOffset (set in setMaterial) so the wire
    // reads on top without z-fighting — same scheme as the tree surface.
    this.wireMesh = new THREE.Mesh(
      this.mesh.geometry,
      new THREE.MeshBasicMaterial({ color: 0x9ad1ff, wireframe: true }),
    );
    this.wireMesh.name = "root-collar-wire";
    this.wireMesh.visible = false;
    this.mesh.add(this.wireMesh);

    this.setMaterial(material);
  }

  // Swap in the collar's surface material and (re)apply the alpha feather. Called from the material
  // runtime's onRebuilt, which hands back a freshly wired MeshStandardNodeMaterial — the offline
  // backend rebuilds its node graph on refresh, so the opacity feather must be re-attached each time.
  setMaterial(material: THREE.Material): void {
    this.material = material;
    const nodeMat = material as MeshStandardNodeMaterial;
    // Feather the collar into the floor by the per-vertex `mask` attribute. alphaHash keeps the mesh
    // in the OPAQUE pass (correct depth sort against floor/trunk + normal shadow interaction) while
    // still dissolving the rim; the dither reads as dirt grain over a dirt surface.
    nodeMat.alphaHash = true;
    nodeMat.opacityNode = attribute("mask", "float");
    // Push the shaded surface slightly back in depth so the wireframe overlay reads on top of it
    // (mirrors the tree surface material).
    nodeMat.polygonOffset = true;
    nodeMat.polygonOffsetFactor = 1;
    nodeMat.polygonOffsetUnits = 1;
    nodeMat.needsUpdate = true;
    this.mesh.material = material;
  }

  setVisible(visible: boolean): void {
    this.mesh.visible = visible && this.hasGeometry();
  }

  // Toggle the wireframe overlay (driven by the shared debug checkbox alongside the tree surface).
  setWireframe(visible: boolean): void {
    this.wireMesh.visible = visible;
  }

  // Rebuild the collar disc against the current root + trunk geometry. Reads world polylines from the
  // graph lines (valid for the current frame — never call beginWorldFrame here).
  build(trunk: GraphLine | undefined, rootLines: GraphLine[]): void {
    const surfaces = this.collectGroundSurfaces(trunk, rootLines);
    const reach = this.computeReach(rootLines);

    const previous = this.mesh.geometry;
    if (surfaces.length === 0 || reach <= 1e-4) {
      const empty = new THREE.BufferGeometry();
      this.mesh.geometry = empty;
      this.wireMesh.geometry = empty;
      this.mesh.visible = false;
      previous.dispose();
      return;
    }

    const geometry = this.buildDisc(surfaces, reach);
    this.mesh.geometry = geometry;
    this.wireMesh.geometry = geometry; // wire overlay shares the solid geometry
    previous.dispose();
    this.mesh.visible = true;

    // First real geometry: force a node-material recompile against it. A TSL material's first compile
    // caches a broken WGSL pipeline if it ran against the empty placeholder geometry (missing
    // attributes) — the same gotcha the tree mesher guards. Once primed, later swaps are free.
    if (!this.pipelinePrimed) {
      this.material.needsUpdate = true;
      this.pipelinePrimed = true;
    }
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.wireMesh.material.dispose();
  }

  private hasGeometry(): boolean {
    return (this.mesh.geometry.getAttribute("position")?.count ?? 0) > 0;
  }

  // Build one ParentSurface per near-ground tube: each root plus the trunk base. Trimming the world
  // polyline to the ground band [-belowBand, +aboveBand] is the gate — signedDistance's end-disc
  // clipping then excludes the deep/high parts automatically, so a root plunged well below the floor
  // stops contributing soil at the surface. radiusAt is remapped onto the trimmed sub-range.
  private collectGroundSurfaces(
    trunk: GraphLine | undefined,
    rootLines: GraphLine[],
  ): GroundSurface[] {
    const surfaces: GroundSurface[] = [];
    for (const line of rootLines) this.pushGroundSurface(surfaces, line);
    if (trunk) this.pushGroundSurface(surfaces, trunk);
    return surfaces;
  }

  private pushGroundSurface(out: GroundSurface[], line: GraphLine): void {
    const tube = line.tube;
    if (!tube) return;
    const points = line.virtual.getDrawPoints();
    const n = points.length;
    if (n < 2) return;

    const { aboveBand, belowBand } = this.opts;
    const inBand = (y: number): boolean => y <= aboveBand && y >= -belowBand;

    let firstIn = -1;
    let lastIn = -1;
    for (let i = 0; i < n; i += 1) {
      if (inBand(points[i].y)) {
        if (firstIn === -1) firstIn = i;
        lastIn = i;
      }
    }
    if (firstIn === -1) return; // this line never runs through the ground band

    // Extend one point past each end so the trimmed tube's flat end caps sit just outside the band,
    // not exactly on the mounding boundary.
    const iA = Math.max(0, firstIn - 1);
    const iB = Math.min(n - 1, lastIn + 1);
    if (iB - iA < 1) return;

    const trimmed = points.slice(iA, iB + 1).map((pt) => pt.clone());
    const tA = iA / (n - 1);
    const tB = iB / (n - 1);
    // radiusAt receives an arc fraction along the TRIMMED tube; map it back onto the full line's taper.
    const radiusAt = (tLocal: number): number =>
      tube.radiusAt(THREE.MathUtils.lerp(tA, tB, THREE.MathUtils.clamp(tLocal, 0, 1)));
    out.push(makeParentSurface(trimmed, radiusAt));
  }

  // Disc radius: the roots' horizontal reach plus a margin, floored at minRadius.
  private computeReach(rootLines: GraphLine[]): number {
    let maxR = 0;
    for (const line of rootLines) {
      for (const pt of line.virtual.getDrawPoints()) {
        const r = Math.hypot(pt.x, pt.z);
        if (r > maxR) maxR = r;
      }
    }
    return Math.max(this.opts.minRadius, maxR + this.opts.reachMargin);
  }

  // Radial disc: a centre vertex + concentric rings with non-linear spacing (dense near the centre),
  // fanned/bridged into triangles. Per-vertex height, alpha mask and AO come from the mound field.
  private buildDisc(surfaces: GroundSurface[], reach: number): THREE.BufferGeometry {
    const { ringCount, sectorCount, radialExponent } = this.opts;
    const vertexCount = 1 + ringCount * sectorCount;

    const positions = new Float32Array(vertexCount * 3);
    const uvs = new Float32Array(vertexCount * 2);
    const masks = new Float32Array(vertexCount);
    const aos = new Float32Array(vertexCount);

    const writeVertex = (index: number, x: number, z: number): void => {
      const s = this.sampleField(surfaces, reach, x, z);
      positions[index * 3 + 0] = x;
      positions[index * 3 + 1] = s.height;
      positions[index * 3 + 2] = z;
      uvs[index * 2 + 0] = x / (2 * reach) + 0.5;
      uvs[index * 2 + 1] = z / (2 * reach) + 0.5;
      masks[index] = s.mask;
      aos[index] = s.ao;
    };

    // Centre vertex.
    writeVertex(0, 0, 0);

    // Rings.
    for (let k = 1; k <= ringCount; k += 1) {
      const radius = reach * Math.pow(k / ringCount, radialExponent);
      const base = 1 + (k - 1) * sectorCount;
      for (let j = 0; j < sectorCount; j += 1) {
        const angle = (j / sectorCount) * Math.PI * 2;
        writeVertex(base + j, Math.cos(angle) * radius, Math.sin(angle) * radius);
      }
    }

    // Indices: centre fan to ring 1, then quad strips between consecutive rings. Wound so the disc
    // faces +Y (the ring runs clockwise in XZ when viewed from above, so the up-facing winding is
    // reversed: centre, outer-angle, inner-angle).
    const indices: number[] = [];
    for (let j = 0; j < sectorCount; j += 1) {
      const a = 1 + j;
      const b = 1 + ((j + 1) % sectorCount);
      indices.push(0, b, a);
    }
    for (let k = 1; k < ringCount; k += 1) {
      const inner = 1 + (k - 1) * sectorCount;
      const outer = 1 + k * sectorCount;
      for (let j = 0; j < sectorCount; j += 1) {
        const jn = (j + 1) % sectorCount;
        const i0 = inner + j;
        const i1 = inner + jn;
        const o0 = outer + j;
        const o1 = outer + jn;
        indices.push(i0, o1, o0);
        indices.push(i0, i1, o1);
      }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
    geometry.setAttribute("mask", new THREE.BufferAttribute(masks, 1));
    // The offline surface material multiplies its AO by this attribute (see createFloorPlane); it is
    // mandatory — omitting it shades the collar to black.
    geometry.setAttribute("vertexAo", new THREE.BufferAttribute(aos, 1));
    geometry.setIndex(indices);
    geometry.computeVertexNormals(); // smooth mound normals (no tangents needed on the floor path)
    geometry.computeBoundingSphere();
    return geometry;
  }

  // The mound field at ground point (x, 0, z): its height above the floor, its alpha mask (rim
  // feather), and its baked AO (crevice + contact darkening).
  private sampleField(
    surfaces: GroundSurface[],
    reach: number,
    x: number,
    z: number,
  ): { height: number; mask: number; ao: number } {
    const o = this.opts;
    _p.set(x, 0, z);

    // Union of the near-ground tubes = the minimum signed distance; keep the nearest tube's radius.
    let d = Infinity;
    let nearestRadius = 0;
    for (const surface of surfaces) {
      const sample = nearestSurfaceSample(surface, _p);
      if (sample.signed < d) {
        d = sample.signed;
        nearestRadius = sample.radius;
      }
    }

    // presence: 1 at/inside a tube, fading to 0 by `moundReach` past its surface.
    const presence = smoothstep01(clamp01(1 - Math.max(d, 0) / o.moundReach));

    const radius = Math.hypot(x, z);
    const radialFalloff = 1 - smoothstepRange(reach * 0.55, reach, radius); // fade mounds at the rim
    const innerSolid = 1 - smoothstepRange(reach * 0.25, reach * 0.5, radius); // solid pad at the base

    const n = value2D(x * o.noiseFrequency, z * o.noiseFrequency, o.seed); // [0,1]

    // Height: mound against the tubes, capped so the tube still emerges; a small raised pad at the
    // base; noise grain only where there is dirt; never below the floor; feathered at the rim.
    const cap = o.capFraction * nearestRadius;
    const hMound = Math.min(o.moundAmplitude * presence, cap);
    const hBase = innerSolid * 0.02;
    let height = Math.max(hBase, hMound) + presence * o.noiseAmplitude * (n - 0.5) * 2;
    height = Math.max(0, height) * radialFalloff;

    // Alpha mask: opaque across the interior, feathering to 0 by the rim with a noise-jittered
    // boundary so the collar dissolves into the floor along a broken (non-circular) edge.
    const rimStart = reach * 0.65 + (n - 0.5) * 2 * o.rimJitter;
    const mask = clamp01(1 - smoothstepRange(rimStart, reach, radius));

    // AO: a dark crease where the dirt meets a root (|d| small), plus gentle darkening of the low
    // inter-mound field so the raised mounds read lighter. → 1 at the rim, matching the floor.
    const contact = 1 - smoothstepRange(0, 0.08, Math.abs(d));
    const ao = clamp(1 - radialFalloff * (0.5 * contact + 0.25 * (1 - presence)), 0.35, 1);

    return { height, mask, ao };
  }
}

// --- small math helpers (kept local so the field math is self-contained) ---

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function clamp01(v: number): number {
  return clamp(v, 0, 1);
}

function smoothstep01(v: number): number {
  const t = clamp01(v);
  return t * t * (3 - 2 * t);
}

function smoothstepRange(edge0: number, edge1: number, x: number): number {
  const span = edge1 - edge0;
  const t = clamp01(Math.abs(span) < 1e-9 ? (x < edge0 ? 0 : 1) : (x - edge0) / span);
  return t * t * (3 - 2 * t);
}

// Bilinear value noise over the integer lattice, from the shared hash. Reuses `smoothstep` (utils) for
// the per-axis interpolation. Deterministic (no new dependency), so the collar is stable across builds.
function value2D(x: number, z: number, seed: number): number {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fz = z - iz;
  const h00 = hash2(seed, ix, iz);
  const h10 = hash2(seed, ix + 1, iz);
  const h01 = hash2(seed, ix, iz + 1);
  const h11 = hash2(seed, ix + 1, iz + 1);
  const sx = smoothstep(fx);
  const sz = smoothstep(fz);
  return THREE.MathUtils.lerp(
    THREE.MathUtils.lerp(h00, h10, sx),
    THREE.MathUtils.lerp(h01, h11, sx),
    sz,
  );
}

function hash2(seed: number, ix: number, iz: number): number {
  return hashNoise(seed, ix + Math.imul(iz, 73856093));
}
