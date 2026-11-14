# Avatar control and retargeting

This guide describes the current implementation in `src/main.ts` and, in particular, how [`public/constraints.json`](../public/constraints.json) controls the pose retargeter.

## Control flow

```text
Webcam video
  ├─ FaceLandmarker ──> head rotation + facial expressions
  ├─ PoseLandmarker ──> shoulder/elbow/wrist placement + torso lean
  └─ HandLandmarker ──> wrist orientation + finger joints
                           │
                    constraints.json
             workspace, angle, and rate limits
                           │
                           ▼
                  retarget and smooth
                           │
                           ▼
              normalized VRM humanoid bones
                           │
                           ▼
               Three.js render each frame
```

The camera is requested at an ideal 640 × 480 resolution with audio disabled. Tracking runs in the browser. The input video and MediaPipe coordinates are not mirrored; only the preview video and landmark overlay are mirrored for a natural selfie view.

## Using `public/constraints.json`

This file is the main configuration surface for controlling allowed avatar motion. The app requests it at `/constraints.json` on startup with browser caching disabled. Vite serves files from `public/` at the site root, and production builds copy the JSON to `dist/constraints.json`.

### Editing workflow

1. Make a copy of `public/constraints.json` before experimenting.
2. Edit the ranges or values described below. Keep the file valid JSON: double-quoted keys and strings, commas between fields, and no comments or trailing commas.
3. Save and reload the page. On a deployed site, upload the updated `constraints.json` at the site root alongside `index.html`; the JavaScript bundle does not need to be rebuilt just to change the JSON.
4. Watch the webcam overlay and avatar. Narrow ranges gradually; overly narrow joint limits can make movement look rigid or cause an arm to fall back.

If the file is missing, returns HTML, or contains invalid JSON, the loader logs a diagnostic and uses `DEFAULT_CONSTRAINTS` from `src/constraints.ts`. Known fields that have the wrong shape also retain their built-in default. This fallback keeps tracking usable while the config is repaired.

### Coordinate units

Pose and hand image points are normalized to the camera frame. For the constraint file, the app converts vertical coordinates to the same scale as horizontal coordinates and expresses positions relative to shoulder span:

- `span` is the horizontal distance between the shoulders, with a minimum of `0.12` to avoid division by a very small value.
- `x` positions are fractions of image width.
- `y` positions are normalized image height divided by the image aspect ratio (`width / height`), so positive `y` points downward and the vertical and horizontal axes use the same image-width unit.
- Wrist/elbow position ranges are then divided by shoulder span. They therefore describe body-relative workspace instead of fixed pixels.
- Rotation ranges and `outwardAngle` are in radians. Rate limits are radians per second.

For a wrist, the code uses `(wrist.x - shoulderCenterX) / span` for horizontal position and `(wrist.y / aspect - shoulderY / aspect) / span` for vertical position. Elbow positions use the same convention.

### Top-level fields

| Field | What it controls |
| --- | --- |
| `version` | Human-readable config schema version. The current file uses `1`; the app does not currently reject unknown version numbers. |
| `meta` | Provenance only. It is logged to the console and does not change the avatar pose. |
| `outwardAngle` | Baseline angle for a relaxed upper arm pointing down and outward. Used to calculate upper-arm rotation. |
| `arms.Left`, `arms.Right` | Per-side wrist/elbow workspaces, arm-angle limits, and spike/rate limits. |
| `head.roll` | Clamp for head roll. Head pitch and yaw still use constants in `driveFace()`. |
| `torsoTilt` | Clamp for side-to-side spine lean. No hips or lower-body retargeting is performed. |
| `neutral` | Controls which fallback pose is used when an arm has no valid target. |
| `handAssign.maxDistSpan` | Maximum distance, in shoulder spans, for assigning a single detected hand to a pose wrist by proximity. |
| `fingers` | Optional rotation clamps for individual finger segments. It is absent from the current file, so finger rotations are not constraint-clamped. |

