import * as THREE from "three";
import { attribute, mix, normalWorld, positionWorld, texture, vec2 } from "three/tsl";
import type { MeshStandardNodeMaterial } from "three/webgpu";
import type { GraphLine } from "./graph/line";
import {
  makeParentSurface,
  nearestSurfaceSample,
  type ParentSurface,
} from "./graph/collar";
import { hashNoise, smoothstep } from "./graph/modifiers/utils";
import {
  BURIED_EPS,
  EMPTY_SLICE_FIELD,
  buildSliceField,
  type SliceField,
} from "./root-crossings";

// The "root collar" is the disturbed soil where the roots meet the floor: a low, cheap radial disc
// centred on the trunk base. Its height is a smooth DOME (peak at the centre, sloping to the floor at
// the rim) plus a FILLET where dirt banks up against each root/trunk (from the root-tube SDF in
// collar.ts, capped so the root still emerges) plus disturbance noise, plus INDEPENDENT groove bands
// ringing the root/floor crossing slices (root-crossings.ts). The collar is fully OPAQUE: the outer
// edge blends into the floor geometrically (height fades to 0 across floorBlend) and by texture (same
// world-space triplanar projection as the floor) — no alpha; the inner edges bank up against the roots
// (rootRaise) and soften the collar↔root seam via a contact band (rootEdgeBlend) that darkens (AO,
// rootEdgeAO) and bleeds the bark colour in (rootEdgeMix). It is a separate mesh (blending into the
// floor texture alone can't add relief) carrying its own dirt material.
//
// Rebuilt on demand (MainScene): in the tree's debounced pass, and on a cheap collar-only pass when a
// collar param changes. World space == graph space here (no group transforms), and the trunk base sits
// at the world origin with the ground at y = 0 — so a ground sample is simply the disc vertex (x, 0, z).

export interface RootCollarOptions {
  // --- dome shape ---
  centerHeight?: number; // peak dirt height at the centre (trunk base)
  slope?: number; // dome falloff exponent: 1≈cone, >1 flat-top/steep-rim, <1 pointy centre
  // --- disturbance (surface noise) ---
  disturbance?: number; // value-noise height amplitude
  disturbanceScale?: number; // noise cells per world unit (feature size)
  // --- edges ---
  floorBlend?: number; // outer feather width: how far the rim fades into the floor
  rootRaise?: number; // root-fillet height: how much dirt banks up against a root/trunk (geometry)
  capFraction?: number; // fillet height cap = capFraction * local tube radius (roots stay exposed)
  // --- collar↔root seam texture blend ---
  rootEdgeBlend?: number; // band width around a root/trunk surface over which the seam softens
  rootEdgeAO?: number; // 0–1: contact-shadow darkening of the collar toward a root
  rootEdgeMix?: number; // 0–1: how strongly the tree (bark) texture bleeds into the collar at the seam
  // --- grooves (concentric bands ringing the root/floor crossing slices) ---
  // INDEPENDENT of the collar's own shaping: driven only by the slice segments (root-crossings.ts) and
  // these params — the dome/slope/floorBlend/disturbance never scale or fade them.
  grooveDepth?: number; // ripple amplitude (symmetric ridges + troughs radiating from a crossing)
  grooveSpacing?: number; // world distance between consecutive bands
  grooveReach?: number; // how far out from a crossing the bands fade to nothing
  grooveSharp?: number; // trough carve bias: 1 = symmetric, >1 cuts the troughs deeper than the ridges
  grooveJitter?: number; // 0–1: band phase irregularity (own seed, independent of `disturbance`)
  grooveAO?: number; // 0–1: crevice darkening in the band troughs
  // --- extent ---
  reachMargin?: number; // extra radius past the roots' horizontal reach
  minRadius?: number; // floor on the disc radius (roots absent / very short)
  // --- ground-band trim for the root SDF ---
  aboveBand?: number; // ground band above y = 0 that contributes soil
  belowBand?: number; // ground band below y = 0 that contributes soil
  // --- tessellation ---
  ringCount?: number; // concentric rings (radial resolution)
  sectorCount?: number; // vertices per ring (angular resolution)
  radialExponent?: number; // inner-ring bias r_k = innerEnd*(k/K)^exp (near-linear for a smooth dome)
  seed?: number;
}

