import * as THREE from "three";
import type { GraphLine } from "./line";

export type JointOptions = {
  id: string;
  sourceLine: GraphLine;
  sourceT: number;
  targetLine: GraphLine;
  targetPointIndex: number;
};

export class Joint {
  readonly id: string;
  readonly sourceLine: GraphLine;
  readonly targetLine: GraphLine;
  readonly targetPointIndex: number;
  sourceT: number;

  constructor({
    id,
    sourceLine,
    sourceT,
    targetLine,
    targetPointIndex,
  }: JointOptions) {
    this.id = id;
    this.sourceLine = sourceLine;
    this.sourceT = sourceT;
    this.targetLine = targetLine;
    this.targetPointIndex = targetPointIndex;
  }

  resolve(): void {
    if (this.sourceLine === this.targetLine) {
      return;
    }

    const targetPoint = this.targetLine.points[this.targetPointIndex];

    if (!targetPoint) {
      return;
    }

    const sourcePoint = this.sourceLine.getPointAt(THREE.MathUtils.clamp(this.sourceT, 0, 1));
    const delta = sourcePoint.sub(targetPoint);

    this.targetLine.points = this.targetLine.points.map((point) => point.clone().add(delta));
  }
}