### Per-arm fields

Each `arms.Left` and `arms.Right` block supports these values:

| Field | Units and effect |
| --- | --- |
| `upperRotation: [min, max]` | Allowed upper-arm rotation around the side-specific down/out baseline. |
| `elbowFlex: [min, max]` | Allowed magnitude of elbow flexion. The solver calculates flex as a nonnegative angle, then applies the side-specific sign when posing the VRM. |
| `wristX: [min, max]` | Horizontal wrist workspace relative to the shoulder center and shoulder span. |
| `wristY: [min, max]` | Vertical wrist workspace relative to the shoulder line and shoulder span. Negative values allow a wrist above the shoulder line; positive values are below it. |
| `elbowX: [min, max]` | Horizontal elbow workspace using the same shoulder-relative units. An invalid/out-of-range elbow is inferred and clamped to this range. |
| `elbowY: [min, max]` | Vertical elbow workspace. Positive values are below the shoulder line; negative values allow an elbow above it. |
| `maxRate.upper` | Maximum upper-arm angle change per second. Rejects large single-frame pose spikes. |
| `maxRate.elbow` | Maximum elbow angle change per second. |
| `elbowGivenUpper` | Optional coupling between upper-arm angle and allowed elbow flex. See below. |

The wrist is checked first. If it lies outside its configured `wristX`/`wristY` ranges, the arm uses its fallback pose. If the wrist is valid but the elbow is missing or outside its range, the app estimates the elbow inside the configured `elbowX`/`elbowY` region. Valid upper-arm and elbow angles are clamped, rate-limited, and smoothed before being applied.

### Current configured motion ranges

These values are read from the current `public/constraints.json`:

| Setting | Left | Right |
| --- | ---: | ---: |
| `upperRotation` (rad) | `[-0.3563, 1.1730]` | `[-0.8605, 0.8743]` |
| `elbowFlex` (rad) | `[0.0000, 3.2672]` | `[0.0000, 3.2936]` |
| `wristX` (shoulder spans) | `[-0.6517, 1.1566]` | `[-1.4542, 0.1588]` |
| `wristY` (shoulder spans) | `[-0.4969, 1.9676]` | `[-0.8915, 1.7811]` |
| `elbowX` (shoulder spans) | `[0.1857, 1.2254]` | `[-1.3527, -0.4676]` |
| `elbowY` (shoulder spans) | `[0.2095, 1.1376]` | `[-0.1107, 1.1002]` |
| `maxRate.upper` (rad/s) | `3.42` | `4.95` |
| `maxRate.elbow` (rad/s) | `16.78` | `34.63` |

These are learned/worked values from the constraint extraction, not universal anatomy limits. In particular, the current right `elbowY` lower bound is slightly negative, so it permits a small amount of elbow motion above the shoulder line. To require both elbows below the shoulder line, change that right lower bound to `0` or a small positive value. The current negative lower values in `wristY` also permit some above-shoulder hand motion; increase them if the desired signing workspace should stay lower.

For example, to require the right elbow to remain below the shoulder line while retaining its current lower torso bound, edit the existing field to:

```json
"elbowY": [0, 1.1002]
```

To narrow the right wrist's horizontal range, change `arms.Right.wristX`; moving either endpoint toward `0` keeps the wrist closer to the shoulder center. Keep the left and right ranges separate because image-space left/right sign directions differ.

### Coupling elbow flex to upper-arm pose

`elbowGivenUpper` lets an arm use different elbow ranges at different upper-arm angles:

```json
"elbowGivenUpper": {
  "edges": [-0.5, 0, 0.5],
  "ranges": [[0, 1.4], [0, 1.8], [0.2, 2.2], [0.4, 2.6]]
}
```

The edges must be sorted from low to high, and `ranges` must contain exactly one more range than there are edges. The app chooses a range bucket from the current upper-arm angle; if the lengths do not match or the chosen range is malformed, it uses the arm's top-level `elbowFlex` range instead. The optional block is not fully schema-validated, so preserve this shape when editing it.

