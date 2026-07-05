import * as THREE from "three";
// WebGPU fat-line classes: the classic Line2/LineMaterial use a shader material the WebGPU
// NodeBuilder rejects ("Material 'LineMaterial' is not compatible"). The lines/webgpu variants are
// drop-in and back the same API with Line2NodeMaterial.
import { Line2 } from "three/examples/jsm/lines/webgpu/Line2.js";
import { LineGeometry } from "three/examples/jsm/lines/LineGeometry.js";
import { Line2NodeMaterial } from "three/webgpu";
import { FNV_OFFSET, hashFloat } from "./hash";
import { applyEnvelope, type LineModifier } from "./modifiers/modifier";
import { SmoothModifier } from "./modifiers/smooth";
import { LineTube, type LineTubeOptions } from "./line-tube";

export type GraphLineStyle = "normal" | "dashed";

export type GraphLineOptions = {
  color?: THREE.ColorRepresentation;
  dashSize?: number;
  debugLinePointsVisible?: boolean;
  debugPointVisible?: boolean;
  debugT?: number;
  gapSize?: number;
  modifiers?: LineModifier[];
  points?: THREE.Vector3[];
  smooth?: boolean;
  style?: GraphLineStyle;
  thickness?: number;
  tube?: LineTubeOptions;
};

const DEBUG_POINT_RADIUS = 0.055;
const DEBUG_POINT_SCREEN_RADIUS = 0.0047;

// A line's connection to the rest of the tree. The world assembler (`VirtualLine.worldPoints`) is
// the ONLY producer of world-space points, and it always re-bases the pivot onto `anchor()`, so a
// line's connection point is `world[pivot] === anchor()` BY CONSTRUCTION — no modifier, jitter, or
// generation path can break it. `restWorldOverride` lets roots supply a parent-riding shape;
// otherwise the local authored shape is rotated by `orient()` about the pivot and placed at the
// anchor. The trunk uses the origin attachment (anchored at world origin, no rotation).
export interface LineAttachment {
  pivot: number;
  anchor(): THREE.Vector3;
  orient(): THREE.Quaternion;
  restWorldOverride?: () => THREE.Vector3[];
}

export const ORIGIN_ATTACHMENT: LineAttachment = {
  pivot: 0,
  anchor: () => new THREE.Vector3(),
  orient: () => new THREE.Quaternion(),
};

// Per-frame memo key. `Graph.update` bumps it once per frame so every line resolves at most once,
// and a parent pulled lazily by several children is computed a single time.
let worldCacheFrame = 0;
export function beginWorldFrame(): void {
  worldCacheFrame += 1;
}

export class VirtualLine {
  modifiers: LineModifier[];
  points: THREE.Vector3[]; // LOCAL authored shape; points[pivot] is the local origin.
  attachment: LineAttachment = ORIGIN_ATTACHMENT;

  private cacheFrame = -1;
  private cachedWorld: THREE.Vector3[] = [];
  private cachedRest: THREE.Vector3[] = [];

  constructor({
    modifiers = [],
    points = [],
    smooth = false,
  }: Pick<GraphLineOptions, "modifiers" | "points" | "smooth"> = {}) {
    this.points = points;
    this.modifiers = smooth
      ? [...modifiers, new SmoothModifier({ mode: "spline" })]
      : modifiers;
  }

  // The single world-space producer. (1) place/override the rest shape in world, (2) apply
  // modifiers, (3) re-base the pivot onto the anchor. Step 3 makes `world[pivot] === anchor` an
  // algebraic identity — the structural connection guarantee.
  worldPoints(): THREE.Vector3[] {
    this.resolve();
    return this.cachedWorld;
  }

  // Pre-modifier world rest, so a parent's structural heading can orient its children without being
  // thrown off by the parent's twist/gnarl wiggle.
  worldRestPoints(): THREE.Vector3[] {
    this.resolve();
    return this.cachedRest;
  }

  getDrawPoints(): THREE.Vector3[] {
    return this.worldPoints();
  }

  getPointAt(t: number): THREE.Vector3 {
    return sampleAt(this.worldPoints(), clamp01(t));
  }

