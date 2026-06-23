import * as THREE from "three";

export type LineModifier<TParams extends object = Record<string, unknown>> = {
  readonly name: string;
  enabled: boolean;
  params: TParams;
  apply: (points: THREE.Vector3[]) => THREE.Vector3[];
};

export type SeededModifierParams = {
  seed: number;
};