### Neutral fallback pose

When landmarks are missing or the wrist falls outside its workspace, `dropArmsPose()` chooses a fallback based on `neutral.enabled`:

- `true`: use `neutral.Left` or `neutral.Right` as a signing-ready pose. Each fallback angle is clamped to that side's `upperRotation` and `elbowFlex` ranges. The current file enables this and stores `Left: { upperRotation: 0.5896, elbowFlex: 1.4934 }` and `Right: { upperRotation: -0.3787, elbowFlex: 2.8214 }`.
- `false`: use the built-in arms-at-sides pose with a small relaxed elbow bend.

The UI reports **Neutral pose** when the enabled fallback is active and **At sides** when the built-in side pose is active. If a hand is absent, its fingers ease toward neutral and the wrist returns toward the camera-facing orientation.

### Hand assignment and optional finger clamps

`handAssign.maxDistSpan` is used when only one hand is detected: if its wrist is close enough to a pose wrist, the app assigns it to that side by proximity. If it is too far away, the app falls back to MediaPipe's handedness label. When both hands and both pose wrists exist, the app compares direct and crossed wrist assignments.

Optional `fingers` entries use the exact Kalidokit segment keys, such as `LeftIndexProximal` or `RightThumbDistal`. Each entry must provide an `[min, max]` range for all three Euler axes:

```json
"fingers": {
  "LeftIndexProximal": {
    "x": [-0.4, 0.4],
    "y": [-0.3, 0.3],
    "z": [-1.2, 0.2]
  }
}
```

The solver clamps that segment's `x`, `y`, and `z` rotations before applying it. Since finger articulation is currently working well, the shipped config leaves `fingers` out; adding tight ranges can make signing rigid.

### What `meta` describes

The current metadata records 1,495 recordings, 40 signers, 53,601 signing frames, percentile bounds (`0.5` and `99.5`), a `0.05` margin, 16:9 data aspect, and 25/30 fps sources. These values document the extraction and are not read by the retargeting logic; the ranges under `arms`, `head`, and `torsoTilt` are the active controls.

## Avatar loading and stage

The avatar selector loads one of the `.vrm` files in `public/`. `GLTFLoader` is extended with `VRMLoaderPlugin`, then the app:

1. Retrieves the VRM object from the loaded GLTF.
2. Calls `VRMUtils.rotateVRM0()` to orient VRM 0 avatars toward the stage camera.
3. Removes unused vertices from the GLTF scene.
4. Places the avatar at `(0, -1.18, 0)`, scales it by `1.48`, and adds it to the Three.js scene.
5. Removes and disposes the previously loaded avatar if the user changes the selection.

The Three.js scene has a transparent background, a perspective camera, hemisphere light, key light, and fill light. The camera reset button restores the view and resets the avatar's normalized humanoid pose. Live tracking may apply a pose again on its next detection frame.

The avatar root does not turn to follow the body. The body remains facing the screen. Head rotation is applied to the `Head` bone; `Neck`, hips, and legs are not driven.

## Face and expression control

The Face Landmarker returns normalized face landmarks and blendshape categories. The head orientation is a lightweight landmark heuristic rather than a full head-pose solver:

- Eye corners 33 and 263 estimate roll and the eye center.
- Nose point 1 relative to the eye center estimates yaw and pitch.
- Yaw is clamped to ±0.65 radians and pitch to −0.45 through +0.55 radians.
- `head.roll` from the JSON clamps roll. The result is smoothed onto the VRM `Head` bone.

| Input blendshape(s) | VRM expression preset(s) | Behavior |
| --- | --- | --- |
| `eyeBlinkLeft`, `eyeBlinkRight` | `blink` | Uses the larger eye-blink score. |
| `mouthSmileLeft`, `mouthSmileRight` | `joy`, then `happy` | Uses the larger smile score. |
| `jawOpen` | `aa`, `Aa`, then `mouthOpen` | Opens the jaw/mouth. |
| `mouthFrownLeft`, `mouthFrownRight` | `angry` | Uses the larger frown score at 45% strength. |

