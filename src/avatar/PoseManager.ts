// Named poses in semantic terms (degrees). Presets: bind, idle, signing-neutral, custom (captured) ...
import type { AvatarRig, JointValues } from './AvatarRig';
import { mergePose, type PoseDef, type Side, type SidePose } from './rigConfig';

const DEG = Math.PI / 180;
export type JointPoseMap = Record<string, JointValues>; // joint id -> dof -> degrees
export type Range = [number, number];
/** Per-arm tracking limits (radians), the same shape as constraints.json `arms.Left|Right`. */
export type TrackedArmLimits = { upperRotation: Range; elbowFlex: Range };
/** constraints.json `neutral`, used to derive the 'signing-neutral' pose when avatar-rig.json doesn't define one. */
export type LegacyNeutral = { enabled: boolean; Left: { upperRotation: number; elbowFlex: number }; Right: { upperRotation: number; elbowFlex: number } };
export type ApplyOptions = { sides?: Side[]; alpha?: number; limits?: Partial<Record<Side, TrackedArmLimits>> };

const clamp = (v: number, [lo, hi]: Range) => Math.min(hi, Math.max(lo, v));
const jid = (side: Side, part: string) => `${side.toLowerCase()}.${part}`;
const round = (v: number, digits = 4) => Math.round(v * 10 ** digits) / 10 ** digits;

export class PoseManager {
  legacyNeutral: LegacyNeutral | undefined;
  /** Poses created at runtime with capture()/save(). They shadow config poses of the same name. */
  readonly custom = new Map<string, PoseDef>();
  constructor(private rig: AvatarRig) {}

  names(): string[] { return [...new Set([...Object.keys(this.rig.config.poses), ...this.custom.keys(), ...(this.legacyNeutral ? ['signing-neutral'] : [])])]; }

  get(name: string): PoseDef | undefined {
    const configured = this.rig.config.poses[name];
    const custom = this.custom.get(name);
    if (custom) return mergePose(configured, custom);
    if (configured) return configured;
    if (name === 'signing-neutral' && this.legacyNeutral) return this.fromLegacyNeutral(this.legacyNeutral);
    return undefined;
  }

  /** Pose the avatar returns to when tracking drops: config `runtimeRest`, else constraints.json `neutral.enabled`. */
  restName(): string {
    const configured = this.rig.config.runtimeRest;
    if (configured && this.get(configured)) return configured;
    return this.legacyNeutral?.enabled && this.get('signing-neutral') ? 'signing-neutral' : 'idle';
  }
  restLabel(): string { const n = this.restName(); return this.get(n)?.label ?? n; }

  private fromLegacyNeutral(n: LegacyNeutral): PoseDef {
    const side = (s: Side): SidePose => ({
      upperArm: { lowering: (s === 'Left' ? 1 : -1) * n[s].upperRotation / DEG },
      elbow: { flexion: n[s].elbowFlex / DEG },
      wrist: { palm: 'forward', roll: 0 },
    });
    return { label: 'Neutral pose', description: 'Derived from constraints.json neutral.', blend: 0.3, clampToTrackingLimits: true, Left: side('Left'), Right: side('Right') };
  }

  /** Resolve a pose to semantic joint values (degrees), expanding wrist palm orientation using the avatar calibration. */
  resolve(name: string, sides: Side[] = ['Left', 'Right']): JointPoseMap {
    const pose = this.get(name); const out: JointPoseMap = {};
    if (!pose) return out;
    for (const side of sides) {
      const p = pose[side]; if (!p) continue;
      if (p.upperArm?.lowering !== undefined) out[jid(side, 'upperArm')] = { lowering: p.upperArm.lowering };
      if (p.elbow?.flexion !== undefined) out[jid(side, 'elbow')] = { flexion: p.elbow.flexion };
      if (p.wrist) out[jid(side, 'wrist')] = { roll: (p.wrist.palm === 'down' ? 0 : this.rig.config.calibration.palmForwardRoll[side]) + (p.wrist.roll ?? 0) };
    }
    return out;
  }

  /** Move the avatar toward a named pose. Returns false if the pose (or the avatar) isn't available. */
  apply(name: string, opts: ApplyOptions = {}): boolean {
    const pose = this.get(name);
    if (!pose || !this.rig.attached) return false;
    const alpha = opts.alpha ?? pose.blend ?? 0.3;
    for (const side of opts.sides ?? (['Left', 'Right'] as Side[])) {
      const values = this.resolve(name, [side]);
      const limits = pose.clampToTrackingLimits ? opts.limits?.[side] : undefined;
      for (const [id, v] of Object.entries(values)) {
        const joint = this.rig.joint(id);
        if (limits && 'lowering' in v) { // tracking limits are raw radians; lowering = raw * sign
          const sign = joint.dof('lowering')?.sign ?? 1;
          const raw = clamp(v.lowering * sign * DEG, limits.upperRotation);
          v.lowering = (raw * sign) / DEG;
        }
        if (limits && 'flexion' in v) v.flexion = clamp(v.flexion * DEG, limits.elbowFlex) / DEG;
        joint.set(v, alpha);
      }
    }
    return true;
  }

  /** Read the avatar's current arm pose back into semantic form (palm orientation is inferred from the wrist roll). */
  capture(): PoseDef {
    const pose: PoseDef = {};
    for (const side of ['Left', 'Right'] as Side[]) {
      const sp: SidePose = {};
      const upper = this.rig.joint(jid(side, 'upperArm')).getCurrentPose();
      const elbow = this.rig.joint(jid(side, 'elbow')).getCurrentPose();
      const wrist = this.rig.joint(jid(side, 'wrist')).getCurrentPose();
      if (upper) sp.upperArm = { lowering: round(upper.lowering) };
      if (elbow) sp.elbow = { flexion: round(elbow.flexion) };
      if (wrist) {
        const forward = this.rig.config.calibration.palmForwardRoll[side];
        const palm = Math.abs(wrist.roll - forward) <= Math.abs(wrist.roll) ? 'forward' : 'down';
        sp.wrist = { palm, roll: round(wrist.roll - (palm === 'forward' ? forward : 0)) };
      }
      pose[side] = sp;
    }
    return pose;
  }

  /** Capture the avatar's current pose and store it as a named preset (in memory). */
  save(name: string, extra: Partial<PoseDef> = {}): PoseDef {
    const pose: PoseDef = { label: name, blend: 0.3, ...extra, ...this.capture() };
    this.custom.set(name, pose);
    return pose;
  }

  /** JSON you can paste into the "poses" block of avatar-rig.json. */
  exportJSON(names: string[] = [...this.custom.keys()]): string {
    const poses: Record<string, PoseDef> = {};
    for (const n of names) { const p = this.get(n); if (p) poses[n] = p; }
    return JSON.stringify({ poses }, null, 2);
  }
}
