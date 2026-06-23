import * as THREE from "three";

export type GraphLineStyle = "normal" | "dashed";

export type GraphLineOptions = {
  color?: THREE.ColorRepresentation;
  dashSize?: number;
  gapSize?: number;
  points?: THREE.Vector3[];
  style?: GraphLineStyle;
  thickness?: number;
};

type GraphLineMaterial = THREE.LineBasicMaterial | THREE.LineDashedMaterial;

export class GraphLine {
  color: THREE.ColorRepresentation;
  dashSize: number;
  gapSize: number;
  points: THREE.Vector3[];
  style: GraphLineStyle;
  thickness: number;

  readonly object: THREE.Line<THREE.BufferGeometry, GraphLineMaterial>;

  private readonly geometry = new THREE.BufferGeometry();
  private material: GraphLineMaterial;

  constructor({
    color = 0xffffff,
    dashSize = 0.2,
    gapSize = 0.1,
    points = [],
    style = "normal",
    thickness = 1,
  }: GraphLineOptions = {}) {
    this.color = color;
    this.dashSize = dashSize;
    this.gapSize = gapSize;
    this.points = points;
    this.style = style;
    this.thickness = thickness;
    this.material = this.createMaterial();
    this.object = new THREE.Line(this.geometry, this.material);
    this.updateDrawing();
  }

  updateDrawing(): void {
    if (!this.materialMatchesStyle()) {
      this.material.dispose();
      this.material = this.createMaterial();
      this.object.material = this.material;
    }

    this.material.color.set(this.color);
    this.material.linewidth = this.thickness;

    if (this.material instanceof THREE.LineDashedMaterial) {
      this.material.dashSize = this.dashSize;
      this.material.gapSize = this.gapSize;
    }

    this.geometry.setFromPoints(this.points);

    if (this.style === "dashed") {
      this.object.computeLineDistances();
    }
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }

  private createMaterial(): GraphLineMaterial {
    if (this.style === "dashed") {
      return new THREE.LineDashedMaterial({
        color: this.color,
        dashSize: this.dashSize,
        gapSize: this.gapSize,
        linewidth: this.thickness,
      });
    }

    return new THREE.LineBasicMaterial({
      color: this.color,
      linewidth: this.thickness,
    });
  }

  private materialMatchesStyle(): boolean {
    return (
      (this.style === "dashed" && this.material instanceof THREE.LineDashedMaterial) ||
      (this.style === "normal" && this.material instanceof THREE.LineBasicMaterial)
    );
  }
}
