# 3D arm, palm and finger-spread solver (beta)

Source: `src/avatar/ArmIK3D.ts` (pure math), wired in `src/main.ts` (`driveArm3D`, `driveFingerSpread`).
Tests: `scripts/test-arm-ik.mjs` (forward-kinematics round trips for both sides and both VRM conventions).

## Why
The 2D path measures arm angles in the image plane only. "In front of the body" is then faked (bend plane, half-space rules in `ArmSolver.ts`), palms come from Kalidokit with no knowledge of the forearm, and finger spread is lost.

## Coordinate conventions
- MediaPipe pose/hand: x right in the raw image, y down, z away from the camera (nearer = smaller z). Right-handed.
- Avatar bone space, VRM 1 (`flip = -1`): x = avatar left, y up, z toward the viewer. VRM 0 (`flip = +1`) is that frame rotated 180 deg about Y.
- Mapping: `bone = (-flip*x, -y, flip*z)`: a proper rotation, so handedness is preserved.
- Hand landmarks use image x, y/aspect, z (one unit = image width); pose uses world metres.

## Method
1. **Upper arm** = minimal swing from the T-pose direction to (elbow - shoulder), then a twist about its own axis.
2. **Twist** is chosen so the forearm lies in the elbow hinge plane (z axis): `t = atan2(d.z, d.y)` where `d` is the forearm direction in the swing frame. If that gives negative flexion the other solution (t + 180 deg) is used. For a nearly straight arm (< ~14 deg flexion) the twist is undetermined, so it blends to the configured bend plane (`frontConstraint.bendPlane`).
3. **Forearm** = pure hinge about z, clamped to the rig's flexion limits.
4. **Hand**: palm frame `f = wrist->middle MCP`, `p = index MCP->pinky MCP`, `n = f x p`; world rotation = `[f n p] * [bind]^-1`; local = `(upper*lower)^-1 * world`.
5. **Finger spread**: signed angle (toward the pinky) between each finger's proximal direction and the middle finger, in the palm plane; applied as a rotation of the proximal joint about bone-local Y (`spreadToYRotation`).
6. The 2D `ArmSolver` is skipped for arms in 3D mode (`rig.solved3d`), because its bend-plane twist would fight the solution.

## Status and what is NOT verified
The math is unit-tested (< 0.001 deg round-trip error). It has NOT been checked against a live camera: the signs of the MediaPipe z axis for the hand model, and whether the VRM bind hand is exactly palm-down with the thumb forward, are assumptions. Checklist for first run with `?arms=3d` (HUD shows `3D`):
- Arms straight out to the side: avatar arms straight out. If forward/back is inverted, flip the z sign in `toBoneSpace`.
- Elbows bend forward, never backward through the body.
- Palm toward the camera shows the palm to the viewer; if palms are rotated 90 deg, adjust the bind frame in `palmWorldRotation` (`bp`) or `calibration.palmForwardRoll`.
- Open hand spreads fingers; if they cross instead, negate `spreadToYRotation`.
Everything falls back to the 2D path automatically when elbows are not visible (visibility < 0.5).
