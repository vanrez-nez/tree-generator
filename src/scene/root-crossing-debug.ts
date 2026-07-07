import * as THREE from "three";
import { BURIED_EPS } from "./root-crossings";

// Debug overlay: draws the exact slice outline where the tree mesh passes through the ground — the SAME
// filtered segments the collar's grooves ring (extracted once in MainScene via root-crossings.ts and
// passed in). This class only applies the burial veto and renders: segments whose midpoint the collar
// mound covers sit inside the dirt (not visible ground entries) and are hidden; kept endpoints hug the
// terrain plus a tiny lift.

export interface RootCrossingDebugOptions {
  markerHeight?: number; // y-lift above the terrain so the outline reads over the dirt
}

const DEFAULTS: Required<RootCrossingDebugOptions> = {
  // Just enough lift to avoid z-coplanarity with the floor — the overlay renders on top anyway
  // (depthTest off), so anything higher reads as floating.
  markerHeight: 0.005,
};

export class RootCrossingDebug {
  readonly object: THREE.LineSegments;
  private readonly opts: Required<RootCrossingDebugOptions>;

  constructor(options: RootCrossingDebugOptions = {}) {
    this.opts = { ...DEFAULTS, ...options };
    // Bright, always-on-top lines (depthTest off) so the outline is visible even against the mound or
    // behind the trunk — this is a diagnostic overlay, not part of the scene look.
    const material = new THREE.LineBasicMaterial({
      color: 0xff2f6d,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });
    this.object = new THREE.LineSegments(new THREE.BufferGeometry(), material);
    this.object.name = "root-crossing-debug";
    this.object.renderOrder = 999;
    this.object.frustumCulled = false;
    this.object.visible = false; // off until the debug toggle turns it on
  }

  setVisible(visible: boolean): void {
    this.object.visible = visible;
  }

  get visible(): boolean {
    return this.object.visible;
  }

  setOptions(patch: Partial<RootCrossingDebugOptions>): void {
    Object.assign(this.opts, patch);
  }

  // Rebuild the outline from pre-extracted slice segments (flat [x0, z0, x1, z1, …]). `groundHeight` is
  // the collar mound's height at (x, z): it vetoes buried segments and seats the outline on the terrain.
  update(
    segments: number[],
    groundHeight: (x: number, z: number) => number = () => 0,
  ): void {
    const count = segments.length >> 2;
    const positions: number[] = [];
    for (let i = 0; i < count; i += 1) {
      const x0 = segments[i * 4];
      const z0 = segments[i * 4 + 1];
      const x1 = segments[i * 4 + 2];
      const z1 = segments[i * 4 + 3];
      // Burial veto: a crossing the mound covers happens inside the dirt — nothing visibly enters there.
      if (groundHeight((x0 + x1) / 2, (z0 + z1) / 2) > BURIED_EPS) continue;
      positions.push(
        x0,
        groundHeight(x0, z0) + this.opts.markerHeight,
        z0,
        x1,
        groundHeight(x1, z1) + this.opts.markerHeight,
        z1,
      );
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(positions), 3));
    this.object.geometry.dispose();
    this.object.geometry = geo;
  }

  dispose(): void {
    this.object.geometry.dispose();
    (this.object.material as THREE.Material).dispose();
  }
}
