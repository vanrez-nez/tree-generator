import * as THREE from "three";
import type {
  GraphDocument,
  GraphLineDocument,
  JointDocument,
  ModifierDocument,
} from "./document";
import { Joint } from "./joint";
import { GraphLine, type GraphLineOptions } from "./line";
import type { LineModifier } from "./modifiers/modifier";
import { CoilModifier } from "./modifiers/coil";
import { GnarlModifier } from "./modifiers/gnarl";
import { SmoothModifier } from "./modifiers/smooth";
import { TwistModifier } from "./modifiers/twist";

export type GraphLineEntry = {
  id: string;
  line: GraphLine;
};

export type GraphJointEntry = {
  document: JointDocument;
  joint: Joint;
};

export class Graph {
  readonly group = new THREE.Group();

  private readonly lines = new Set<GraphLine>();
  private readonly lineEntries = new Map<string, GraphLine>();
  private readonly jointEntries: GraphJointEntry[] = [];

  loadDocument(document: GraphDocument): void {
    this.clear();

    for (const lineDocument of document.lines) {
      const line = this.addLine(createLineOptions(lineDocument));
      this.lineEntries.set(lineDocument.id, line);
    }

    for (const jointDocument of document.joints) {
      this.addJoint(jointDocument);
    }
  }

  addLine(lineOrOptions: GraphLine | GraphLineOptions = {}): GraphLine {
    const line =
      lineOrOptions instanceof GraphLine ? lineOrOptions : new GraphLine(lineOrOptions);

    this.lines.add(line);
    this.group.add(line.object);
    line.updateDrawing();

    return line;
  }

  addJoint(jointDocument: JointDocument): Joint | undefined {
    const parentLine = this.lineEntries.get(jointDocument.parentLineId);
    const childLine = this.lineEntries.get(jointDocument.childLineId);

    if (!parentLine || !childLine || parentLine === childLine) {
      return undefined;
    }

    if (!childLine.points[jointDocument.childPointIndex]) {
      return undefined;
    }

    const joint = new Joint({
      id: jointDocument.id,
      parentLine,
      parentT: jointDocument.parentT,
      childLine,
      childPointIndex: jointDocument.childPointIndex,
      maxLeanAngle: jointDocument.maxLeanAngle,
      directionPoints: jointDocument.directionPoints,
    });

    this.jointEntries.push({
      document: jointDocument,
      joint,
    });

    return joint;
  }

  removeJoint(joint: Joint): boolean {
    const index = this.jointEntries.findIndex((entry) => entry.joint === joint);

    if (index < 0) {
      return false;
    }

    this.jointEntries.splice(index, 1);

    return true;
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
    this.lineEntries.clear();
    this.jointEntries.length = 0;
  }

  getLines(): GraphLine[] {
    return [...this.lines];
  }

  getLineEntries(): GraphLineEntry[] {
    return [...this.lineEntries.entries()].map(([id, line]) => ({ id, line }));
  }

  getJointEntries(): GraphJointEntry[] {
    return [...this.jointEntries];
  }

  getLineById(id: string): GraphLine | undefined {
    return this.lineEntries.get(id);
  }

  update(camera: THREE.Camera, viewportSize?: THREE.Vector2): void {
    for (const { joint } of this.jointEntries) {
      joint.resolve();
    }

    for (const line of this.lines) {
      line.updateDrawing(camera, viewportSize);
    }
  }

  dispose(): void {
    this.clear();
  }
}

function createLineOptions(lineDocument: GraphLineDocument): GraphLineOptions {
  return {
    color: lineDocument.color,
    dashSize: lineDocument.dashSize,
    debugLinePointsVisible: lineDocument.debugLinePointsVisible,
    debugPointVisible: lineDocument.debugPointVisible,
    debugT: lineDocument.debugT,
    gapSize: lineDocument.gapSize,
    modifiers: lineDocument.modifiers?.map(createModifier) ?? [],
    points: lineDocument.points.map(
      ([x, y, z]) => new THREE.Vector3(x, y, z),
    ),
    style: lineDocument.style,
    thickness: lineDocument.thickness,
    tube: lineDocument.tube,
  };
}

function createModifier(modifierDocument: ModifierDocument): LineModifier {
  if (modifierDocument.type === "smooth") {
    return new SmoothModifier({
      ...modifierDocument.params,
      enabled: modifierDocument.enabled,
      envelope: modifierDocument.envelope,
    });
  }

  if (modifierDocument.type === "gnarl") {
    return new GnarlModifier({
      ...modifierDocument.params,
      enabled: modifierDocument.enabled,
      envelope: modifierDocument.envelope,
    });
  }

  if (modifierDocument.type === "twist") {
    return new TwistModifier({
      ...modifierDocument.params,
      enabled: modifierDocument.enabled,
      envelope: modifierDocument.envelope,
    });
  }

  return new CoilModifier({
    ...modifierDocument.params,
    enabled: modifierDocument.enabled,
    envelope: modifierDocument.envelope,
  });
}
