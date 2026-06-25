import * as THREE from "three";

// Render-target factory for the material baker.
//
// Tiling is an invariant: every target wraps (RepeatWrapping). Color targets hold sRGB basecolor
// (RGBA8 is fine); data targets hold LINEAR, higher-precision working buffers (height/normal/AO) —
// 8-bit height staircases normals, so data buffers are half-float.

export function createColorTarget(width: number, height: number): THREE.WebGLRenderTarget {
  return new THREE.WebGLRenderTarget(width, height, {
    depthBuffer: false,
    stencilBuffer: false,
    format: THREE.RGBAFormat,
    type: THREE.UnsignedByteType,
    colorSpace: THREE.SRGBColorSpace,
    magFilter: THREE.LinearFilter,
    minFilter: THREE.LinearFilter,
    wrapS: THREE.RepeatWrapping,
    wrapT: THREE.RepeatWrapping,
    generateMipmaps: false,
  });
}

export function createDataTarget(width: number, height: number): THREE.WebGLRenderTarget {
  return new THREE.WebGLRenderTarget(width, height, {
    depthBuffer: false,
    stencilBuffer: false,
    format: THREE.RGBAFormat,
    type: THREE.HalfFloatType,
    colorSpace: THREE.NoColorSpace,
    magFilter: THREE.LinearFilter,
    minFilter: THREE.LinearFilter,
    wrapS: THREE.RepeatWrapping,
    wrapT: THREE.RepeatWrapping,
    generateMipmaps: false,
  });
}
