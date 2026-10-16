# PRISM firmware

| Folder | What |
|---|---|
| `prism_ble_recorder/` | The recorder: ESP32 DevKit V1 + INMP441, records on request and streams 8 kHz audio to the phone over BLE ([PROTOCOL.md](PROTOCOL.md)) |
| `i2s_alignment_check/` | Diagnostic sketch: which bits of the 32-bit I2S slot hold the INMP441's 24-bit sample, for two framings. Result: `RESULT_2026-10-16.txt` |
| `tools/ble_record.py` | PC client of the protocol (Python + `bleak`): records, verifies and writes a WAV + JSON |

## Hardware

INMP441 → ESP32 DevKit V1 (as in `C:\CAPSTONE\hardware\log.md`): VDD 3V3, GND, SCK GPIO 26,
WS GPIO 25, SD GPIO 33, L/R to GND (left channel). The on-board LED (GPIO 2) is on while a phone is
connected, blinks slowly while recording and fast for "Identify".

## Build and upload

Arduino IDE 2.x or the `arduino-cli` it bundles, core `esp32:esp32` 3.3.x, board "ESP32 Dev Module",
default partition scheme (the sketch is 1.12 MB, 85 % of the 1.25 MB app partition).

```
"C:\Program Files\Arduino IDE\resources\app\lib\backend\resources\arduino-cli.exe" ^
  --config-file "%USERPROFILE%\.arduinoIDE\arduino-cli.yaml" ^
  compile --upload -p COM7 --fqbn esp32:esp32:esp32:UploadSpeed=230400 firmware/prism_ble_recorder
```

230400 baud: reads at 921600 / 460800 baud failed on this board's CP210x ("Packet content transfer
stopped"); writes were verified at 230400.

Restoring the previous (serial) firmware: re-upload `C:\CAPSTONE\hardware\prism_hardware.cpp`, or write
back the full-flash backup taken before the first BLE upload (kept outside the repository, in the Claude
session scratchpad: `esp32_flash_backup/esp32_full_flash_before_ble.bin`, SHA-256 `50bb2e0b…9839`):
`esptool --chip esp32 --port COM7 write-flash 0 esp32_full_flash_before_ble.bin`.

## Verified on the hardware (2026-10-16)

- **I2S alignment** (`i2s_alignment_check`, 3 cycles × 2 framings, 32,000 samples each, room sound):
  - Philips framing (`bit_shift = true`, used by `ESP_I2S` `I2S_MODE_STD` and by the serial sketch):
    bits 31..9 toggle and bit 8 is always 0. The ESP32 samples the INMP441 one SCK late, so the sign bit
    is lost and every value is doubled. Loud sounds wrap around instead of clipping, which explains
    the wrap-around in `inmp441_20261016_142806.wav`.
  - MSB framing (`bit_shift = false`): bits 31..8 toggle (24 bits, the LSB 50 % of the time), bit 31
    always equals bit 30 (sign extension), int16 values about half those of Philips framing.
  - The recorder therefore uses `bit_shift = false`; int16 = int32 >> 16 keeps the top 16 of the 24 bits.
    Its recordings are 6 dB lower than the serial recorder's and cannot wrap.
- **Capture:** every BLE recording so far reported `raw_or = ffffff00`, `low_byte_nonzero = 0`,
  0 DMA overflows, 0 ring overruns, 0 clipped samples; capture rate 7996.8–8022.3 Hz against the
  ESP32 clock (resolution ±0.3 %).
- **Start-up transient:** with the I2S clock running from boot, the first 0.5 s has a mean of +6 / −52
  (int16), against −6067 in the serial recording `inmp441_20261016_150317.wav`.
- **PC client:** 10 s recordings: 690/690 packets, CRC match; with every 7th packet dropped on
  purpose, all gaps were recovered while recording (114 requests) and the CRC matched.
- **Phone (OnePlus IV2201, Android 13):** see `claude_implementation.md` Entry 18.

## Not verified

- The microphone's absolute sensitivity, frequency response, and behaviour at full scale with the
  corrected framing (no loud test sound was played).
- Range, interference and long sessions. The LED blink of "Identify" was not observed (the command is delivered and acknowledged).
- Detection of real inhalations from this hardware: the detector found none in the room-sound test
  recordings, and the earlier experiment (`experiments/audio_compatibility/`) found that the detector
  does not recognise inhalations recorded with this microphone placement.
