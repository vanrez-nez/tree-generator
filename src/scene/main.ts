import * as THREE from "three";

export class MainScene {
  readonly scene = new THREE.Scene();
  private readonly material: THREE.MeshStandardMaterial;

  constructor(cubeColor: string) {
    this.scene.background = new THREE.Color(0x111111);

    const geometry = new THREE.BoxGeometry();
    this.material = new THREE.MeshStandardMaterial({ color: cubeColor });
    const cube = new THREE.Mesh(geometry, this.material);
    this.scene.add(cube);

    const light = new THREE.DirectionalLight(0xffffff, 3);
    light.position.set(2, 2, 3);
    this.scene.add(light);
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.8));
  }

  setCubeColor(color: string): void {
    this.material.color.set(color);
  }

  update(_deltaTime: number): void {
    // Scene update hook. Keep object transforms static until scene logic needs motion.
  }
}
