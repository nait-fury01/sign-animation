// Semantic control layer: address the avatar by joint ("left.elbow") and movement ("flexion", degrees)
// instead of VRM bones and Euler angles. The VRM-specific knowledge lives in avatar-rig.json + VRMAdapter.
import type { VRM } from '@pixiv/three-vrm';
import { VRMAdapter } from './VRMAdapter';
import { PoseManager } from './PoseManager';
import { ArmSolver } from './ArmSolver';
import { mergeRigFiles, resolveRig, type DofDef, type JointDef, type ResolvedRig, type RigFile, type Side } from './rigConfig';

const PATCH_KEY = 'motionStudio.rigEdits.v1';

type Side2 = 'left' | 'right';
const DEG = Math.PI / 180;
export type Range = [number, number];
export type JointValues = Record<string, number>; // dof name -> degrees

export class SemanticJoint {
  constructor(readonly id: string, private def: JointDef, private rig: AvatarRig) {}

  get bone() { return this.def.bone; }
  get dofNames() { return Object.keys(this.def.dofs); }
  dof(name: string): DofDef | undefined { return this.def.dofs[name]; }
  getLimits(name: string): Range | undefined { return this.rig.limitOverrides.get(`${this.id}:${name}`) ?? this.def.dofs[name]?.limits; }
  /** Restrict a movement (degrees). Applied by set(); the raw drive() path used by live tracking is not limited here. */
  setLimits(name: string, range: Range | undefined) { if (range) this.rig.limitOverrides.set(`${this.id}:${name}`, range); else this.rig.limitOverrides.delete(`${this.id}:${name}`); }

  /** Pose the joint from semantic values (degrees). Movements you omit are set to 0. */
  set(values: JointValues, alpha = 1) {
    const raw = { x: 0, y: 0, z: 0 };
    for (const [name, def] of Object.entries(this.def.dofs)) {
      let v = values[name] ?? 0;
      const limits = this.getLimits(name);
      if (limits) v = Math.min(limits[1], Math.max(limits[0], v));
      raw[def.axis] += v * def.sign * DEG;
    }
    this.drive(raw.x, raw.y, raw.z, alpha);
  }
  /** Raw tracking-domain rotation (what Kalidokit / the retargeter produce), in radians. */
  drive(x: number, y: number, z: number, alpha: number) { this.rig.adapter.setEuler(this.def.bone, x, y, z, alpha); }

  getCurrentPose(): JointValues | undefined {
    const raw = this.rig.adapter.getEuler(this.def.bone); if (!raw) return undefined;
    return Object.fromEntries(Object.entries(this.def.dofs).map(([name, def]) => [name, (raw[def.axis] * def.sign) / DEG]));
  }
  getBindPose(): JointValues { return Object.fromEntries(this.dofNames.map((n) => [n, 0])); }
  getRestPose(): JointValues | undefined { return this.rig.poses.resolve(this.rig.poses.restName())[this.id]; }
  reset() { this.drive(0, 0, 0, 1); }
}

export class AvatarRig {
  readonly adapter = new VRMAdapter();
  readonly poses = new PoseManager(this);
  private baseFile: RigFile | undefined;            // public/avatar-rig.json
  /** Edits made in the rig editor (or via the console). Stored in this browser and layered on top of avatar-rig.json. */
  userPatch: RigFile = AvatarRig.loadPatch();
  private solver = new ArmSolver();
  /** 'rest': main.ts holds the avatar in its rest pose and pauses tracking; 'free': nothing is driven (test poses, joint probe); 'off': live. */
  editHold: 'off' | 'rest' | 'free' = 'off';
  private avatarKey: string | undefined;
  private joints = new Map<string, SemanticJoint>();
  /** Runtime limit overrides, keyed "joint:dof"; they survive config reloads and avatar switches. */
  readonly limitOverrides = new Map<string, Range>();
  config: ResolvedRig = resolveRig(undefined, undefined);

  constructor() { this.rebuild(); }

