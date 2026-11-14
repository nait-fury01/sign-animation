// Phase 3 constraint solver for one arm (upper arm -> forearm -> hand).
//
// The retargeter commands each arm bone separately from 2D image angles. The solver runs once per frame
// AFTER those commands and before rendering, reading the commanded rotations and writing corrected node
// rotations. It never changes the commanded values, so it can be switched off live and tracking stays
// numerically identical when it is disabled.
//
// Rules, in order:
//   1. Elbow hinge limit      - clamp the elbow flexion to the semantic joint limit.
//   2. Bend plane             - twist the upper arm about its own axis so the elbow bends toward the FRONT of
//                               the body instead of sideways in the image plane.
//   3. Front half-space       - the upper arm and forearm may not point behind the shoulder plane
//                               (minus a configurable tolerance); offenders are swung forward by the minimum angle.
//   4. Palm preservation      - the hand is counter-rotated so its orientation in space stays what was tracked
//                               (palm direction and handshape orientation carry meaning in sign language).
//
// Bone lengths cannot be violated here because only rotations are changed and the VRM skeleton is rigid.
import * as THREE from 'three';
import type { VRMAdapter } from './VRMAdapter';
import type { FrontConstraint } from './rigConfig';

const DEG = Math.PI / 180;
export type ElbowHinge = { axis: 'x' | 'y' | 'z'; sign: 1 | -1; range: [number, number] };

export class ArmSolver {
  private qu = new THREE.Quaternion(); private qf = new THREE.Quaternion(); private qh = new THREE.Quaternion();
  private chain0 = new THREE.Quaternion(); private chain1 = new THREE.Quaternion();
  private twist = new THREE.Quaternion(); private r = new THREE.Quaternion(); private tmp = new THREE.Quaternion();
  private euler = new THREE.Euler(0, 0, 0, 'XYZ');
  private fwd = new THREE.Vector3(); private bindDir = new THREE.Vector3(); private d = new THREE.Vector3(); private axis = new THREE.Vector3();
  private readonly X = new THREE.Vector3(1, 0, 0);

  /** Swing `world` (a rotation in the parent frame) so the bone direction has forward component >= sin(minDeg). Returns the correction or undefined. */
  private forwardCorrection(world: THREE.Quaternion, minDeg: number): THREE.Quaternion | undefined {
    this.d.copy(this.bindDir).applyQuaternion(world);
    const dot = THREE.MathUtils.clamp(this.d.dot(this.fwd), -1, 1);
    const threshold = Math.sin(minDeg * DEG);
    if (dot >= threshold) return undefined;
    const angle = Math.acos(dot) - Math.acos(threshold);
    this.axis.crossVectors(this.d, this.fwd);
    if (this.axis.lengthSq() < 1e-10) this.axis.set(0, 1, 0); else this.axis.normalize();
    return this.r.setFromAxisAngle(this.axis, angle);
  }

  solve(adapter: VRMAdapter, side: 'left' | 'right', fc: FrontConstraint, hinge?: ElbowHinge) {
    const upperBone = `${side}UpperArm`, lowerBone = `${side}LowerArm`, handBone = `${side}Hand`;
    const cu = adapter.commandedQuat(upperBone), cf = adapter.commandedQuat(lowerBone), ch = adapter.commandedQuat(handBone);
    if (!cu && !cf && !ch) return;
    const flip = adapter.flip;
    this.qu.copy(cu ?? this.tmp.identity()); this.qf.copy(cf ?? this.tmp.identity()); this.qh.copy(ch ?? this.tmp.identity());
    this.chain0.copy(this.qu).multiply(this.qf); // where the hand's parent chain was commanded to be
    let changed = false;

    // 1. Elbow hinge limit (semantic flexion degrees -> raw axis angle, same conversion as SemanticJoint).
    if (hinge && cf) {
      this.euler.setFromQuaternion(this.qf, 'XYZ');
      const flexion = (this.euler[hinge.axis] * flip * hinge.sign) / DEG;
      const clamped = Math.min(hinge.range[1], Math.max(hinge.range[0], flexion));
      if (clamped !== flexion) { this.euler[hinge.axis] = clamped * DEG * hinge.sign * flip; this.qf.setFromEuler(this.euler); changed = true; }
    }

    if (fc.enabled) {
      // VRM 1 normalized bones face +Z, VRM 0 faces -Z (flip = -1 / +1). The left arm points along +X for VRM 1, -X for VRM 0.
      this.fwd.set(0, 0, -flip);
      this.bindDir.set((side === 'left' ? 1 : -1) * -flip, 0, 0);

      // 2. Bend plane: twist the upper arm about its own long axis. Rz(raw) * Rx(t): the forearm's bend direction is
      //    rotated from "up in the image plane" toward "forward". t = -flip * bendPlane (derived and checked in docs/avatar-rig.md).
      if (fc.bendPlane > 0) { this.twist.setFromAxisAngle(this.X, -flip * fc.bendPlane * DEG); this.qu.multiply(this.twist); changed = true; }

      // 3. Front half-space for the upper arm, then the forearm (expressed in the upper arm's final frame).
      const upperFix = this.forwardCorrection(this.qu, fc.upperArmMinForward);
      if (upperFix) { this.qu.premultiply(upperFix); changed = true; }
      this.tmp.copy(this.qu).multiply(this.qf);
      const foreFix = this.forwardCorrection(this.tmp, fc.forearmMinForward);
      if (foreFix) {
        // new forearm parent-frame rotation = foreFix * (qu * qf);  qf' = qu^-1 * foreFix * qu * qf
        this.tmp.premultiply(foreFix);
        this.qf.copy(this.qu).invert().multiply(this.tmp);
        changed = true;
      }
    }
    if (!changed) { // nothing to correct: leave the nodes exactly as the retargeter wrote them
      return;
    }

    // 4. Keep the hand where it was commanded in space: qh' = (qu*qf)^-1 * chain0 * qh, blended by keepPalmOrientation.
    this.chain1.copy(this.qu).multiply(this.qf);
    adapter.writeQuat(upperBone, this.qu);
    adapter.writeQuat(lowerBone, this.qf);
    if (ch) {
      this.tmp.copy(this.chain1).invert().multiply(this.chain0).multiply(this.qh);
      const k = THREE.MathUtils.clamp(fc.keepPalmOrientation, 0, 1);
      adapter.writeQuat(handBone, k >= 1 ? this.tmp : this.qh.slerp(this.tmp, k));
    }
  }
}
