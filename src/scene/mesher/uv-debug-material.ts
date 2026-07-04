import { DoubleSide } from "three";
import { MeshBasicNodeMaterial } from "three/webgpu";
import { floor, mix, mod, uv, vec3 } from "three/tsl";

export function createUvDebugMaterial(): MeshBasicNodeMaterial {
  const material = new MeshBasicNodeMaterial({
    side: DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  });

  const uvNode = uv();
  const checker = mod(floor(uvNode.x.mul(16)).add(floor(uvNode.y.mul(16))), 2);
  const gradient = vec3(uvNode.x, uvNode.y, 0);
  material.colorNode = mix(gradient.mul(0.45), gradient, checker);

  return material;
}
