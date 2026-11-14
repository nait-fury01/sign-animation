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




Signvrse GLB:

curl --url 'https://characters.signvrse.com/Zane_iclone_web.glb' \
  -H 'accept: */*' \
  -H 'accept-language: en-US,en;q=0.8' \
  -H 'origin: https://terp360.signvrse.com' \
  -H 'priority: u=1, i' \
  -H 'referer: https://terp360.signvrse.com/' \
  -H 'sec-ch-ua: "Not-A.Brand";v="99", "Brave";v="157", "Chromium";v="157"' \
  -H 'sec-ch-ua-mobile: ?0' \
  -H 'sec-ch-ua-platform: "Linux"' \
  -H 'sec-fetch-dest: empty' \
  -H 'sec-fetch-mode: cors' \
  -H 'sec-fetch-site: same-site' \
  -H 'sec-gpc: 1' \
  -H 'user-agent: Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36'
