// Experimental 3D retargeting for one arm, from MediaPipe pose WORLD landmarks (metres) and hand landmarks.
//
// Why: the 2D path (drivePose in main.ts) only knows image-plane angles, so "in front of the body" is faked with
// the ArmSolver's bend-plane / half-space rules, palms are guessed from Kalidokit, and finger spread is lost.
// This module instead matches bone DIRECTIONS in 3D:
//   * upper arm  = minimal swing from the T-pose direction to (elbow - shoulder), plus a twist about its own axis
//   * forearm    = a pure hinge (one axis) whose twist-solution puts the bend plane where the three points say
//   * hand       = full orientation from a palm frame (wrist -> middle MCP, index MCP -> pinky MCP)
//   * fingers    = abduction (spread) angle of each finger about the palm normal
//
// Conventions (all derived in docs/avatar-3d.md):
//   MediaPipe pose/hand coordinates : x right in the raw image, y DOWN, z AWAY from camera (closer = smaller z)
//   avatar "bone space" (VRM 1)     : x = avatar's left, y up, z toward the viewer      (flip = -1)
//   VRM 0 bone space is that frame rotated 180 deg about Y                                (flip = +1)
//   => bone-space point = ( -flip*x, -y, flip*z )  - a proper rotation, so handedness is preserved.
//
// Pure math: no DOM, no VRM. Unit-tested in scripts/test-arm-ik.mjs.
import * as THREE from 'three';

const DEG = Math.PI / 180;
export type V3 = { x: number; y: number; z?: number };
export type Side = 'left' | 'right';

/** MediaPipe-style point -> avatar bone space (see header). */
export function toBoneSpace(p: V3, flip: 1 | -1, out = new THREE.Vector3()): THREE.Vector3 {
  return out.set(-flip * p.x, -p.y, flip * (p.z ?? 0));
}

/** Rest (T-pose) direction of the arm bones in bone space. */
export function bindDirection(side: Side, flip: 1 | -1): THREE.Vector3 {
  return new THREE.Vector3((side === 'left' ? 1 : -1) * -flip, 0, 0);
}

const wrapPi = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const smoothstep = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

export type ArmSolution = { upper: THREE.Quaternion; lower: THREE.Quaternion; flexionDeg: number; twistWeight: number; clamped: boolean };

export type ArmOptions = {
  side: Side;
  flip: 1 | -1;
  /** Hinge sign of the elbow flexion DOF in the rig (rig joint "<side>.elbow", axis must be z). */
  hingeSign: 1 | -1;
  /** Anatomical flexion range, degrees. */
  hingeRange: [number, number];
  /** Where the elbow should bend when the arm is nearly straight (twist is undetermined): degrees about the arm axis. */
  fallbackTwistDeg: number;
};

/**
 * Solve upper-arm and forearm local rotations (parent = shoulder frame, assumed aligned with the bone-space axes).
 * shoulder/elbow/wrist are in bone space.
 */
export function solveArm3D(shoulder: THREE.Vector3, elbow: THREE.Vector3, wrist: THREE.Vector3, o: ArmOptions): ArmSolution | undefined {
  const b = bindDirection(o.side, o.flip);
  const dU = elbow.clone().sub(shoulder), dF = wrist.clone().sub(elbow);
  if (dU.lengthSq() < 1e-9 || dF.lengthSq() < 1e-9) return undefined;
  dU.normalize(); dF.normalize();

  const swing = new THREE.Quaternion().setFromUnitVectors(b, dU);
  const d0 = dF.clone().applyQuaternion(swing.clone().invert());        // forearm direction in the swing frame
  const X = new THREE.Vector3(1, 0, 0), Z = new THREE.Vector3(0, 0, 1);

  // Twist about the arm axis so the forearm lies in the hinge (XY) plane: Rx(-t) d0 has z = 0  =>  t = atan2(z, y).
  const yz = Math.hypot(d0.y, d0.z);
  const tSolved = Math.atan2(d0.z, d0.y);
  const tFallback = -o.flip * o.fallbackTwistDeg * DEG;
  const weight = smoothstep(Math.sin(4 * DEG), Math.sin(14 * DEG), yz);  // near-straight arm: trust the fallback plane
  const flexOf = (t: number) => {
    const d1 = d0.clone().applyAxisAngle(X, -t);
    const phi = Math.atan2(d1.y * b.x, d1.x * b.x);
    return { phi, flexion: phi * o.flip * o.hingeSign };
  };
  let t = tFallback + wrapPi(tSolved - tFallback) * weight;
  if (flexOf(t).flexion < -8 * DEG) t = wrapPi(t + Math.PI);             // elbows do not hyper-extend: use the other plane
  const { flexion } = flexOf(t);
  const lo = o.hingeRange[0] * DEG, hi = o.hingeRange[1] * DEG;
  const flexClamped = Math.min(hi, Math.max(lo, flexion));
  const phi = flexClamped * o.flip * o.hingeSign;

  const upper = swing.clone().multiply(new THREE.Quaternion().setFromAxisAngle(X, t));
  const lower = new THREE.Quaternion().setFromAxisAngle(Z, phi);
  return { upper, lower, flexionDeg: flexClamped / DEG, twistWeight: weight, clamped: flexClamped !== flexion };
}