const DEFAULTS: Required<RootCollarOptions> = {
  centerHeight: 0.12,
  slope: 1.5,
  disturbance: 0.04,
  disturbanceScale: 1.6,
  floorBlend: 0.5,
  rootRaise: 0.12,
  capFraction: 0.6,
  rootEdgeBlend: 0.12,
  rootEdgeAO: 0.5,
  rootEdgeMix: 0.5,
  grooveDepth: 0.05,
  grooveSpacing: 0.2,
  grooveReach: 0.45,
  grooveSharp: 1.0,
  grooveJitter: 0.3,
  grooveAO: 0.5,
  reachMargin: 0.35,
  minRadius: 0.8,
  aboveBand: 0.15,
  belowBand: 0.6,
  // Groove bands must resolve anywhere on the disc (crossings sit out near the rim), so the radial
  // spacing is uniform and both resolutions are higher than the old dome-only disc needed.
  ringCount: 64,
  sectorCount: 128,
  radialExponent: 1.0,
  seed: 1337,
};

// A near-ground tube (root or trunk base) the mound field is built against.
type GroundSurface = ParentSurface;

// Source for bleeding the tree (bark) texture into the collar at the root seam: the tree surface's
// baked base-colour texture + its world-space triplanar scale/sharpness uniforms (so the bark reads at
// the tree's scale). `scale`/`sharpness` are TSL UniformNodes.
export interface TreeColorSource {
  getTexture: () => THREE.Texture | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  scale: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sharpness: any;
}

// Reach of the geometric root fillet (dirt banking up against a root), as a fixed distance past the
// tube surface — the old `rootBlend` knob, folded to a constant since its per-look value added little.
const FILLET_REACH = 0.3;
// The groove bands fade out over this fixed band at the disc rim so the collar's outer edge ALWAYS sits
// exactly on the floor (crossings can lie close to the rim; without this their ridges lift the boundary
// into floating faces). A constant on purpose — grooves stay independent of the collar's blend params.
const GROOVE_RIM_FADE = 0.25;
// Darkest the seam contact-shadow AO can go (floor is 1.0).
const AO_MIN = 0.3;

const _p = new THREE.Vector3();

export class RootCollar {
  readonly mesh: THREE.Mesh<THREE.BufferGeometry, THREE.Material>;
  private readonly opts: Required<RootCollarOptions>;
  private material: THREE.Material;
  private pipelinePrimed = false;
  // Wireframe overlay (shares the solid geometry), toggled with the tree's wireframe debug checkbox.
  private readonly wireMesh: THREE.Mesh<THREE.BufferGeometry, THREE.Material>;
  // Tree base-colour source + the collar material's own (runtime-built) base colour, for the seam mix.
  private treeColor: TreeColorSource | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private baseColorNode: any = null;
  // User-requested visibility (the Floor-tab checkbox). Kept separate so a rebuild never re-shows a
  // collar the user hid — build() only reveals when both this is true AND there's geometry.
  private visibleWanted = true;
  // Last build's disc reach, kept so heightAt() can sample the mound dome between rebuilds.
  private lastReach = 0;

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

  // Swap in the collar's surface material. Called from the material runtime's onRebuilt, which hands
  // back a freshly wired MeshStandardNodeMaterial — the offline backend rebuilds its node graph on
  // refresh, so material tweaks must be re-applied each time. The collar is fully OPAQUE: the rim
  // blends into the floor geometrically (height fades to 0 via floorCover) and by texture (same
  // world-space triplanar projection as the floor) — no alpha feather.
  setMaterial(material: THREE.Material): void {
    this.material = material;
    const nodeMat = material as MeshStandardNodeMaterial;
    // The collar's own base colour, before we bleed the tree bark into the seam. Captured here (from
    // the freshly runtime-built material) so re-mixes always start from the un-wrapped colour.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.baseColorNode = (nodeMat as any).colorNode ?? null;
    nodeMat.alphaHash = false;
    nodeMat.transparent = false;
    nodeMat.opacityNode = null;
    // Push the shaded surface slightly back in depth so the wireframe overlay reads on top of it
    // (mirrors the tree surface material).
    nodeMat.polygonOffset = true;
    nodeMat.polygonOffsetFactor = 1;
    nodeMat.polygonOffsetUnits = 1;
    this.mesh.material = material;
    this.applyColorMix(); // wraps colorNode + calls needsUpdate
  }

  // Point the collar at the tree's baked base-colour texture so the bark can bleed into the root seam.
  setTreeColorSource(source: TreeColorSource): void {
    this.treeColor = source;
    this.applyColorMix();
  }

  // Re-apply the seam colour mix — call when the tree material re-bakes (its RT texture may change).
  refreshColor(): void {
    this.applyColorMix();
  }

