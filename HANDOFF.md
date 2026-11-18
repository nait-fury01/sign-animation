# HANDOFF (read this first)

Project: Sign-Connect - webcam signer -> VRM avatar (Vite, TS, three, @pixiv/three-vrm, MediaPipe Tasks, Kalidokit). Goal: faithful sign-language retargeting.
Version: V4 = animationV3 + fixes below. `npm install && npm run dev`, `npm test`, `npm run build`.

## Original diagnosis (from the user's screencast)
Avatar's Left arm stayed folded at the belly while status said "Tracking"; hands under-reached face height; palms/fingers mismatched; ~7 FPS.

## Root causes found and what was done
| # | Cause | Fix (file) |
|---|-------|------------|
| 1 | `public/constraints.json` Left `elbowX/elbowY=[0,0]`, `wristX` min 0 -> inferred elbow collapsed to sternum, upper arm pinned, forearm folded 170 deg | Values restored from `.bak`; `merge()` in `src/constraints.ts` now rejects zero-width ranges with a warning; `scripts/test-constraints.mjs` guards the shipped file |
| 2 | Hard drop-to-neutral when wrist left the box (midline crossing, face level) | Soft workspace in `drivePose`: widen by `soft.workspaceMargin`, neutral only beyond `soft.hardMargin`; 150 ms hold on dropouts; upper-arm range widened by `soft.angleMargin` (`constraints.json` `soft` block) |
| 3 | 640x480 capture vs 16:9 training data; signer too close | 1280x720 request; webcam preview adopts the real aspect; Setup Coach (`src/coach.ts`) + static tips in `index.html` |
| 4 | 7 FPS: 3 detectors sync per frame, per-frame smoothing, fixed dt | Round-robin detection with cached results, time-based smoothing (`VRMAdapter.setTarget/step`), real dt for `rig.update/vrm.update`, adaptive slower face rate, `?pose=lite` |
| 5 | 2D-only retargeting, Kalidokit has no finger spread | `src/avatar/ArmIK3D.ts` + `docs/avatar-3d.md`; toggle `3D`/key T/`?arms=3d` (OFF by default) |
| 6 | Config drift: rig edits in localStorage/README only; Right neutral elbow 161 deg | README `avatars` block merged into `public/avatar-rig.json`; base Right neutral flexion 85.57 deg (also `constraints.json` neutral.Right.elbowFlex 1.4934) |
| + | Debuggability | Arm HUD (key D), hand overlay coloured by assigned side |

## Verified vs not verified
- Verified: `tsc` clean, `vite build` OK, `npm test` passes (3D solver FK round trips, constraint validation), numerical simulation of drivePose before/after.
- NOT verified (no camera/browser in the build environment): visual behaviour of 2D soft workspace, 3D mode axes/signs (checklist in docs/avatar-3d.md), FPS gain, coach thresholds.

## Open items / next steps
1. Run live; read the Arm HUD. Confirm Left arm now follows (state TRACKED/INFERRED, `up`/`elb` vary).
2. **`outwardAngle`**: `constraints.json` has 0.1 but `.bak` had 0.78. The earlier "before/after" comparison mixed both. Determine which value the extraction notebook used. Test: arms hanging relaxed, HUD `up` should be near the top of the range for a hanging arm; if arms look rotated ~40 deg off, switch value.
3. Validate 3D mode with the checklist; if good, make it the default and then simplify/retire the 2D bend-plane hacks in `ArmSolver.ts`.
4. Browser localStorage key `motionStudio.rigEdits.v1` layers over `avatar-rig.json`; clear it (`motionStudio.resetEdits()` in console) if old edits fight the new file.
5. Not done: moving detection into a Web Worker (tasks-vision + Vite module workers is awkward); do it if FPS is still low after round-robin/lite pose.
6. Re-derive `constraints.json` from the extraction notebook (Left/Right asymmetry such as wristX Left [-0.65,1.16] vs Right [-1.45,0.16] looks suspicious) and fix the notebook so it cannot emit `[0,0]`.
7. Consider a depth-aware neutral/rest and elbow inference using `worldLandmarks` even in 2D mode.

## Map
`src/main.ts` loop + drivePose/driveHands/HUD | `src/coach.ts` setup advice | `src/constraints.ts` limits | `src/avatar/{AvatarRig,VRMAdapter,ArmSolver,ArmIK3D,PoseManager,rigConfig}.ts` | `public/{constraints,avatar-rig}.json` | `scripts/test-*.mjs` | `docs/`