  getPointAtStep(step: number, steps: number): THREE.Vector3 {
    if (steps <= 0) {
      return this.getPointAt(0);
    }
    return this.getPointAt(step / steps);
  }

  getBasePointAt(t: number): THREE.Vector3 {
    return sampleAt(this.worldRestPoints(), clamp01(t));
  }

  getDrawnPointForIndex(index: number): THREE.Vector3 {
    const shape = this.points;
    if (index < 0 || index >= shape.length) {
      return new THREE.Vector3();
    }
    const world = this.worldPoints();
    if (world.length === 0) {
      return new THREE.Vector3();
    }
    if (world.length === 1) {
      return world[0].clone();
    }
    return getLinearPointAt(world, getPolylinePointTs(shape)[index]);
  }

  private resolve(): void {
    // Set the cache key up front so an (ill-formed) cyclic attachment returns the stale buffers
    // instead of recursing forever; well-formed trees never re-enter their own resolve.
    if (this.cacheFrame === worldCacheFrame) {
      return;
    }
    this.cacheFrame = worldCacheFrame;

    const attachment = this.attachment;
    const rest = attachment.restWorldOverride
      ? attachment.restWorldOverride()
      : this.placeRest(attachment);
    this.cachedRest = rest;

    let world = rest.map((point) => point.clone());
    for (const modifier of this.modifiers) {
      if (modifier.enabled) {
        const input = world;
        const output = modifier.apply(input);
        world = applyEnvelope(input, output, modifier.envelope);
      }
    }

    if (world.length > 0) {
      const pivot = Math.min(Math.max(attachment.pivot, 0), world.length - 1);
      const delta = attachment.anchor().sub(world[pivot]);
      for (const point of world) {
        point.add(delta);
      }
    }

    this.cachedWorld = world;
  }

  // Place the local shape in world: rotate about the pivot by orient(), pivot landing on anchor().
  private placeRest(attachment: LineAttachment): THREE.Vector3[] {
    const shape = this.points;
    if (shape.length === 0) {
      return [];
    }
    const pivot = Math.min(Math.max(attachment.pivot, 0), shape.length - 1);
    const orient = attachment.orient();
    const anchor = attachment.anchor();
    const pivotPoint = shape[pivot];
    return shape.map((point) =>
      point.clone().sub(pivotPoint).applyQuaternion(orient).add(anchor),
    );
  }
}

export class GraphLineVisual {
  readonly object = new THREE.Group();

