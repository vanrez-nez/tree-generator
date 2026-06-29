import * as THREE from "three";
import type {
  GraphDocument,
  GraphLineDocument,
  JointDocument,
  ModifierDocument,
} from "./document";
import { FNV_OFFSET, hashFloat, hashInt, hashString } from "./hash";
import { Joint } from "./joint";
import { beginWorldFrame, GraphLine, type GraphLineOptions } from "./line";
import type { LineModifier } from "./modifiers/modifier";
import { CoilModifier } from "./modifiers/coil";
import { DiscAlignModifier } from "./modifiers/disc-align";
import { FootAlignModifier } from "./modifiers/foot-align";
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

  // Bumped whenever the set of lines/joints or their source points change (add/remove/load/clear). Source
  // points are otherwise immutable, so this lets `getInputSignature` detect structural/topology edits
  // without re-hashing every point each frame.
  private structureVersion = 0;

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
    this.structureVersion += 1;

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
    this.structureVersion += 1;

    return joint;
  }

  removeJoint(joint: Joint): boolean {
    const index = this.jointEntries.findIndex((entry) => entry.joint === joint);

    if (index < 0) {
      return false;
    }

    this.jointEntries.splice(index, 1);
    this.structureVersion += 1;

    return true;
  }

  removeLine(line: GraphLine): boolean {
    if (!this.lines.delete(line)) {
      return false;
    }

    this.group.remove(line.object);
    line.dispose();
    this.structureVersion += 1;

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
    this.structureVersion += 1;
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

  // A content hash of everything the mesher reads: each meshed line's drawn geometry (its
  // `geometryHash`, refreshed in `updateDrawing`) plus the joint wiring. Changes whenever the graph
  // changes, regardless of what caused it — so the mesher can rebuild off the graph, not UI events.
  // Iterates `getLineEntries()` (the id-keyed lines the mesher actually consumes).
  getGeometrySignature(): number {
    let hash = FNV_OFFSET;

    for (const { id, line } of this.getLineEntries()) {
      hash = hashString(hash, id);
      hash = hashInt(hash, line.geometryHash);
    }

    for (const { document } of this.jointEntries) {
      hash = hashString(hash, document.parentLineId);
      hash = hashString(hash, document.childLineId);
      hash = hashInt(hash, document.childPointIndex);
      hash = hashInt(hash, Math.round(document.parentT * 1e4));
    }

    return hash >>> 0;
  }

  // A cheap hash of every authored INPUT that `update()` reads (vs `getGeometrySignature`, which hashes the
  // resolved OUTPUT and so can only be computed after the expensive resolution). Lets the caller skip the
  // per-frame junction/drawing resolution entirely when nothing an edit could touch has changed — the graph
  // is camera/time-independent, so an idle frame (just orbiting) recomputes to the same geometry.
  //
  // Covers: structure/source points (via `structureVersion`); per-line render + debug fields and tube taper;
  // each modifier's enabled/params/envelope; each joint's lean/direction/attachment. If a new geometry-
  // affecting authored field is added, include it here or live edits to it won't take effect while idle.
  getInputSignature(): number {
    let hash = hashInt(FNV_OFFSET, this.structureVersion);

    for (const line of this.lines) {
      hash = hashString(
        hash,
        JSON.stringify([line.color, line.thickness, line.style, line.dashSize, line.gapSize]),
      );
      hash = hashInt(hash, line.debugPointVisible ? 1 : 0);
      hash = hashInt(hash, line.debugLinePointsVisible ? 1 : 0);
      hash = hashFloat(hash, line.debugT);

      const tube = line.tube;
      if (tube) {
        hash = hashInt(hash, tube.visible ? 1 : 0);
        hash = hashFloat(hash, tube.radius);
        hash = hashFloat(hash, tube.tipScale);
        hash = hashFloat(hash, tube.opacity);
        hash = hashString(hash, JSON.stringify(tube.curve));
      }

      for (const modifier of line.modifiers) {
        hash = hashInt(hash, modifier.enabled ? 1 : 0);
        hash = hashString(hash, JSON.stringify(modifier.params));
        hash = hashString(hash, JSON.stringify(modifier.envelope));
      }
    }

    for (const { joint, document } of this.jointEntries) {
      hash = hashFloat(hash, joint.maxLeanAngle);
      hash = hashInt(hash, Math.round(joint.directionPoints));
      hash = hashFloat(hash, document.parentT);
      hash = hashInt(hash, document.childPointIndex);
    }

    return hash >>> 0;
  }

  // Per-frame, camera-only refresh for when `update()` is skipped (geometry unchanged): keeps the debug
  // markers at a constant on-screen size as the camera moves. Cheap — no geometry/junction resolution.
  refreshCameraScale(camera: THREE.Camera): void {
    for (const line of this.lines) {
      line.refreshCameraScale(camera);
    }
  }

  // World points are resolved lazily and pull-based: a child reads its parent on demand, so parents
  // are always computed first and connectivity (`world[pivot] === parentAnchor`) holds by
  // construction — there is no per-frame mutation of line points to get out of order.
  update(camera: THREE.Camera, viewportSize?: THREE.Vector2): void {
    beginWorldFrame();

    // Junctions first (they pull final world points and set each child tube's parent-surface clip),
    // then draw — both reuse the per-frame world cache.
    for (const { joint } of this.jointEntries) {
      joint.resolveJunction();
    }

    for (const line of this.lines) {
      line.updateDrawing(camera, viewportSize);
    }

    if (import.meta.env.DEV) {
      this.assertConnected();
    }
  }

  // Dev-only guard on the structural invariant: every line's pivot equals its attachment anchor
  // (a point that is, by construction, on its parent). The re-base assembler makes this impossible
  // to fail, so a violation means someone reintroduced a code path that bypasses it.
  private assertConnected(): void {
    for (const { id, line } of this.getLineEntries()) {
      const { pivot, anchor } = line.attachment;
      const base = line.getDrawnPointForIndex(pivot);
      const target = anchor();
      const drift = base.distanceTo(target);
      if (drift > 1e-3) {
        console.error(
          `[graph] line ${id} detached from its anchor by ${drift.toFixed(4)}: base ${formatVec(base)} ≠ anchor ${formatVec(target)}`,
        );
      }
    }
  }

  dispose(): void {
    this.clear();
  }
}

function formatVec(v: THREE.Vector3): string {
  return `(${v.x.toFixed(3)}, ${v.y.toFixed(3)}, ${v.z.toFixed(3)})`;
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

  if (modifierDocument.type === "coil") {
    return new CoilModifier({
      ...modifierDocument.params,
      enabled: modifierDocument.enabled,
      envelope: modifierDocument.envelope,
    });
  }

  if (modifierDocument.type === "footAlign") {
    return new FootAlignModifier({
      ...modifierDocument.params,
      enabled: modifierDocument.enabled,
      envelope: modifierDocument.envelope,
    });
  }

  return new DiscAlignModifier({
    ...modifierDocument.params,
    enabled: modifierDocument.enabled,
    envelope: modifierDocument.envelope,
  });
}
