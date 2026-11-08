# Motion Studio

Browser based webcam motion capture for the bundled VRM avatars. MediaPipe Tasks performs face, pose, and two-hand tracking in the browser; Three.js renders and retargets the result locally.

## Run

```sh
npm install
npm run dev
```

Open the Vite localhost URL in Chrome or Edge, choose an avatar, then select **Enable camera**. Camera access requires localhost or HTTPS. MediaPipe's WASM runtime and model files load from jsDelivr and Google Cloud Storage on first use. No webcam frames are uploaded.

The app uses MediaPipe Tasks VIDEO landmarker APIs and Kalidokit hand retargeting. Lower-body and hip motion stay fixed; torso movement is limited to a small side lean, while the head can still nod and turn. Elbows stay below the shoulders and hands are limited to a chest-to-upper-abdomen workspace. Wrist roll is calibrated so the bundled VRMs can face their palms toward the camera; finger curls remain independently tracked. Missing or out-of-range arm landmarks return the arms to the avatar's sides. The mirrored webcam preview draws face, arm, and hand landmarks. CPU delegate is used automatically if GPU initialization is unavailable.