  // Wrap the collar's base colour so the tree bark bleeds in by the per-vertex `barkMix` weight near
  // the root seam. No-op until the material is built; falls back to the plain base colour with no
  // tree texture available.
  private applyColorMix(): void {
    const mat = this.material as MeshStandardNodeMaterial;
    const base = this.baseColorNode;
    if (!base) return;
    const tex = this.treeColor?.getTexture() ?? null;
    if (this.treeColor && tex) {
      const bark = triplanarColorNode(tex, this.treeColor.scale, this.treeColor.sharpness);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (mat as any).colorNode = mix(base, bark, attribute("barkMix", "float"));
    } else {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (mat as any).colorNode = base;
    }
    mat.needsUpdate = true;
  }

  // Merge a partial options patch (from the live controls). Does NOT rebuild — the caller schedules
  // the (cheap) collar-only rebuild.
  setOptions(patch: Partial<RootCollarOptions>): void {
    Object.assign(this.opts, patch);
  }

  setVisible(visible: boolean): void {
    this.visibleWanted = visible;
    this.updateVisibility();
  }

  // Reveal the collar only when the user wants it AND there's geometry to draw. The wire overlay is a
  // child, so it follows the parent's visibility automatically.
  private updateVisibility(): void {
    this.mesh.visible = this.visibleWanted && this.hasGeometry();
  }

  // Toggle the wireframe overlay (driven by the shared debug checkbox alongside the tree surface).
  setWireframe(visible: boolean): void {
    this.wireMesh.visible = visible;
  }