  private readonly debugGeometry = new THREE.SphereGeometry(DEBUG_POINT_RADIUS, 16, 12);
  private readonly debugMaterial = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    depthTest: false,
    depthWrite: false,
  });
  private readonly debugPoint = new THREE.Mesh(this.debugGeometry, this.debugMaterial);
  private readonly linePointDebugMaterial = new THREE.MeshBasicMaterial({
    color: 0xfff06a,
    depthTest: false,
    depthWrite: false,
  });
  private readonly linePointDebugMarkers: THREE.Mesh[] = [];
  private geometry = new LineGeometry();
  // Segment count of the geometry currently on `this.line`, so we can detect when the instanced
  // fat-line buffer needs to grow/shrink (see `setGeometryPoints`). -1 until the first draw.
  private drawnSegmentCount = -1;
  // Drawn as an always-visible overlay: depthTest off + a high renderOrder so the line
  // skeleton shows through the surface mesh regardless of camera angle.
  private readonly material = new Line2NodeMaterial({
    color: 0xffffff,
    depthTest: false,
    depthWrite: false,
    transparent: true,
  });
  private readonly line = new Line2(this.geometry, this.material);

  constructor(private readonly lineState: GraphLine) {
    this.object.add(this.line);
    this.object.add(this.debugPoint);

    if (this.lineState.tube) {
      this.object.add(this.lineState.tube.object);
    }

    this.line.renderOrder = 9;
    this.debugPoint.renderOrder = 10;
    this.updateDrawing();
  }

  updateDrawing(camera?: THREE.Camera, viewportSize?: THREE.Vector2): void {
    this.material.color.set(this.lineState.color);
    this.material.linewidth = this.lineState.thickness;
    this.material.dashed = this.lineState.style === "dashed";
    this.material.dashSize = this.lineState.dashSize;
    this.material.gapSize = this.lineState.gapSize;

    // Line2NodeMaterial derives the viewport resolution internally (unlike the WebGL LineMaterial,
    // which needed it set each resize), so this is only applied if the property is present.
    const mat = this.material as unknown as { resolution?: THREE.Vector2 };
    if (viewportSize && mat.resolution) {
      mat.resolution.copy(viewportSize);
    }

    this.debugMaterial.color.set(this.lineState.color);
    this.debugPoint.visible = this.lineState.debugPointVisible;
    this.debugPoint.position.copy(this.lineState.getPointAt(this.lineState.debugT));
    this.updateDebugPointScale(camera);

    const drawPoints = this.lineState.virtual.getDrawPoints();
    this.updateLinePointDebugMarkers(drawPoints, camera);
    this.setGeometryPoints(drawPoints);
    this.lineState.tube?.update(drawPoints);
    this.lineState.geometryHash = computeGeometryHash(drawPoints, this.lineState.tube);

    if (this.lineState.style === "dashed") {
      this.line.computeLineDistances();
    }
  }

  // Camera-only refresh: keep the debug markers at a constant on-screen size when the geometry didn't change
  // and `updateDrawing` was skipped this frame. Reuses the marker positions set by the last full draw — no
  // geometry/modifier work.
  refreshCameraScale(camera?: THREE.Camera): void {
    this.updateDebugPointScale(camera);

    if (this.lineState.debugLinePointsVisible) {
      for (const marker of this.linePointDebugMarkers) {
        if (marker.visible) {
          this.updateMarkerScale(marker, camera);
        }
      }
    }
  }

  dispose(): void {
    this.object.remove(this.line);
    this.object.remove(this.debugPoint);

    if (this.lineState.tube) {
      this.object.remove(this.lineState.tube.object);
      this.lineState.tube.dispose();
    }

    this.geometry.dispose();
    this.material.dispose();
    this.debugGeometry.dispose();
    this.debugMaterial.dispose();
    this.linePointDebugMaterial.dispose();
  }

  private updateDebugPointScale(camera?: THREE.Camera): void {
    if (!camera) {
      this.debugPoint.scale.setScalar(1);
      return;
    }

    if (camera instanceof THREE.PerspectiveCamera) {
      const distance = camera.position.distanceTo(this.debugPoint.getWorldPosition(_worldPosition));
      const visibleHeight =
        2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) * distance;
      this.debugPoint.scale.setScalar(
        (visibleHeight * DEBUG_POINT_SCREEN_RADIUS) / DEBUG_POINT_RADIUS,
      );
      return;
    }

    if (camera instanceof THREE.OrthographicCamera) {
      const visibleHeight = (camera.top - camera.bottom) / camera.zoom;
      this.debugPoint.scale.setScalar(
        (visibleHeight * DEBUG_POINT_SCREEN_RADIUS) / DEBUG_POINT_RADIUS,
      );
      return;
    }

    this.debugPoint.scale.setScalar(1);
  }

  private setGeometryPoints(points: THREE.Vector3[]): void {
    if (points.length < 2) {
      this.line.visible = false;
      return;
    }

    this.line.visible = true;

    // The fat line is instanced: one instance per segment, backed by an `instanceStart`/`instanceEnd`
    // buffer that `setFromPoints` reallocates on every call. When the segment count GROWS on a reused
    // `LineGeometry` (e.g. the coil modifier densifies a 12-point line into 64 segments), the WebGPU
    // renderer can keep the previous, smaller instance buffer bound while `geometry.instanceCount`
    // already reflects the larger count — raising "Instance range ... requires a larger buffer than
    // the bound buffer size" and invalidating the whole command buffer (rendering stops). Swapping in
    // a fresh geometry whenever the segment count changes bumps `geometry.id`, and the renderer's
    // geometry-id check is the one cache-invalidation path that is never missed, so it always rebinds
    // the correctly sized buffer.
    const segmentCount = points.length - 1;
    if (segmentCount !== this.drawnSegmentCount) {
      const previous = this.geometry;
      this.geometry = new LineGeometry();
      this.line.geometry = this.geometry;
      previous.dispose();
      this.drawnSegmentCount = segmentCount;
    }

    this.geometry.setFromPoints(points);
    this.geometry.computeBoundingSphere();
  }

  private updateLinePointDebugMarkers(
    drawPoints: THREE.Vector3[],
    camera?: THREE.Camera,
  ): void {
    const points = this.lineState.points;
    const pointTs = getPolylinePointTs(points);
    this.syncLinePointDebugMarkerCount(points.length);

    for (let index = 0; index < this.linePointDebugMarkers.length; index += 1) {
      const marker = this.linePointDebugMarkers[index];
      marker.visible = this.lineState.debugLinePointsVisible;

      if (!marker.visible) {
        continue;
      }

      marker.position.copy(getLinearPointAt(drawPoints, pointTs[index]));
      this.updateMarkerScale(marker, camera);
    }
  }

  private syncLinePointDebugMarkerCount(count: number): void {
    while (this.linePointDebugMarkers.length < count) {
      const marker = new THREE.Mesh(this.debugGeometry, this.linePointDebugMaterial);
      marker.renderOrder = 11;
      this.linePointDebugMarkers.push(marker);
      this.object.add(marker);
    }

    while (this.linePointDebugMarkers.length > count) {
      const marker = this.linePointDebugMarkers.pop();

      if (marker) {
        this.object.remove(marker);
      }
    }
  }

  private updateMarkerScale(marker: THREE.Mesh, camera?: THREE.Camera): void {
    if (!camera) {
      marker.scale.setScalar(1);
      return;
    }

    if (camera instanceof THREE.PerspectiveCamera) {
      const distance = camera.position.distanceTo(marker.getWorldPosition(_worldPosition));
      const visibleHeight =
        2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) * distance;
      marker.scale.setScalar(
        (visibleHeight * DEBUG_POINT_SCREEN_RADIUS) / DEBUG_POINT_RADIUS,
      );
      return;
    }

    if (camera instanceof THREE.OrthographicCamera) {
      const visibleHeight = (camera.top - camera.bottom) / camera.zoom;
      marker.scale.setScalar(
        (visibleHeight * DEBUG_POINT_SCREEN_RADIUS) / DEBUG_POINT_RADIUS,
      );
      return;
    }

    marker.scale.setScalar(1);
  }
}

