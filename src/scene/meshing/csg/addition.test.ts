import { describe, expect, it } from "vitest";
import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  InterleavedBuffer,
  InterleavedBufferAttribute,
  Mesh,
  Vector3,
} from "three";
import { addBufferGeometries, addMeshes } from "./addition";

describe("CSG addition", () => {
  it("adds disjoint boxes", () => {
    const a = new BoxGeometry(1, 1, 1);
    const b = new BoxGeometry(1, 1, 1);
    b.translate(2, 0, 0);

    const result = addBufferGeometries(a, b);

    expect(volumeOf(result)).toBeCloseTo(2, 5);
    expect(result.getAttribute("position").count).toBeGreaterThan(0);
    expect(result.index?.count).toBeGreaterThan(0);
  });

  it("unions overlapping boxes", () => {
    const a = new BoxGeometry(1, 1, 1);
    const b = new BoxGeometry(1, 1, 1);
    b.translate(0.5, 0, 0);

    const result = addBufferGeometries(a, b);
    const volume = volumeOf(result);

    expect(volume).toBeGreaterThan(1);
    expect(volume).toBeLessThan(2);
  });

  it("honors mesh transforms", () => {
    const a = new Mesh(new BoxGeometry(1, 1, 1));
    const b = new Mesh(new BoxGeometry(1, 1, 1));
    b.position.x = 2;
    a.updateMatrixWorld(true);
    b.updateMatrixWorld(true);

    const result = addMeshes(a, b);

    expect(volumeOf(result)).toBeCloseTo(2, 5);
  });

  it("preserves common normal and uv attributes", () => {
    const result = addBufferGeometries(new BoxGeometry(), new BoxGeometry());

    expect(result.getAttribute("position")).toBeDefined();
    expect(result.getAttribute("normal")).toBeDefined();
    expect(result.getAttribute("uv")).toBeDefined();
  });

  it("rejects interleaved attributes", () => {
    const interleaved = new InterleavedBuffer(new Float32Array([
      -0.5, -0.5, 0,
      0.5, -0.5, 0,
      0.5, 0.5, 0,
    ]), 3);
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new InterleavedBufferAttribute(interleaved, 3, 0));
    geometry.setIndex(new BufferAttribute(new Uint16Array([0, 1, 2]), 1));

    expect(() => addBufferGeometries(geometry, new BoxGeometry())).toThrow(
      /InterleavedBufferAttributes/,
    );
  });
});

function volumeOf(geometry: BufferGeometry): number {
  const position = geometry.getAttribute("position");
  const index = geometry.index;
  const a = new Vector3();
  const b = new Vector3();
  const c = new Vector3();
  let volume = 0;

  const triangleCount = index ? index.count / 3 : position.count / 3;
  for (let triangle = 0; triangle < triangleCount; triangle += 1) {
    const i0 = index ? index.getX(triangle * 3) : triangle * 3;
    const i1 = index ? index.getX(triangle * 3 + 1) : triangle * 3 + 1;
    const i2 = index ? index.getX(triangle * 3 + 2) : triangle * 3 + 2;
    a.fromBufferAttribute(position, i0);
    b.fromBufferAttribute(position, i1);
    c.fromBufferAttribute(position, i2);
    volume += a.dot(b.cross(c)) / 6;
  }

  return Math.abs(volume);
}
