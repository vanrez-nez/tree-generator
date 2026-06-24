import * as THREE from "three";

export type RootInfluenceSample = {
  t: number;
  center: THREE.Vector3;
  direction: THREE.Vector3;
  weight: number;
};

export type TubeDeformContext = {
  point: THREE.Vector3;
  ringCenter: THREE.Vector3;
  rimDirection: THREE.Vector3;
  radius: number;
  t: number;
};

export type TubeDeformer = (context: TubeDeformContext) => THREE.Vector3;

const AXIAL_WIDTH = 0.08;
const DISPLACEMENT_SCALE = 0.65;

export function createRootInfluenceDeformer(
  samples: RootInfluenceSample[],
  amount: number,
): TubeDeformer | undefined {
  if (amount <= 0 || samples.length === 0) {
    return undefined;
  }

  const activeSamples = samples
    .filter((sample) => sample.weight > 0 && sample.direction.lengthSq() > 1e-12)
    .map((sample) => ({
      t: THREE.MathUtils.clamp(sample.t, 0, 1),
      direction: sample.direction.clone().normalize(),
      weight: THREE.MathUtils.clamp(sample.weight, 0, 1),
    }));

  if (activeSamples.length === 0) {
    return undefined;
  }

  return ({ rimDirection, radius, t }) => {
    const displacement = new THREE.Vector3();

    for (const sample of activeSamples) {
      const axial = smoothFalloff(Math.abs(t - sample.t) / AXIAL_WIDTH);
      if (axial <= 0) continue;

      const angular = Math.max(0, rimDirection.dot(sample.direction)) ** 2;
      if (angular <= 0) continue;

      const magnitude = amount * sample.weight * axial * angular * radius * DISPLACEMENT_SCALE;
      displacement.addScaledVector(sample.direction, magnitude);
    }

    return displacement;
  };
}

function smoothFalloff(x: number): number {
  const c = THREE.MathUtils.clamp(1 - x, 0, 1);
  return c * c * (3 - 2 * c);
}