export class GraphLine {
  color: THREE.ColorRepresentation;
  dashSize: number;
  debugLinePointsVisible: boolean;
  debugPointVisible: boolean;
  debugT: number;
  gapSize: number;
  style: GraphLineStyle;
  thickness: number;

  // Content hash of this line's last-drawn geometry (positions + mesh-relevant tube params),
  // refreshed every `updateDrawing`. Read by `Graph.getGeometrySignature` to detect graph changes.
  geometryHash = 0;

  readonly object: THREE.Group;
  readonly virtual: VirtualLine;
  readonly tube?: LineTube;

  private readonly visual: GraphLineVisual;

  constructor({
    color = 0xffffff,
    dashSize = 0.2,
    debugLinePointsVisible = false,
    debugPointVisible = true,
    debugT = 0.5,
    gapSize = 0.1,
    modifiers = [],
    points = [],
    smooth = false,
    style = "normal",
    thickness = 1,
    tube,
  }: GraphLineOptions = {}) {
    this.color = color;
    this.dashSize = dashSize;
    this.debugLinePointsVisible = debugLinePointsVisible;
    this.debugPointVisible = debugPointVisible;
    this.debugT = debugT;
    this.gapSize = gapSize;
    this.style = style;
    this.thickness = thickness;
    this.virtual = new VirtualLine({ modifiers, points, smooth });
    this.tube = tube ? new LineTube(tube) : undefined;
    this.visual = new GraphLineVisual(this);
    this.object = this.visual.object;
  }

  get points(): THREE.Vector3[] {
    return this.virtual.points;
  }

  set points(points: THREE.Vector3[]) {
    this.virtual.points = points;
  }

  get modifiers(): LineModifier[] {
    return this.virtual.modifiers;
  }

