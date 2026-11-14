# Avatar rig layer (semantic control)

`src/avatar/` sits between the retargeter in `src/main.ts` and the VRM skeleton. The retargeter says *which joint* and *how far*; the rig decides *which bone, which axis, which sign*.

```text
main.ts (tracking + constraints.json)  ->  AvatarRig  ->  VRMAdapter  ->  VRM normalized bones
                                              ^
                              public/avatar-rig.json (poses + calibration)
```

| File | Responsibility |
| --- | --- |
| `src/avatar/VRMAdapter.ts` | The only code that touches VRM bones: smoothing (slerp), VRM 0/1 axis flip, bind-pose reset. |
| `src/avatar/AvatarRig.ts` | `SemanticJoint` (`set`, `getCurrentPose`, `getRestPose`, `setLimits`, `reset`, `drive`) and `AvatarRig` (`joint(id)`, `configure`, `attach`). |
| `src/avatar/PoseManager.ts` | Named poses: `apply`, `resolve`, `capture`, `save`, `exportJSON`, `restName`. |
| `src/avatar/rigConfig.ts` | Schema, defaults, validation (warnings in the console), per-avatar merging. |
| `src/avatar/ArmSolver.ts` | Phase 3 constraint solver, run once per frame: elbow hinge limit, bend plane, front half-space, palm preservation. |
| `src/editor/RigEditor.ts` | Phase 5 in-app editor (⚙ / **E**). See `docs/rig-editor.md`. |
| `public/avatar-rig.json` | Your editable rest poses, calibration and per-avatar overrides. |

## Changing the signing-neutral pose without touching code

Edit `public/avatar-rig.json` and reload. Values are degrees:

```json
"poses": {
  "signing-neutral": {
    "blend": 0.3,
    "clampToTrackingLimits": true,
    "Left": {
      "upperArm": { "lowering": 33.78 },
      "elbow":    { "flexion": 85.57 },
      "wrist":    { "palm": "forward", "roll": 0 }
    },
    "Right": { "...": "..." }
  }
}
```

| Field | Meaning |
| --- | --- |
| `upperArm.lowering` | 0 = bind pose; positive swings the arm down toward the body (same sign for both sides). |
| `elbow.flexion` | 0 = straight; positive bends the elbow (same sign for both sides). |
| `wrist.palm` | `"forward"` (toward the stage camera) or `"down"` (raw bind orientation). |
| `wrist.roll` | Extra roll in degrees on top of `palm`. |
| `blend` | Smoothing factor 0-1 used when the pose is applied (higher = faster). |
| `clampToTrackingLimits` | Clamp to the `constraints.json` arm ranges (what the old neutral fallback did). |
| `runtimeRest` | Which pose the avatar returns to when tracking drops. If absent, `constraints.json` `neutral.enabled` picks `signing-neutral` or `idle`. |

Built-in presets: `bind` (the VRM's own pose) and `idle` (arms at sides). If `signing-neutral` is not defined in the JSON it is derived from `constraints.json` `neutral`, so older setups keep working.

Until the camera is enabled the avatar now shows the runtime rest pose, so edits are visible immediately. The reset button (↺) still returns to the bind pose.

## Calibrating a different VRM

`calibration` holds facts about a skeleton: `rotationFlip` (`"auto"`, `1` or `-1`) and `palmForwardRoll` (degrees of wrist roll that turns the palm toward the camera; the bundled avatars use -90 / +90). Settings under `avatars["<file>.vrm"]` override the file-level ones for that avatar only, including individual poses:

```json
"avatars": {
  "my_other_avatar.vrm": {
    "calibration": { "palmForwardRoll": { "Left": -80, "Right": 80 } },
    "poses": { "signing-neutral": { "Left": { "elbow": { "flexion": 70 } } } }
  }
}
```

The `joints` block (semantic joint -> bone, axis, sign, optional degree limits) can also be overridden. Axes only exist for movements that have been verified on the bundled rigs (`lowering`, `flexion`, `roll`, head `pitch/yaw/roll`, `sideLean`); fingers expose `rawX/rawY/rawZ`. Add new movements there once you have measured their axes.

## Capturing a pose from the avatar

The rig is available in the browser console as `motionStudio`:

```js
motionStudio.poses.apply('idle', { alpha: 1 })       // go to a preset
motionStudio.poses.save('my-pose')                   // capture the avatar as it is now
motionStudio.poses.exportJSON()                      // paste into the "poses" block of avatar-rig.json
motionStudio.joint('left.elbow').getCurrentPose()    // { flexion: 85.6 }
motionStudio.joint('left.elbow').set({ flexion: 40 }, 1)
```

## What is deliberately unchanged

Live tracking is numerically identical to before: `main.ts` passes the same Euler angles and blend factors, now addressed by semantic joint id (`left.upperArm`, `left.elbow`, `left.wrist`, `right.index.2`, `head`, `spine`, ...). `constraints.json` and its loader are untouched.

## Constraint solver (Phase 3) and the front-of-body rule

`AvatarRig.update()` runs `ArmSolver` per arm after tracking and before rendering. It reads the *commanded* bone rotations (what the retargeter asked for), writes corrected node rotations, and never changes the commanded values. With `frontConstraint.enabled: false` and no elbow limit hit, it writes nothing, so tracking is identical to before.

1. **Elbow hinge limit** - the `left.elbow` / `right.elbow` `flexion` limits (`joints` block, default 0-170 deg).
2. **Bend plane** - the upper arm is twisted about its own long axis by `t = -flip * bendPlane`. With the arm commanded as `Rz(upper)` and the forearm as `Rz(flex)`, inserting `Rx(t)` between them turns the forearm direction from `(cos f, sin f, 0)` into `(cos f, sin f cos t, sin f sin t)` in the upper arm's frame. Because `Rz` leaves the Z axis alone, that Z component is the forward direction (+Z for VRM 1, -Z for VRM 0, i.e. `flip = -1 / +1`), so `t = -flip * bendPlane` bends the elbow forward on both sides of both rig types.
3. **Front half-space** - if the upper arm or forearm points behind the plane tilted `minForward` degrees in front of the shoulder line, it is swung forward by the minimum angle (axis = direction x forward).
4. **Palm preservation** - `hand' = (upper' * forearm')^-1 * (upper * forearm) * hand`, blended by `keepPalmOrientation`, so the tracked hand orientation in space does not change.

Bone lengths cannot be violated because only rotations are modified on a rigid skeleton. Velocity/rate limits and the signing workspace still come from `constraints.json`; the learned KSL statistics stay separate from these anatomical rules.

### How this was checked

`ArmSolver` was run against an independent stand-in for three.js quaternions for VRM 0 and VRM 1 and both arms with a "hands up" command: the raw forearm had forward component 0 and the solved forearm 0.79, the upper arm 0.139 (sin 8 deg), the hand's orientation in space changed by under 1e-15, and a disabled solver wrote nothing. The elbow clamp turned 150 deg into the configured maximum. `tsc` passes against type stubs. **The app was not run in a browser with a real webcam or the VRM files**, and `vite build` was not run (no `node_modules` here). Please run `npm install && npm run dev` and use **Test: hands up** first.
