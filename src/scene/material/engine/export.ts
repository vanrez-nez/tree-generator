import * as THREE from "three";
import { FULLSCREEN_VERT } from "../glsl/noise";
import type { PassRunner } from "./pass-runner";
import { createByteTarget } from "./targets";

// PNG export for a baked channel. The channel may be sRGB (basecolor) or linear half-float
// (normal/AO/roughness); a raw copy pass into an RGBA8 NoColorSpace target preserves the stored
// bytes verbatim, then readback → flip Y (GL is bottom-up) → canvas → PNG download.

const copyMaterial = new THREE.ShaderMaterial({
  vertexShader: FULLSCREEN_VERT,
  fragmentShader: /* glsl */ `
    precision highp float;
    varying vec2 vUv;
    uniform sampler2D uTex;
    void main(){ gl_FragColor = texture2D(uTex, vUv); }
  `,
  uniforms: { uTex: { value: null } },
});

// Copy a channel texture into an RGBA8 target, read it back, and return top-down ImageData (GL is
// bottom-up, so rows are flipped). Shared by PNG export and the 2D texture preview.
export function renderChannelToImageData(
  runner: PassRunner,
  texture: THREE.Texture,
  width: number,
  height: number,
): ImageData {
  const target = createByteTarget(width, height);
  copyMaterial.uniforms.uTex.value = texture;
  runner.render(copyMaterial, target);

  const buffer = new Uint8Array(width * height * 4);
  runner.readback(target, buffer, width, height);
  target.dispose();

  const flipped = new Uint8ClampedArray(width * height * 4);
  const rowBytes = width * 4;
  for (let y = 0; y < height; y++) {
    const src = (height - 1 - y) * rowBytes;
    flipped.set(buffer.subarray(src, src + rowBytes), y * rowBytes);
  }
  return new ImageData(flipped, width, height);
}

export function downloadChannelPng(
  runner: PassRunner,
  texture: THREE.Texture,
  width: number,
  height: number,
  filename: string,
): void {
  const data = renderChannelToImageData(runner, texture, width, height);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return;
  }
  ctx.putImageData(data, 0, 0);
  canvas.toBlob((blob) => {
    if (!blob) {
      return;
    }
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    URL.revokeObjectURL(url);
  });
}
