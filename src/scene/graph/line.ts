import * as THREE from "three";
import type { LineModifier } from "./modifiers/modifier";
import { SplineModifier } from "./modifiers/spline";

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

type GraphLineMaterial = THREE.LineBasicMaterial | THREE.LineDashedMaterial;

const DEFAULT_SEGMENTS = 64;
const DEBUG_POINT_RADIUS = 0.055;
const DEBUG_POINT_SCREEN_RADIUS = 0.014;

export class VirtualLine {
  modifiers: LineModifier[];
  points: THREE.Vector3[];

  constructor({
    modifiers = [],
    points = [],
    segments = DEFAULT_SEGMENTS,
    smooth = false,
  }: Pick<GraphLineOptions, "modifiers" | "points" | "segments" | "smooth"> = {}) {
    this.points = points;
    this.modifiers = smooth
      ? [...modifiers, new SplineModifier({ segments })]
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
    let transformedPoints = this.points.map((point) => point.clone());

    for (const modifier of this.modifiers) {
      if (modifier.enabled) {
        transformedPoints = modifier.apply(transformedPoints);
      }
    }

    return transformedPoints;
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
  private readonly geometry = new THREE.BufferGeometry();
  private readonly line: THREE.Line<THREE.BufferGeometry, GraphLineMaterial>;
  private material: GraphLineMaterial;

  constructor(private readonly lineState: GraphLine) {
    this.material = this.createMaterial();
    this.line = new THREE.Line(this.geometry, this.material);
    this.object.add(this.line);
    this.object.add(this.debugPoint);
    this.debugPoint.renderOrder = 10;
    this.updateDrawing();
  }

  updateDrawing(camera?: THREE.Camera): void {
    if (!this.materialMatchesStyle()) {
      this.material.dispose();
      this.material = this.createMaterial();
      this.line.material = this.material;
    }

    this.material.color.set(this.lineState.color);
    this.material.linewidth = this.lineState.thickness;

    if (this.material instanceof THREE.LineDashedMaterial) {
      this.material.dashSize = this.lineState.dashSize;
      this.material.gapSize = this.lineState.gapSize;
    }

    this.debugMaterial.color.set(this.lineState.color);
    this.debugPoint.visible = this.lineState.debugPointVisible;
    this.debugPoint.position.copy(this.lineState.getPointAt(this.lineState.debugT));
    this.updateDebugPointScale(camera);

    this.geometry.setFromPoints(this.lineState.virtual.getDrawPoints());

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

  private createMaterial(): GraphLineMaterial {
    if (this.lineState.style === "dashed") {
      return new THREE.LineDashedMaterial({
        color: this.lineState.color,
        dashSize: this.lineState.dashSize,
        gapSize: this.lineState.gapSize,
        linewidth: this.lineState.thickness,
      });
    }

    return new THREE.LineBasicMaterial({
      color: this.lineState.color,
      linewidth: this.lineState.thickness,
    });
  }

  private materialMatchesStyle(): boolean {
    return this.material.type === this.getMaterialType();
  }

  private getMaterialType(): string {
    return this.lineState.style === "dashed" ? "LineDashedMaterial" : "LineBasicMaterial";
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

  get segments(): number {
    const splineModifier = this.virtual.modifiers.find(
      (modifier): modifier is SplineModifier => modifier instanceof SplineModifier,
    );

    return splineModifier?.params.segments ?? DEFAULT_SEGMENTS;
  }

  set segments(segments: number) {
    for (const modifier of this.virtual.modifiers) {
      if (modifier instanceof SplineModifier) {
        modifier.params.segments = segments;
      }
    }
  }

  get smooth(): boolean {
    return this.virtual.modifiers.some(
      (modifier) => modifier instanceof SplineModifier && modifier.enabled,
    );
  }

  set smooth(smooth: boolean) {
    const splineModifier = this.virtual.modifiers.find(
      (modifier): modifier is SplineModifier => modifier instanceof SplineModifier,
    );

    if (splineModifier) {
      splineModifier.enabled = smooth;
      return;
    }

    if (smooth) {
      this.virtual.modifiers.push(new SplineModifier());
    }
  }

  getPointAt(t: number): THREE.Vector3 {
    return this.virtual.getPointAt(t);
  }

  getPointAtStep(step: number, steps: number): THREE.Vector3 {
    return this.virtual.getPointAtStep(step, steps);
  }

  updateDrawing(camera?: THREE.Camera): void {
    this.visual.updateDrawing(camera);
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

const _worldPosition = new THREE.Vector3();
