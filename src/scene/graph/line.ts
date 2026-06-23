import * as THREE from "three";

export type GraphLineStyle = "normal" | "dashed";

export type GraphLineOptions = {
  color?: THREE.ColorRepresentation;
  dashSize?: number;
  debugPointVisible?: boolean;
  debugT?: number;
  gapSize?: number;
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
  points: THREE.Vector3[];
  segments: number;
  smooth: boolean;

  constructor({
    points = [],
    segments = DEFAULT_SEGMENTS,
    smooth = false,
  }: Pick<GraphLineOptions, "points" | "segments" | "smooth"> = {}) {
    this.points = points;
    this.segments = segments;
    this.smooth = smooth;
  }

  getPointAt(t: number): THREE.Vector3 {
    const normalizedT = clamp01(t);

    if (this.points.length === 0) {
      return new THREE.Vector3();
    }

    if (this.points.length === 1) {
      return this.points[0].clone();
    }

    if (this.smooth && this.points.length > 2) {
      return new THREE.CatmullRomCurve3(this.points).getPoint(normalizedT);
    }

    return this.getLinearPointAt(normalizedT);
  }

  getPointAtStep(step: number, steps: number): THREE.Vector3 {
    if (steps <= 0) {
      return this.getPointAt(0);
    }

    return this.getPointAt(step / steps);
  }

  getDrawPoints(): THREE.Vector3[] {
    if (this.points.length <= 1) {
      return this.points.map((point) => point.clone());
    }

    const steps = Math.max(1, Math.floor(this.segments));
    const drawPoints: THREE.Vector3[] = [];

    for (let step = 0; step <= steps; step += 1) {
      drawPoints.push(this.getPointAtStep(step, steps));
    }

    return drawPoints;
  }

  private getLinearPointAt(t: number): THREE.Vector3 {
    const segmentCount = this.points.length - 1;
    const scaledT = t * segmentCount;
    const segmentIndex = Math.min(Math.floor(scaledT), segmentCount - 1);
    const segmentT = scaledT - segmentIndex;
    const start = this.points[segmentIndex];
    const end = this.points[segmentIndex + 1];

    return start.clone().lerp(end, segmentT);
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
    this.virtual = new VirtualLine({ points, segments, smooth });
    this.visual = new GraphLineVisual(this);
    this.object = this.visual.object;
  }

  get points(): THREE.Vector3[] {
    return this.virtual.points;
  }

  set points(points: THREE.Vector3[]) {
    this.virtual.points = points;
  }

  get segments(): number {
    return this.virtual.segments;
  }

  set segments(segments: number) {
    this.virtual.segments = segments;
  }

  get smooth(): boolean {
    return this.virtual.smooth;
  }

  set smooth(smooth: boolean) {
    this.virtual.smooth = smooth;
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

const _worldPosition = new THREE.Vector3();