  // Rebuild the collar disc against the current root + trunk geometry. Reads world polylines from the
  // graph lines (valid for the current frame — never call beginWorldFrame here). `sliceSegments` are the
  // root/floor crossing slices (root-crossings.ts, already normal-gated) that the groove bands ring —
  // buried ones (under the mound dome) are vetoed here, where the fresh reach is known.
  build(trunk: GraphLine | undefined, rootLines: GraphLine[], sliceSegments?: number[]): void {
    const surfaces = this.collectGroundSurfaces(trunk, rootLines);
    const reach = this.computeReach(rootLines);
    // Keep the disc reach so heightAt() can sample the current mound dome between rebuilds.
    this.lastReach = reach;

    const previous = this.mesh.geometry;
    if (surfaces.length === 0 || reach <= 1e-4) {
      const empty = new THREE.BufferGeometry();
      this.mesh.geometry = empty;
      this.wireMesh.geometry = empty;
      this.updateVisibility(); // no geometry → hidden
      previous.dispose();
      return;
    }

    // Groove source: slice segments that are not buried under the mound. Uses the dome directly (not
    // heightAt) because the mesh's visible flag may lag until updateVisibility below; when the user has
    // hidden the collar there is no mound to bury anything, so no veto applies.
    let grooves: SliceField = EMPTY_SLICE_FIELD;
    if (sliceSegments && sliceSegments.length > 0 && this.opts.grooveDepth > 0) {
      const kept: number[] = [];
      for (let i = 0; i < sliceSegments.length; i += 4) {
        const midX = (sliceSegments[i] + sliceSegments[i + 2]) / 2;
        const midZ = (sliceSegments[i + 1] + sliceSegments[i + 3]) / 2;
        if (this.visibleWanted && this.domeHeight(midX, midZ) > BURIED_EPS) continue;
        kept.push(
          sliceSegments[i],
          sliceSegments[i + 1],
          sliceSegments[i + 2],
          sliceSegments[i + 3],
        );
      }
      grooves = buildSliceField(kept, this.opts.grooveReach);
    }

    const geometry = this.buildDisc(surfaces, reach, grooves);
    this.mesh.geometry = geometry;
    this.wireMesh.geometry = geometry; // wire overlay shares the solid geometry
    previous.dispose();
    this.updateVisibility(); // reveal only if the user hasn't hidden it (never clobber the checkbox)

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

  // The mound's SMOOTH ground height at (x, z) — the dome the collar adds on top of the flat floor,
  // faded out at the rim. Deliberately excludes the root fillet (it hugs the root surfaces, so a
  // fillet-relative crossing test degenerates into the contact line along every root) and the
  // disturbance noise (which jitters crossings on/off along lying roots). 0 outside the collar, before
  // the first build, or while the collar is hidden (then the visible terrain IS the flat floor).
  heightAt(x: number, z: number): number {
    if (!this.mesh.visible) return 0;
    return this.domeHeight(x, z);
  }

  // The dome height regardless of current visibility (build() needs it before updateVisibility runs).
  private domeHeight(x: number, z: number): number {
    const reach = this.lastReach;
    if (reach <= 1e-4) return 0;
    const o = this.opts;
    const radius = Math.hypot(x, z);
    const dome = o.centerHeight * Math.pow(clamp01(1 - clamp01(radius / reach)), o.slope);
    const floorCover = 1 - smoothstepRange(reach - o.floorBlend, reach, radius);
    return Math.max(0, dome * floorCover);
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

  // Radial disc: a centre vertex + concentric rings, fanned/bridged into triangles. Per-vertex height
  // and AO come from the mound field plus the independent groove bands.
  private buildDisc(
    surfaces: GroundSurface[],
    reach: number,
    grooves: SliceField,
  ): THREE.BufferGeometry {
    const { ringCount, sectorCount, radialExponent } = this.opts;
    const vertexCount = 1 + ringCount * sectorCount;

    const positions = new Float32Array(vertexCount * 3);
    const uvs = new Float32Array(vertexCount * 2);
    const aos = new Float32Array(vertexCount);
    const barkMixes = new Float32Array(vertexCount);

    const writeVertex = (index: number, x: number, z: number): void => {
      const s = this.sampleField(surfaces, reach, x, z, grooves);
      positions[index * 3 + 0] = x;
      positions[index * 3 + 1] = s.height;
      positions[index * 3 + 2] = z;
      uvs[index * 2 + 0] = x / (2 * reach) + 0.5;
      uvs[index * 2 + 1] = z / (2 * reach) + 0.5;
      aos[index] = s.ao;
      barkMixes[index] = s.barkMix;
    };

    // Ring radii: split into the dome body [0, innerEnd] and a dense, evenly-spaced rim band
    // [innerEnd, reach] so the geometric floor blend always has enough geometry to read smooth (no
    // polygonal edge) regardless of how narrow floorBlend is.
    const floorBlend = Math.min(this.opts.floorBlend, reach * 0.9);
    const innerEnd = Math.max(1e-3, reach - floorBlend);
    const featherRings = Math.min(ringCount - 1, 6);
    const innerRings = ringCount - featherRings;
    const ringRadius = (k: number): number => {
      if (k <= innerRings) return innerEnd * Math.pow(k / innerRings, radialExponent);
      return innerEnd + floorBlend * ((k - innerRings) / featherRings);
    };

    // Centre vertex.
    writeVertex(0, 0, 0);

    // Rings.
    for (let k = 1; k <= ringCount; k += 1) {
      const radius = ringRadius(k);
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
    // The offline surface material multiplies its AO by this attribute (see createFloorPlane); it is
    // mandatory — omitting it shades the collar to black.
    geometry.setAttribute("vertexAo", new THREE.BufferAttribute(aos, 1));
    // Per-vertex weight for bleeding the tree bark into the collar colour at the root seam.
    geometry.setAttribute("barkMix", new THREE.BufferAttribute(barkMixes, 1));
    geometry.setIndex(indices);
    geometry.computeVertexNormals(); // smooth mound normals (no tangents needed on the floor path)
    geometry.computeBoundingSphere();
    return geometry;
  }

  // The dirt field at ground point (x, 0, z): a dome + a fillet banking up against the roots, plus
  // disturbance noise — and, ADDED INDEPENDENTLY on top, the groove bands ringing the root/floor
  // crossing slices. Returns height above the floor and the baked AO (root-contact crease + groove
  // trough darkening).
  private sampleField(
    surfaces: GroundSurface[],
    reach: number,
    x: number,
    z: number,
    grooves: SliceField,
  ): { height: number; ao: number; barkMix: number } {
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

    const radius = Math.hypot(x, z);
    const rN = clamp01(radius / reach);

    // Dome: peak at the centre, sloping to the floor at the rim.
    const dome = o.centerHeight * Math.pow(clamp01(1 - rN), o.slope);

    // Root fillet: dirt banks up as it approaches a root/trunk surface (d → 0), capped so the tube
    // still emerges. rootProx is 1 at/inside the tube and 0 by FILLET_REACH away.
    const rootProx = smoothstep01(1 - clamp01(Math.max(d, 0) / FILLET_REACH));
    const rootFillet = Math.min(o.rootRaise * rootProx, o.capFraction * nearestRadius);

    // Fade everything to exactly the floor across the outer band, so the rim is flush.
    const floorCover = 1 - smoothstepRange(reach - o.floorBlend, reach, radius);

    const n = value2D(x * o.disturbanceScale, z * o.disturbanceScale, o.seed); // [0,1], 2-octave
    // The collar's own field — dome/fillet/noise faded by floorCover. Grooves are NOT part of this.
    const base = (dome + rootFillet + o.disturbance * (n - 0.5) * 2) * floorCover;

    // Groove bands: concentric ripples ringing the nearest crossing slice, INDEPENDENT of the collar's
    // shaping — driven only by the distance to the slice segments and the groove params (own noise
    // seed too). `grooveShade` feeds the AO term below.
    let groove = 0;
    let grooveShade = 0;
    const dSlice = grooves.nearestDist(x, z);
    if (dSlice < o.grooveReach) {
      // Hard rim guarantee: whatever the bands do, the disc's outer edge stays exactly on the floor.
      const rimFade = 1 - smoothstepRange(reach - GROOVE_RIM_FADE, reach, radius);
      const grooveEnv = (1 - smoothstepRange(0, o.grooveReach, dSlice)) * rimFade;
      const phase = o.grooveJitter * (value2D(x * 0.9, z * 0.9, o.seed ^ 0x0a1c) - 0.5);
      const wave = Math.cos((dSlice / Math.max(1e-3, o.grooveSpacing) + phase) * Math.PI * 2);
      // Symmetric ripple; grooveSharp (>1) deepens the troughs relative to the ridges (carve bias).
      const profile = wave >= 0 ? wave : wave * o.grooveSharp;
      groove = o.grooveDepth * profile * grooveEnv;
      // Shade = trough crevices PLUS a contact band hugging the slice edge itself — the darkening is
      // strongest right where the root meets the grooved dirt, so the root reads as separate from it.
      const trough = clamp01(-wave) * grooveEnv;
      const contact = (1 - smoothstepRange(0, o.grooveSpacing * 0.75, dSlice)) * rimFade;
      grooveShade = Math.max(trough, contact);
    }

    // Grooves add AFTER the collar shaping (no floorCover/slope scaling); the floor clamp only keeps
    // the disc from dipping under the floor plane that sits just below it.
    let height = Math.max(0, base + groove);

    // Seam softening: a contact band hugging the nearest root/trunk surface (|d| small). Drives a
    // contact-shadow AO darkening AND the amount of tree bark bled into the collar colour — so the
    // collar↔root edge isn't a hard cut, without transparency (which revealed gaps).
    const band = 1 - smoothstepRange(0, o.rootEdgeBlend, Math.abs(d));

    // AO: contact shadow that darkens the dirt toward the root by `rootEdgeAO`, plus the groove shade
    // (slice-edge contact + trough crevices) by `grooveAO`. → 1 away from roots/grooves.
    const ao = clamp(1 - o.rootEdgeAO * band - o.grooveAO * grooveShade, AO_MIN, 1);

    // Bark bleed weight: how much the tree texture mixes into the collar colour here (0 away from
    // roots → rootEdgeMix at the contact).
    const barkMix = clamp01(o.rootEdgeMix * band);

    return { height, ao, barkMix };
  }
}

// World-space triplanar sample of a baked colour texture → an rgb node. Matches the runtime's
// floor/tree projection (positionWorld*scale, weights from pow(abs(normalWorld), sharpness)) so the
// bled-in bark reads at the tree's scale. The package doesn't export its own triplanar helper.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function triplanarColorNode(map: THREE.Texture, scale: any, sharpness: any): any {
  const wp = positionWorld.mul(scale);
  const wRaw = normalWorld.abs().pow(sharpness);
  const w = wRaw.div(wRaw.x.add(wRaw.y).add(wRaw.z).add(1e-4));
  const cx = texture(map, vec2(wp.y, wp.z)).rgb;
  const cy = texture(map, vec2(wp.z, wp.x)).rgb;
  const cz = texture(map, vec2(wp.x, wp.y)).rgb;
  return cx.mul(w.x).add(cy.mul(w.y)).add(cz.mul(w.z));
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

// 2-octave value noise in [0,1]: a coarse base plus a finer detail octave, for a more natural clumped
// disturbance than a single octave. Deterministic (no new dependency), so the collar is stable.
function value2D(x: number, z: number, seed: number): number {
  const base = valueBilinear(x, z, seed);
  const detail = valueBilinear(x * 2.03, z * 2.03, seed ^ 0x9e3779b1);
  return clamp01(base * 0.65 + detail * 0.35);
}

// Bilinear value noise over the integer lattice, from the shared hash. Reuses `smoothstep` (utils) for
// the per-axis interpolation.
function valueBilinear(x: number, z: number, seed: number): number {
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
