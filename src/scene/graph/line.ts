import * as THREE from "three";
import { Line2 } from "three/examples/jsm/lines/Line2.js";
import { LineGeometry } from "three/examples/jsm/lines/LineGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import type { LineModifier } from "./modifiers/modifier";
import { SmoothModifier } from "./modifiers/smooth";

export type GraphLineStyle = "normal" | "dashed";

export type GraphLineOptions = {
  color?: THREE.ColorRepresentation;
  dashSize?: number;
  debugPointVisible?: boolean;
  debugT?: number;
  gapSize?: number;
  modifiers?: LineModifier[];
  points?: THREE.Vector3[];
  segments?: number;
  smooth?: boolean;
  style?: GraphLineStyle;
  thickness?: number;
};

type LineGeometryWithInstanceCache = LineGeometry & {
  _maxInstanceCount?: number;
};

const DEFAULT_SEGMENTS = 64;
const DEBUG_POINT_RADIUS = 0.055;
const DEBUG_POINT_SCREEN_RADIUS = 0.014;

export class VirtualLine {
  modifiers: LineModifier[];
  points: THREE.Vector3[];
  segments: number;

  constructor({
    modifiers = [],
    points = [],
    segments = DEFAULT_SEGMENTS,
    smooth = false,
  }: Pick<GraphLineOptions, "modifiers" | "points" | "segments" | "smooth"> = {}) {
    this.points = points;
    this.segments = segments;
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

  getDrawPoints(): THREE.Vector3[] {
    return this.getTransformedPoints();
  }

  getTransformedPoints(): THREE.Vector3[] {
    let transformedPoints = this.getBasePoints();

    for (const modifier of this.modifiers) {
      if (modifier.enabled) {
        transformedPoints = modifier.apply(transformedPoints);
      }
    }

    return transformedPoints;
  }

  private getBasePoints(): THREE.Vector3[] {
    if (this.points.length < 2) {
      return this.points.map((point) => point.clone());
    }

    return subdivideSegments(this.points, Math.max(1, Math.floor(this.segments)));
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
  private readonly geometry = new LineGeometry();
  private readonly material = new LineMaterial({ color: 0xffffff });
  private readonly line = new Line2(this.geometry, this.material);

  constructor(private readonly lineState: GraphLine) {
    this.object.add(this.line);
    this.object.add(this.debugPoint);
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

    this.setGeometryPoints(this.lineState.virtual.getDrawPoints());

    if (this.lineState.style === "dashed") {
      this.line.computeLineDistances();
    }
  }

  dispose(): void {
    this.object.remove(this.line);
    this.object.remove(this.debugPoint);
    this.geometry.dispose();
    this.material.dispose();
    this.debugGeometry.dispose();
    this.debugMaterial.dispose();
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
}

export class GraphLine {
  color: THREE.ColorRepresentation;
  dashSize: number;
  debugPointVisible: boolean;
  debugT: number;
  gapSize: number;
  style: GraphLineStyle;
  thickness: number;

  readonly object: THREE.Group;
  readonly virtual: VirtualLine;

  private readonly visual: GraphLineVisual;

  constructor({
    color = 0xffffff,
    dashSize = 0.2,
    debugPointVisible = true,
    debugT = 0.5,
    gapSize = 0.1,
    modifiers = [],
    points = [],
    segments = DEFAULT_SEGMENTS,
    smooth = false,
    style = "normal",
    thickness = 1,
  }: GraphLineOptions = {}) {
    this.color = color;
    this.dashSize = dashSize;
    this.debugPointVisible = debugPointVisible;
    this.debugT = debugT;
    this.gapSize = gapSize;
    this.style = style;
    this.thickness = thickness;
    this.virtual = new VirtualLine({ modifiers, points, segments, smooth });
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

  get segments(): number {
    return this.virtual.segments;
  }

  set segments(segments: number) {
    this.virtual.segments = Math.max(1, Math.floor(segments));
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

function subdivideSegments(points: THREE.Vector3[], subdivisions: number): THREE.Vector3[] {
  const subdividedPoints: THREE.Vector3[] = [];

  for (let index = 0; index < points.length - 1; index += 1) {
    const start = points[index];
    const end = points[index + 1];

    for (let step = 0; step < subdivisions; step += 1) {
      subdividedPoints.push(start.clone().lerp(end, step / subdivisions));
    }
  }

  subdividedPoints.push(points[points.length - 1].clone());

  return subdividedPoints;
}

const _worldPosition = new THREE.Vector3();
