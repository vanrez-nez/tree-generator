import * as THREE from "three";
import { getPolylinePointTs, type ResolvedLine } from "./resolved-line";

const DEBUG_POINT_RADIUS = 0.055;
const DEBUG_POINT_SCREEN_RADIUS = 0.0047;

export type LineDebugSyncOptions = {
  debugT: number;
  debugPointVisible: boolean;
  linePointsVisible: boolean;
  authoredPoints: readonly THREE.Vector3[];
  color: THREE.ColorRepresentation;
  camera?: THREE.Camera;
};

// Owns every debug/control dot mesh for a line: the single debug-T probe sphere and one marker per
// authored point. The ONLY way a dot is positioned is `resolved.pointAt`, and a dot is shown only when the
// line is `drawable` — so a dot is always a point on the drawn line, or hidden with it. There is no method
// to set a dot's world position directly; that is what makes "a dot off the line" unrepresentable.
export class LineDebugMarkers {
  readonly object = new THREE.Group();

  private readonly sphereGeometry = new THREE.SphereGeometry(DEBUG_POINT_RADIUS, 16, 12);
  private readonly debugMaterial = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    depthTest: false,
    depthWrite: false,
  });
  private readonly pointMaterial = new THREE.MeshBasicMaterial({
    color: 0xfff06a,
    depthTest: false,
    depthWrite: false,
  });
  private readonly debugPoint = new THREE.Mesh(this.sphereGeometry, this.debugMaterial);
  private readonly markers: THREE.Mesh[] = [];
  private readonly worldPosition = new THREE.Vector3();

  constructor() {
    this.debugPoint.renderOrder = 10;
    this.object.add(this.debugPoint);
  }

  // The only method that positions a dot. Reads the SAME `ResolvedLine` the fat-line geometry is built
  // from, so the dots and the line can never disagree. A dot whose line is not `drawable` is simply hidden
  // — no fabricated/validated position.
  sync(resolved: ResolvedLine, options: LineDebugSyncOptions): void {
    this.debugMaterial.color.set(options.color);

    const showDebugPoint = options.debugPointVisible && resolved.drawable;
    this.debugPoint.visible = showDebugPoint;
    if (showDebugPoint) {
      resolved.pointAt(options.debugT, this.debugPoint.position);
    }

    this.syncCount(options.authoredPoints.length);
    const pointTs = getPolylinePointTs(options.authoredPoints);
    for (let index = 0; index < this.markers.length; index += 1) {
      const marker = this.markers[index];
      const show = options.linePointsVisible && resolved.drawable;
      marker.visible = show;
      if (show) {
        resolved.pointAt(pointTs[index], marker.position);
      }
    }

    this.rescale(options.camera);
  }

  // Camera-only pass: hold the on-screen size of the dots the last `sync` placed. Never repositions.
  rescale(camera?: THREE.Camera): void {
    if (this.debugPoint.visible) {
      this.scaleMesh(this.debugPoint, camera);
    }
    for (const marker of this.markers) {
      if (marker.visible) {
        this.scaleMesh(marker, camera);
      }
    }
  }

  dispose(): void {
    this.object.clear();
    this.markers.length = 0;
    this.sphereGeometry.dispose();
    this.debugMaterial.dispose();
    this.pointMaterial.dispose();
  }

  private syncCount(count: number): void {
    while (this.markers.length < count) {
      const marker = new THREE.Mesh(this.sphereGeometry, this.pointMaterial);
      marker.renderOrder = 11;
      this.markers.push(marker);
      this.object.add(marker);
    }

    while (this.markers.length > count) {
      const marker = this.markers.pop();
      if (marker) {
        this.object.remove(marker);
      }
    }
  }

  // Keep a dot at a constant on-screen size regardless of camera distance/zoom (unchanged behavior, merged
  // from the former per-sphere and per-marker scalers).
  private scaleMesh(mesh: THREE.Mesh, camera?: THREE.Camera): void {
    if (!camera) {
      mesh.scale.setScalar(1);
      return;
    }

    if (camera instanceof THREE.PerspectiveCamera) {
      const distance = camera.position.distanceTo(mesh.getWorldPosition(this.worldPosition));
      const visibleHeight = 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) * distance;
      mesh.scale.setScalar((visibleHeight * DEBUG_POINT_SCREEN_RADIUS) / DEBUG_POINT_RADIUS);
      return;
    }

    if (camera instanceof THREE.OrthographicCamera) {
      const visibleHeight = (camera.top - camera.bottom) / camera.zoom;
      mesh.scale.setScalar((visibleHeight * DEBUG_POINT_SCREEN_RADIUS) / DEBUG_POINT_RADIUS);
      return;
    }

    mesh.scale.setScalar(1);
  }
}
