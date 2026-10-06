// three.js ships no types of its own, and @types/three pulls in a physics
// engine, a tween library and WebXR typings for a handful of classes. The 3D
// blocks (components/blocks/three/) use a small surface — Scene, a camera,
// lights, a few geometries and materials, a raycaster — typed at the call
// sites instead.
declare module "three";