  set modifiers(modifiers: LineModifier[]) {
    this.virtual.modifiers = modifiers;
  }

  get pointCount(): number {
    return this.virtual.points.length;
  }

  get smooth(): boolean {
    return this.virtual.modifiers.some(
      (modifier) => modifier instanceof SmoothModifier && modifier.enabled,
    );
  }

  set smooth(smooth: boolean) {
    const smoothModifier = this.virtual.modifiers.find(
      (modifier): modifier is SmoothModifier => modifier instanceof SmoothModifier,
    );

    if (smoothModifier) {
      smoothModifier.enabled = smooth;
      return;
    }

    if (smooth) {
      this.virtual.modifiers.push(new SmoothModifier());
    }
  }

  getPointAt(t: number): THREE.Vector3 {
    return this.virtual.getPointAt(t);
  }

  getPointAtStep(step: number, steps: number): THREE.Vector3 {
    return this.virtual.getPointAtStep(step, steps);
  }

  getDrawnPointForIndex(index: number): THREE.Vector3 {
    return this.virtual.getDrawnPointForIndex(index);
  }

  getBasePointAt(t: number): THREE.Vector3 {
    return this.virtual.getBasePointAt(t);
  }

  // Connection point: the world position of the pivot, which the assembler pins to the parent.
  get attachment(): LineAttachment {
    return this.virtual.attachment;
  }

  set attachment(attachment: LineAttachment) {
    this.virtual.attachment = attachment;
  }

  updateDrawing(camera?: THREE.Camera, viewportSize?: THREE.Vector2): void {
    this.visual.updateDrawing(camera, viewportSize);
  }

  // Cheap per-frame debug-marker rescale used when the full redraw is skipped (geometry unchanged).
  refreshCameraScale(camera?: THREE.Camera): void {
    this.visual.refreshCameraScale(camera);
  }

  dispose(): void {
    this.visual.dispose();
  }
}

// Hash everything about a line the mesher consumes: the drawn centerline plus the tube's radius
// profile (radius/tipScale/curve) and sampling density. Visual-only fields (color, opacity,
// segments, thickness) are excluded — they don't change the surface.
function computeGeometryHash(points: THREE.Vector3[], tube?: LineTube): number {
  let hash = FNV_OFFSET;

  for (const point of points) {
    hash = hashFloat(hash, point.x);
    hash = hashFloat(hash, point.y);
    hash = hashFloat(hash, point.z);
  }

  if (tube) {
    hash = hashFloat(hash, tube.radius);
    hash = hashFloat(hash, tube.tipScale);
    hash = hashFloat(hash, tube.density);
    for (const value of tube.curve) {
      hash = hashFloat(hash, value);
    }
  }

  return hash >>> 0;
}

function clamp01(value: number): number {
  return Math.min(Math.max(value, 0), 1);
}

function sampleAt(points: THREE.Vector3[], t: number): THREE.Vector3 {
  if (points.length === 0) {
    return new THREE.Vector3();
  }
  if (points.length === 1) {
    return points[0].clone();
  }
  return getLinearPointAt(points, t);
}

function getLinearPointAt(points: THREE.Vector3[], t: number): THREE.Vector3 {
  const segmentCount = points.length - 1;
  const scaledT = t * segmentCount;
  const segmentIndex = Math.min(Math.floor(scaledT), segmentCount - 1);
  const segmentT = scaledT - segmentIndex;
  const start = points[segmentIndex];
  const end = points[segmentIndex + 1];

  return start.clone().lerp(end, segmentT);
}

function getPolylinePointTs(points: THREE.Vector3[]): number[] {
  if (points.length === 0) {
    return [];
  }

  if (points.length === 1) {
    return [0];
  }

  const distances = [0];

  for (let index = 1; index < points.length; index += 1) {
    distances[index] = distances[index - 1] + points[index - 1].distanceTo(points[index]);
  }

  const totalDistance = distances[distances.length - 1];

  if (totalDistance <= 1e-6) {
    return points.map((_point, index) => index / Math.max(points.length - 1, 1));
  }

  return distances.map((distance) => distance / totalDistance);
}

const _worldPosition = new THREE.Vector3();