Unsupported presets are skipped. If face landmarks disappear, the head holds its last rotation; missing blendshape scores resolve to zero.

## Upper-body and arm control

Pose landmark indices use MediaPipe's 33-point pose layout:

| Index | Body part |
| --- | --- |
| 11, 12 | Left and right shoulders |
| 13, 14 | Left and right elbows |
| 15, 16 | Left and right wrists |
| 23, 24 | Left and right hips, used only to estimate torso side lean |

The app computes upper-arm and forearm angles from the shoulder, elbow, and wrist in the image plane. It measures upper-arm rotation against `outwardAngle`, constrains the result with that side's `upperRotation`, and constrains elbow flex with `elbowFlex` or the selected `elbowGivenUpper` bucket. The result is rate-limited using `maxRate`, then smoothed and applied to normalized VRM upper/lower arm bones. It does not reconstruct full 3D arm inverse kinematics; arm depth is intentionally not used to twist the upper arm.

The torso lean is estimated from shoulder/hip horizontal offset and clamped by `torsoTilt`. The same lean is applied to `Chest` at 45% strength. Torso front/back bend, torso yaw, hip motion, and lower-body movement remain fixed.

## Wrist, palm, and finger control

The Hand Landmarker returns up to two hands with 21 normalized landmarks each. The app associates hands with pose wrists by proximity when possible, then uses handedness labels if proximity is unavailable.

Kalidokit converts each hand's landmarks to local Euler rotations. Each hand drives its wrist and 15 finger segments:

| Finger | Driven segments |
| --- | --- |
| Thumb | Metacarpal, proximal, distal |
| Index | Proximal, intermediate, distal |
| Middle | Proximal, intermediate, distal |
| Ring | Proximal, intermediate, distal |
| Little/pinky | Proximal, intermediate, distal |

`fingers` ranges, when present, clamp each finger segment before application. The app maps each segment to normalized VRM humanoid bones via `getNormalizedBoneNode()`; e.g. `LeftHandIndex1` maps to `leftIndexProximal`.

The bundled VRMs' neutral palm normals point down. `palmForwardRoll()` applies a side-specific quarter-turn correction so both palms can face the stage camera while retaining Kalidokit's live wrist orientation. This calibration is specific to the bundled avatar rigs; a custom VRM with a different bind pose may need a different wrist correction.

## Smoothing, overlay, and frame loop

`setEuler()` turns each target Euler rotation into a quaternion and slerps toward it. Current blend factors are: head `0.42`, spine/chest `0.18`, tracked upper arm `0.72`, lower arm `0.70`, fingers `0.58`, wrist `0.72`, neutral fallback `0.3`, and missing-hand easing `0.12`. Higher values approach the target faster. These are per-detection-frame values, not One-Euro filter coefficients.

The render loop uses `requestAnimationFrame`. While capture is active, detection runs if at least 32 ms have passed since the last pass. Three.js renders every animation frame; detection is synchronous on the main thread.

The webcam inset draws sparse face points, shoulder/elbow/wrist connections, and all detected hand joints. The visual preview is mirrored, but the retargeter continues to use the original detector coordinates.

## Research evidence and production build

`research/` is retained at the project root as local evidence for iteration. Vite's `publicDir` is explicitly set to `public`, so `research/` is not copied to `dist/` and is not loaded by the app. Keep production assets and `constraints.json` in `public/`; do not move the research evidence there. The existing `.gitignore` also ignores `research/`, so its contents remain local unless that ignore rule is intentionally changed.

The current app does not read research recordings or landmark logs at runtime. Extracted constraint values are recorded in `public/constraints.json`; the evidence directory is kept separately for reviewing and improving those values.