/** Palm frame from hand landmarks given in bone space: wrist(0), index MCP(5), middle MCP(9), pinky MCP(17). */
export function palmWorldRotation(wrist: THREE.Vector3, indexMcp: THREE.Vector3, middleMcp: THREE.Vector3, pinkyMcp: THREE.Vector3, o: { side: Side; flip: 1 | -1 }): THREE.Quaternion | undefined {
  const f = middleMcp.clone().sub(wrist);
  const p = pinkyMcp.clone().sub(indexMcp);
  if (f.lengthSq() < 1e-12 || p.lengthSq() < 1e-12) return undefined;
  f.normalize();
  const n = new THREE.Vector3().crossVectors(f, p);
  if (n.lengthSq() < 1e-10) return undefined;
  n.normalize();
  p.crossVectors(n, f).normalize();                                      // orthonormal: p = n x f  (so f x p = n)
  const target = new THREE.Matrix4().makeBasis(f, n, p);
  // Bind hand: fingers along the arm axis, palm down, index->pinky toward the back (bone-space z = flip).
  const bf = bindDirection(o.side, o.flip), bp = new THREE.Vector3(0, 0, o.flip);
  const bn = new THREE.Vector3().crossVectors(bf, bp).normalize();
  const bind = new THREE.Matrix4().makeBasis(bf, bn, bp);
  const m = target.multiply(bind.transpose());                            // Mt * Mb^-1
  return new THREE.Quaternion().setFromRotationMatrix(m);
}

/** Local hand rotation relative to the forearm, from a world (bone-space) palm rotation. */
export function localHand(palmWorld: THREE.Quaternion, upper: THREE.Quaternion, lower: THREE.Quaternion): THREE.Quaternion {
  const chain = upper.clone().multiply(lower);
  return chain.invert().multiply(palmWorld);
}

/**
 * Finger spread (abduction): signed angle, toward the pinky side, between a finger's proximal direction (MCP -> PIP)
 * and the middle finger's, measured in the palm plane. Radians; positive = toward the pinky.
 * All points in bone space; `palmNormal` is the palm's n from palmWorldRotation (f x p).
 */
export function fingerSpread(mcp: THREE.Vector3, pip: THREE.Vector3, wrist: THREE.Vector3, middleMcp: THREE.Vector3, indexMcp: THREE.Vector3, pinkyMcp: THREE.Vector3): number {
  const f = middleMcp.clone().sub(wrist).normalize();
  const p0 = pinkyMcp.clone().sub(indexMcp);
  const n = new THREE.Vector3().crossVectors(f, p0).normalize();
  const p = new THREE.Vector3().crossVectors(n, f).normalize();          // toward pinky, in the palm plane
  const d = pip.clone().sub(mcp);
  d.addScaledVector(n, -d.dot(n));                                        // project into the palm plane
  if (d.lengthSq() < 1e-12) return 0;
  d.normalize();
  return Math.atan2(d.dot(p), d.dot(f));
}

/** Rotation about bone-local Y that moves a finger toward the pinky by `sigma` (see derivation in docs/avatar-3d.md). */
export const spreadToYRotation = (sigma: number, side: Side) => (side === 'left' ? sigma : -sigma);
