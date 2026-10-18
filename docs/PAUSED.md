# Paused: the Andi chip

The hardware chip is switched off. Its code stays in the repo so it can come back quickly.

| Switch (backend env) | What the chip was |
| --- | --- |
| `FEATURE_CHIP=1` | An ESP32-S3 round display on the nightstand. It showed the day count and glowed steady, warm or alert. Tap to breathe, long-press to call your person |

The switch is off by default. Tests turn it on (`test/setup.ts`) so the chip code keeps working, and `test/features.test.ts` checks what "off" means.

## What happens while it's off

- The `/chip` WebSocket upgrade is refused.
- `POST /api/chip/pair` and `DELETE /api/chip` return 404 `feature_off`.
- Chip events are ignored and `pushChip()` does nothing.
- `GET /api/me` and `/health` report `features: {chip: false}`. The app hides the chip section in Settings.
- `ChipLink.swift` only starts Bluetooth when pairing starts, so it never runs.

## Where the chip's actions live now

| Chip action | Without the chip |
| --- | --- |
| Long-press: call your person | The app's "call Sam" button, CALL in iMessage, or asking Andi on a call to Andi's number. Andi rings Sam through ElevenLabs, or texts Sam a tap-to-call link. Unchanged |
| Tap: breathe | The app's breathe button opens the 4-4-6 breathing screen. BREATHE in iMessage and the voice agent's `breathe` tool send the steps and point to that screen |
| Glow: steady / warm / alert | The risk level on the app's home screen and the sponsor's status message |
| Day count | The app's home screen |

## Bringing it back

1. Run `fly secrets set FEATURE_CHIP=1 -a andi-tdc-backend`. `/health` should show `features.chip: true`.
2. The app reads `features` from `GET /api/me` and shows the chip section again. No app update is needed.
3. Flash the firmware, then pair from Settings.