  private static loadPatch(): RigFile {
    try { const raw = localStorage.getItem(PATCH_KEY); return raw ? (JSON.parse(raw) as RigFile) : { version: 1 }; } catch { return { version: 1 }; }
  }
  /** Provide (or replace) the parsed avatar-rig.json. Safe to call before or after attach(). */
  configure(file: RigFile | undefined) { this.baseFile = file; this.rebuild(); }
  /** The file the editor shows and exports: avatar-rig.json with this browser's edits on top. */
  get file(): RigFile | undefined { return mergeRigFiles(this.baseFile, this.userPatch); }
  /** Edit the per-avatar (default) or shared layer of the saved edits; rebuilds and persists. */
  edit(scope: 'avatar' | 'all', change: (layer: NonNullable<RigFile['avatars']>[string]) => void) {
    if (scope === 'avatar' && this.avatarKey) { this.userPatch.avatars ??= {}; change(this.userPatch.avatars[this.avatarKey] ??= {}); }
    else change(this.userPatch);
    this.persist(); this.rebuild();
  }
  persist() { try { localStorage.setItem(PATCH_KEY, JSON.stringify(this.userPatch)); } catch { /* storage unavailable: edits last for this session */ } }
  /** Discard every saved edit and return to avatar-rig.json. */
  resetEdits() { this.userPatch = { version: 1 }; try { localStorage.removeItem(PATCH_KEY); } catch { /* ignore */ } this.rebuild(); }
  get avatar() { return this.avatarKey; }
  /** Re-resolve the configuration after userPatch was replaced. */
  reload() { this.rebuild(); }
  /** Attach a loaded VRM. `avatarKey` (the .vrm file name) selects per-avatar overrides in the config. */
  attach(vrm: VRM, avatarKey?: string) { this.avatarKey = avatarKey; this.adapter.attach(vrm); this.rebuild(); }
  get attached() { return this.adapter.vrm !== undefined; }

  private rebuild() {
    this.config = resolveRig(this.file, this.avatarKey);
    this.adapter.setFlipOverride(this.config.calibration.rotationFlip);
    this.joints = new Map(Object.entries(this.config.joints).map(([id, def]) => [id, new SemanticJoint(id, def, this)]));
  }

  joint(id: string): SemanticJoint {
    const j = this.joints.get(id);
    if (!j) throw new Error(`Unknown semantic joint "${id}". Known: ${[...this.joints.keys()].join(', ')}`);
    return j;
  }
  jointIds() { return [...this.joints.keys()]; }
  /** Live-tracking entry point: raw tracking-domain Euler (radians) for a semantic joint. Silently ignores unknown joints. */
  drive(id: string, x: number, y: number, z: number, alpha: number) { this.joints.get(id)?.drive(x, y, z, alpha); }

  /** Wrist roll (radians, raw domain) that turns the palm toward the stage camera for this avatar. */
  palmForwardRoll(side: Side) { return this.config.calibration.palmForwardRoll[side] * DEG; }

  /** Sides driven by the 3D solver (src/avatar/ArmIK3D.ts). The 2D ArmSolver's bend-plane/half-space rules would fight it, so it skips them. */
  readonly solved3d: Record<Side2, boolean> = { left: false, right: false };
  /** Run once per rendered frame: ease bones toward their targets, then run the 2D arm constraint solver. */
  update(dt = 1 / 60) {
    if (!this.attached) return;
    this.adapter.step(dt);
    for (const side of ['left', 'right'] as const) {
      if (this.solved3d[side]) continue;
      const elbow = this.joints.get(`${side}.elbow`);
      const dof = elbow?.dof('flexion'), range = elbow?.getLimits('flexion');
      this.solver.solve(this.adapter, side, this.config.frontConstraint, dof && range ? { axis: dof.axis, sign: dof.sign, range } : undefined);
    }
  }

  /** Hinge definition of an elbow, for the 3D solver. Undefined when the rig does not describe a single-axis z hinge. */
  elbowHinge(side: Side2): { sign: 1 | -1; range: [number, number] } | undefined {
    const j = this.joints.get(`${side}.elbow`); const dof = j?.dof('flexion'); const range = j?.getLimits('flexion');
    return dof && dof.axis === 'z' && range ? { sign: dof.sign, range } : undefined;
  }

  /** Back to the VRM's own bind pose. */
  resetPose() { this.adapter.resetPose(); }
}
