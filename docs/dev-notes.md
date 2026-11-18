# Dev notes (moved verbatim from README)

The rig edits below are now merged into public/avatar-rig.json (avatars block).

# Edited Rig:
## Rest.json:
```json
{
  "runtimeRest": "signing-neutral",
  "calibration": {
    "rotationFlip": "auto",
    "palmForwardRoll": {
      "Left": -90,
      "Right": 90
    }
  },
  "frontConstraint": {
    "enabled": true,
    "bendPlane": 70,
    "upperArmMinForward": 8,
    "forearmMinForward": 0,
    "keepPalmOrientation": 1
  },
  "poses": {
    "signing-neutral": {
      "label": "Neutral pose",
      "description": "Typical signing posture measured from the KSL recordings (converted from constraints.json neutral).",
      "blend": 0.3,
      "clampToTrackingLimits": true,
      "Left": {
        "upperArm": {
          "lowering": 33.781592
        },
        "elbow": {
          "flexion": 85.565517
        },
        "wrist": {
          "palm": "forward",
          "roll": 0
        }
      },
      "Right": {
        "upperArm": {
          "lowering": 21.697912
        },
        "elbow": {
          "flexion": 161.654312
        },
        "wrist": {
          "palm": "forward",
          "roll": 0
        }
      }
    }
  },
  "version": 1,
  "avatars": {
    "viverse_avatar_model_178277black.vrm": {
      "frontConstraint": {
        "upperArmMinForward": 19,
        "bendPlane": 77,
        "forearmMinForward": 28,
        "keepPalmOrientation": 0.25
      },
      "poses": {
        "signing-neutral": {
          "Left": {
            "upperArm": {
              "lowering": 52.5
            },
            "wrist": {
              "palm": "forward",
              "roll": 174
            }
          },
          "Right": {
            "upperArm": {
              "lowering": 52.5
            },
            "elbow": {
              "flexion": 85.565517
            },
            "wrist": {
              "palm": "forward",
              "roll": 2
            }
          }
        }
      },
      "joints": {
        "left.elbow": {
          "bone": "leftLowerArm",
          "dofs": {
            "flexion": {
              "axis": "z",
              "sign": -1,
              "limits": [
                0,
                149
              ]
            }
          }
        },
        "right.elbow": {
          "bone": "rightLowerArm",
          "dofs": {
            "flexion": {
              "axis": "z",
              "sign": 1,
              "limits": [
                0,
                149
              ]
            }
          }
        }
      },
      "calibration": {
        "palmForwardRoll": {
          "Left": -92
        }
      }
    }
  }
}
```
