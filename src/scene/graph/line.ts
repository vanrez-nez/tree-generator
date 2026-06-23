import * as THREE from "three";
import { Line2 } from "three/examples/jsm/lines/Line2.js";
import { LineGeometry } from "three/examples/jsm/lines/LineGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
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

type LineGeometryWithInstanceCache = LineGeometry & {
  _maxInstanceCount?: number;
};

const DEBUG_POINT_RADIUS = 0.055;
const DEBUG_POINT_SCREEN_RADIUS = 0.0047;

export class VirtualLine {
  modifiers: LineModifier[];
  points: THREE.Vector3[];

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

  getPointAt(t: number): THREE.Vector3 {
    const normalizedT = clamp01(t);
    const transformedPoints = this.getTransformedPoints();

    if (transformedPoints.length === 0) {
      return new THREE.Vector3();
    }

    if (transformedPoints.length === 1) {
      return transformedPoints[0].clone();
    }

    return getLinearPointAt(transformedPoints, normalizedT);
  }

  getPointAtStep(step: number, steps: number): THREE.Vector3 {
    if (steps <= 0) {
      return this.getPointAt(0);
    }

    return this.getPointAt(step / steps);
  }

  // Samples the structural (pre-modifier) skeleton, so callers that care about a
  // line's authored direction aren't thrown off by twist/gnarl/coil wiggle.
  getBasePointAt(t: number): THREE.Vector3 {
    const basePoints = this.points;

    if (basePoints.length === 0) {
      return new THREE.Vector3();
    }

    if (basePoints.length === 1) {
      return basePoints[0].clone();
    }

    return getLinearPointAt(basePoints, clamp01(t));
  }

  getDrawPoints(): THREE.Vector3[] {
    return this.getTransformedPoints();
  }

  getDrawnPointForIndex(index: number): THREE.Vector3 {
    const basePoints = this.points;

    if (index < 0 || index >= basePoints.length) {
      return new THREE.Vector3();
    }

    const drawPoints = this.getTransformedPoints();

    if (drawPoints.length === 0) {
      return basePoints[index].clone();
    }

    if (drawPoints.length === 1) {
      return drawPoints[0].clone();
    }

    const pointTs = getPolylinePointTs(basePoints);

    return getLinearPointAt(drawPoints, pointTs[index]);
  }

  getTransformedPoints(): THREE.Vector3[] {
    let transformedPoints = this.getBasePoints();

    for (const modifier of this.modifiers) {
      if (modifier.enabled) {
        const inputPoints = transformedPoints;
        const outputPoints = modifier.apply(inputPoints);
        transformedPoints = applyEnvelope(inputPoints, outputPoints, modifier.envelope);
      }
    }

    return transformedPoints;
  }

  private getBasePoints(): THREE.Vector3[] {
    return this.points.map((point) => point.clone());
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
  private readonly geometry = new LineGeometry();
  private readonly material = new LineMaterial({ color: 0xffffff });
  private readonly line = new Line2(this.geometry, this.material);

  constructor(private readonly lineState: GraphLine) {
    this.object.add(this.line);
    this.object.add(this.debugPoint);

    if (this.lineState.tube) {
      this.object.add(this.lineState.tube.object);
    }

    this.debugPoint.renderOrder = 10;
    this.updateDrawing();
  }

  updateDrawing(camera?: THREE.Camera, viewportSize?: THREE.Vector2): void {
    this.material.color.set(this.lineState.color);
    this.material.linewidth = this.lineState.thickness;
    this.material.dashed = this.lineState.style === "dashed";
    this.material.dashSize = this.lineState.dashSize;
    this.material.gapSize = this.lineState.gapSize;

    if (viewportSize) {
      this.material.resolution.copy(viewportSize);
    }

    this.debugMaterial.color.set(this.lineState.color);
    this.debugPoint.visible = this.lineState.debugPointVisible;
    this.debugPoint.position.copy(this.lineState.getPointAt(this.lineState.debugT));
    this.updateDebugPointScale(camera);

    const drawPoints = this.lineState.virtual.getDrawPoints();
    this.updateLinePointDebugMarkers(drawPoints, camera);
    this.setGeometryPoints(drawPoints);
    this.lineState.tube?.update(drawPoints);

    if (this.lineState.style === "dashed") {
      this.line.computeLineDistances();
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
    this.geometry.setFromPoints(points);
    (this.geometry as LineGeometryWithInstanceCache)._maxInstanceCount =
      this.geometry.instanceCount;
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

  updateDrawing(camera?: THREE.Camera, viewportSize?: THREE.Vector2): void {
    this.visual.updateDrawing(camera, viewportSize);
  }

  dispose(): void {
    this.visual.dispose();
  }
}

function clamp01(value: number): number {
  return Math.min(Math.max(value, 0), 1);
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
