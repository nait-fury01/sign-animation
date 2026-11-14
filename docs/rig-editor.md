# Using the rig editor (arms in front of the body)

Open the app, then click the **⚙** button at the top right of the stage (or press **E**). A panel opens on the left of the stage. Nothing here needs code: every change is applied immediately, saved in your browser, and can be exported to `public/avatar-rig.json`.

## Fixing "the arms are behind his back / hands beside the head"

**Why it happens.** MediaPipe gives the app arm angles *in the camera image*. A forearm that points at the camera is foreshortened, so it looks like a forearm raised beside the body. With no depth, the avatar's elbows bend sideways, which reads as hands next to the head or arms pushed behind the back.

**The fix (section 1 of the panel, "Keep arms in front of the body").**

1. Open the editor (⚙ or **E**).
2. Click **Test: hands up**. This reproduces the pose in your screenshot (hands beside the head).
3. Tick **Front-of-body constraint**.
4. Drag **Elbow bends forward** up. At 0° the elbow bends sideways (the old behaviour). At 90° it bends straight forward. **70°** is the default; 60-80° looks natural for signing.
5. Drag **Upper arm lifted forward ≥** to set how far in front of the shoulder line the upper arm must stay (default 8°). **Forearm in front ≥** does the same for the forearm (default 0° = never behind the shoulder line).
6. Click **Test: arms out** to confirm the arms don't swing backward either.
7. Click **Live tracking**, enable the camera and check your own signing.

**Keep palm orientation** (default 1) keeps each hand pointing the way you held it in space, even though the forearm now bends forward. In sign language, palm direction can change the meaning of a sign, so lower this only if the wrists look too bent.

## Changing the rest pose (arms before the camera starts / when tracking drops)

Section 2 edits the active rest pose (`signing-neutral` by default): **Arm lowering**, **Elbow flexion**, **Palm faces** and **Wrist roll**, per arm. While you edit, the avatar is held in that pose and tracking is paused. Click **Live tracking** to go back. **Mirror Left → Right** copies one arm to the other.

## Where changes go

| Choice | Effect |
| --- | --- |
| **Apply edits to: this avatar only** | Saved under `avatars["<file>.vrm"]`. The other avatar is unaffected. |
| **Apply edits to: all avatars** | Saved at the top level of the JSON. |
| **Export JSON** / **Copy JSON** | Writes everything (file + your edits) into `avatar-rig.json`. Replace `public/avatar-rig.json` with it to make the edits permanent for everyone. |
| **Import…** | Loads a previously exported file as your edits. |
| **Reset all edits** | Deletes the edits in this browser and returns to `public/avatar-rig.json`. |

Edits live in this browser's local storage, so a different browser or machine shows `avatar-rig.json` until you export and replace it.

## The other sections

- **3 · Joint limits** - the elbow flexion maximum (default 170°; illustrative, not validated). Applied to live tracking and to poses.
- **4 · Avatar calibration** - `Rotation flip` (leave on auto unless an avatar's arms mirror) and `Palm-forward roll` per hand. If a new VRM shows palms facing the wrong way, adjust the roll until the palm faces the camera.
- **5 · Joint probe** - pick a joint and drag raw X/Y/Z to see which way it rotates. Use it to measure axes before adding new movements to the `joints` block.
- **6 · Poses and files** - **Capture current pose** saves what the avatar is doing now under a name (tick *use it as the rest pose* to make it the rest pose).

## Editing without the panel

`public/avatar-rig.json`:

```json
"frontConstraint": { "enabled": true, "bendPlane": 70, "upperArmMinForward": 8, "forearmMinForward": 0, "keepPalmOrientation": 1 }
```

Console: `motionStudio.poses.apply('test-hands-up', { alpha: 1 })`, `motionStudio.config.frontConstraint`.

## Limits you should know about

- This is a **bias**, not depth sensing: the constraint chooses the most plausible forward configuration. If a sign needs an arm to the side or behind the body, lower **Elbow bends forward** (or untick the constraint) for that case.
- Raise the tracker's depth quality (better lighting, full upper body in frame) before tuning the numbers.
- Always re-check handshape, palm direction and location against real signs after changing these values.
