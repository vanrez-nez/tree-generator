import * as THREE from "three";
// Internal MIT-licensed subset copied from external/three-bvh-csg.
import { Brush } from "./internal/core/Brush";
import { Evaluator } from "./internal/core/Evaluator";
import { ADDITION } from "./internal/core/constants";

export type AdditionOptions = {
  attributes?: string[];
  useGroups?: boolean;
  target?: THREE.BufferGeometry;
};

const DEFAULT_ATTRIBUTES = ["position", "normal", "uv"];

export function addBufferGeometries(
  a: THREE.BufferGeometry,
  b: THREE.BufferGeometry,
  options: AdditionOptions = {},
): THREE.BufferGeometry {
  return addBrushes(
    new Brush(prepareGeometry(a, options.attributes)),
    new Brush(prepareGeometry(b, options.attributes)),
    options,
  );
}

export function addMeshes(
  a: THREE.Mesh,
  b: THREE.Mesh,
  options: AdditionOptions = {},
): THREE.BufferGeometry {
  a.updateMatrixWorld(true);
  b.updateMatrixWorld(true);

  const brushA = new Brush(prepareGeometry(a.geometry, options.attributes), a.material);
  const brushB = new Brush(prepareGeometry(b.geometry, options.attributes), b.material);
  brushA.matrixWorld.copy(a.matrixWorld);
  brushB.matrixWorld.copy(b.matrixWorld);
  brushA.matrix.copy(a.matrix);
  brushB.matrix.copy(b.matrix);

  return addBrushes(brushA, brushB, options);
}

function addBrushes(
  a: Brush,
  b: Brush,
  { attributes, useGroups = false, target }: AdditionOptions,
): THREE.BufferGeometry {
  const evaluator = new Evaluator();
  evaluator.attributes = resolveAttributes(a.geometry, b.geometry, attributes);
  evaluator.useGroups = useGroups;

  const targetBrush = new Brush(target ?? new THREE.BufferGeometry());
  const result = evaluator.evaluate(a, b, ADDITION, targetBrush);
  const geometry = result.geometry as THREE.BufferGeometry;

  if (!geometry.getAttribute("normal")) {
    geometry.computeVertexNormals();
  }
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();

  a.disposeCacheData();
  b.disposeCacheData();
  result.disposeCacheData?.();

  return geometry;
}

function prepareGeometry(
  geometry: THREE.BufferGeometry,
  requestedAttributes = DEFAULT_ATTRIBUTES,
): THREE.BufferGeometry {
  const clone = geometry.clone();

  if (requestedAttributes.includes("normal") && !clone.getAttribute("normal")) {
    clone.computeVertexNormals();
  }

  return clone;
}

function resolveAttributes(
  a: THREE.BufferGeometry,
  b: THREE.BufferGeometry,
  requestedAttributes = DEFAULT_ATTRIBUTES,
): string[] {
  return requestedAttributes.filter(
    (attribute) => a.getAttribute(attribute) && b.getAttribute(attribute),
  );
}
