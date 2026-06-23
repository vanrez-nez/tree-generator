import * as THREE from "three";
import { GraphLine, type GraphLineOptions } from "./line";

export class Graph {
  readonly group = new THREE.Group();

  private readonly lines = new Set<GraphLine>();

  addLine(lineOrOptions: GraphLine | GraphLineOptions = {}): GraphLine {
    const line =
      lineOrOptions instanceof GraphLine ? lineOrOptions : new GraphLine(lineOrOptions);

    this.lines.add(line);
    this.group.add(line.object);
    line.updateDrawing();

    return line;
  }

  removeLine(line: GraphLine): boolean {
    if (!this.lines.delete(line)) {
      return false;
    }

    this.group.remove(line.object);
    line.dispose();

    return true;
  }

  clear(): void {
    for (const line of this.lines) {
      this.group.remove(line.object);
      line.dispose();
    }

    this.lines.clear();
  }

  getLines(): GraphLine[] {
    return [...this.lines];
  }

  update(): void {
    for (const line of this.lines) {
      line.updateDrawing();
    }
  }

  dispose(): void {
    this.clear();
  }
}
