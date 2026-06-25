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

// Full-float, NEAREST-filtered, wrapping target for JFA/flood-fill scratch. JFA stores exact seed
// coordinates per texel, so it must NOT interpolate (Nearest) and needs the precision (Float).
export function createFloatTarget(width: number, height: number): THREE.WebGLRenderTarget {
  return new THREE.WebGLRenderTarget(width, height, {
    depthBuffer: false,
    stencilBuffer: false,
    format: THREE.RGBAFormat,
    type: THREE.FloatType,
    colorSpace: THREE.NoColorSpace,
    magFilter: THREE.NearestFilter,
    minFilter: THREE.NearestFilter,
    wrapS: THREE.RepeatWrapping,
    wrapT: THREE.RepeatWrapping,
    generateMipmaps: false,
  });
}

// RGBA8 / Nearest / no color conversion — used as a readback target for PNG export so raw channel
// bytes round-trip straight to the file (sRGB basecolor stays sRGB; linear data stays linear).
export function createByteTarget(width: number, height: number): THREE.WebGLRenderTarget {
  return new THREE.WebGLRenderTarget(width, height, {
    depthBuffer: false,
    stencilBuffer: false,
    format: THREE.RGBAFormat,
    type: THREE.UnsignedByteType,
    colorSpace: THREE.NoColorSpace,
    magFilter: THREE.NearestFilter,
    minFilter: THREE.NearestFilter,
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
