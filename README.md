# MMM-FaceTracking

`MMM-FaceTracking` is a MagicMirror module that uses the attached webcam to:

- detect faces in the live camera feed
- track the primary face position and movement
- estimate facial expression as an on-device "mood" signal
- publish updates to other MagicMirror modules via notifications

The expression estimate is a heuristic, not a reliable measure of a person's actual emotional state.

## Features

- Webcam capture through the browser/Electron client
- Face detection with `TinyFaceDetector`
- Expression estimation with `faceExpressionNet`
- Smoothed face position, movement, and distance hints
- Recent mood history chips
- Broadcast notification payloads for downstream automations

## Installation

Clone or copy this folder into your MagicMirror `modules` directory:

```bash
cd ~/MagicMirror/modules
git clone https://github.com/joeb5524/MMM-FaceTracking.git
```

No build step is required.

## Example config

Add this to the `modules` array in `config/config.js`:

```js
{
  module: "MMM-FaceTracking",
  position: "top_right",
  config: {
    showVideoPreview: false,
    updateInterval: 500,
    broadcastNotifications: true
  }
}
```

## Configuration

| Option | Default | Notes |
| --- | --- | --- |
| `modelScriptUrl` | `https://cdn.jsdelivr.net/npm/face-api.js@0.22.2/dist/face-api.min.js` | Browser library URL |
| `modelBaseUrl` | `https://cdn.jsdelivr.net/gh/justadudewhohacks/face-api.js@0.22.2/weights` | Model manifests and weight shards |
| `facingMode` | `"user"` | Camera selection hint |
| `cameraWidth` | `640` | Requested camera width |
| `cameraHeight` | `480` | Requested camera height |
| `updateInterval` | `450` | Detection interval in ms |
| `detectionInputSize` | `224` | Smaller is faster, larger can be more accurate |
| `detectionScoreThreshold` | `0.5` | Minimum face detector score |
| `expressionConfidenceThreshold` | `0.38` | Below this, mood is shown as uncertain |
| `positionSmoothing` | `0.65` | Higher values reduce jitter |
| `expressionSmoothing` | `0.7` | Higher values reduce mood flicker |
| `movementThreshold` | `0.018` | Lower values make motion detection more sensitive |
| `farFaceAreaThreshold` | `0.08` | Smaller detected face area counts as far |
| `closeFaceAreaThreshold` | `0.2` | Larger detected face area counts as close |
| `noFaceResetMs` | `3000` | How long to preserve last state after face loss |
| `recentMoodLimit` | `5` | Number of recent mood changes shown |
| `showVideoPreview` | `false` | Shows the live camera preview inside the module |
| `previewWidth` | `220` | Preview width in pixels |
| `broadcastNotifications` | `true` | Emit MagicMirror notifications |
| `notificationName` | `"MOOD_GUARD_UPDATE"` | Notification topic name |

## Notification payload

When `broadcastNotifications` is enabled, the module sends `notificationName` with this payload shape:

```js
{
  status: "tracking",
  statusMessage: "Tracking active",
  faceCount: 1,
  mood: {
    key: "happy",
    label: "Happy",
    confidence: 0.82
  },
  tracking: {
    horizontalZone: "Centered",
    verticalZone: "Level",
    movement: "Steady",
    distance: "Comfortable",
    centerX: 0.49,
    centerY: 0.52,
    area: 0.13,
    detectionScore: 0.97
  },
  recentMoods: [],
  lastSeenAt: 1713400000000,
  lastUpdatedAt: 1713400000000
}
```

## Notes

- By default, the face models are loaded from a pinned jsDelivr URL. If you want local/offline hosting, copy the model files into the module and point `modelBaseUrl` at the local route served by MagicMirror.
- The module needs camera access in the MagicMirror browser/Electron session.
- Facial-expression classifiers are noisy. Treat the output as a soft signal for ambience or automation, not as a definitive reading of mood.
