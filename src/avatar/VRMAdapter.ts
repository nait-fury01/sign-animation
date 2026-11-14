// The only module that touches VRM humanoid bones. Everything above it speaks in semantic joints.
import * as THREE from 'three';
import type { VRM } from '@pixiv/three-vrm';

export type RawEuler = { x: number; y: number; z: number };

export class VRMAdapter {
  vrm?: VRM;
  private flipOverride: 'auto' | 1 | -1 = 'auto';
  private smoothed = new Map<string, THREE.Quaternion>();
  private targets = new Map<string, { q: THREE.Quaternion; alpha: number }>();
  private targetQuat = new THREE.Quaternion();
  private euler = new THREE.Euler(0, 0, 0, 'XYZ');

  attach(vrm: VRM) { this.vrm = vrm; this.clearSmoothing(); }
  setFlipOverride(value: 'auto' | 1 | -1) { this.flipOverride = value; }
  /** Kalidokit-domain X/Z rotations are mirrored for VRM 1.x avatars (VRM 0.x is rotated by rotateVRM0). */
  get flip(): 1 | -1 {
    if (this.flipOverride !== 'auto') return this.flipOverride;
    return this.vrm?.meta.metaVersion === '0' ? 1 : -1;
  }

  node(bone: string): THREE.Object3D | null { return this.vrm?.humanoid.getNormalizedBoneNode(bone as never) ?? null; }
  hasBone(bone: string) { return this.node(bone) !== null; }
  availableBones(): string[] { return this.vrm ? Object.keys(this.vrm.humanoid.humanBones as Record<string, unknown>) : []; }

  /** Set the target for a bone from a raw tracking-domain Euler (flip applied here). Easing happens in step(). */
  setEuler(bone: string, x: number, y: number, z: number, alpha: number) {
    if (![x, y, z].every(Number.isFinite)) return;
    this.setTarget(bone, this.targetQuat.setFromEuler(this.euler.set(x * this.flip, y, z * this.flip, 'XYZ')), alpha);
  }

  /**
   * Set a bone's target rotation. `alpha` keeps its historical meaning - the fraction moved per 1/30 s tick -
   * but is converted to a time constant, so smoothing no longer depends on how often tracking delivers frames
   * (this app runs the detectors round-robin and the display at the full refresh rate). alpha >= 1 applies at once.
   */
  setTarget(bone: string, q: THREE.Quaternion, alpha: number) {
    const node = this.node(bone); if (!node) return;
    let value = this.smoothed.get(bone);
    if (!value) { value = node.quaternion.clone(); this.smoothed.set(bone, value); }
    if (alpha >= 1) { value.copy(q); node.quaternion.copy(value); this.targets.delete(bone); return; }
    const t = this.targets.get(bone);
    if (t) { t.q.copy(q); t.alpha = alpha; } else this.targets.set(bone, { q: q.clone(), alpha });
  }

  /** Ease every driven bone toward its target. Call once per rendered frame with the real elapsed seconds. */
  step(dt: number) {
    if (!(dt > 0)) return;
    const d = Math.min(dt, 0.1);
    for (const [bone, t] of this.targets) {
      const node = this.node(bone); const value = this.smoothed.get(bone);
      if (!node || !value) continue;
      const rate = -Math.log(1 - Math.min(0.999, Math.max(1e-3, t.alpha))) * 30; // 1/s
      value.slerp(t.q, 1 - Math.exp(-rate * d));
      node.quaternion.copy(value);
    }
  }

  /** Current bone rotation expressed in the same raw domain that setEuler() accepts. */
  getEuler(bone: string): RawEuler | undefined {
    const node = this.node(bone); if (!node) return undefined;
    // Read the tracked/commanded rotation, not the node: the arm solver may have post-processed the node.
    this.euler.setFromQuaternion(this.smoothed.get(bone) ?? node.quaternion, 'XYZ');
    return { x: this.euler.x * this.flip, y: this.euler.y, z: this.euler.z * this.flip };
  }

  /** The commanded (pre-solver) rotation of a bone, or undefined if it has not been driven since the last reset. */
  commandedQuat(bone: string): THREE.Quaternion | undefined { return this.smoothed.get(bone); }
  /** Overwrite the node rotation (used by the arm solver; the commanded rotation is untouched). */
  writeQuat(bone: string, q: THREE.Quaternion) { this.node(bone)?.quaternion.copy(q); }

  clearSmoothing() { this.smoothed.clear(); this.targets.clear(); }
  resetPose() { this.vrm?.humanoid.resetNormalizedPose(); this.clearSmoothing(); }
}
