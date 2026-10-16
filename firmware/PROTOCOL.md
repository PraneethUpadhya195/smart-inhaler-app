# PRISM BLE audio protocol ("prism-ble-audio", version 1)

Between the PRISM recorder firmware (`firmware/prism_ble_recorder`, ESP32 + INMP441) and the phone
(`services/ble/`). A PC reference client is `firmware/tools/ble_record.py`.

## GATT

One primary service, advertised in the advertising data (the name `PRISM-XXXX` is in the scan response).

| Characteristic | UUID | Properties | Content |
|---|---|---|---|
| Service | `e11de72b-cbb8-4792-a4d7-79cdfc64cf24` | | |
| CONTROL | `32881964-26ae-4fc0-8a67-1d9240d83c7e` | write (with response) | commands, binary |
| STATUS | `81cb02bc-c729-4eca-b7e4-90ac538e30b7` | read, notify | JSON state |
| AUDIO | `1885d8dd-81bd-4872-9bd4-018e66be46f4` | notify | audio packets, binary |
| INFO | `b7923a3c-4778-43a0-ab2c-84aa7c9d207e` | read | JSON device information |
| META | `9b3769b5-452f-406b-a851-e1031f23bb65` | read | JSON capture checks of the last recording |

The phone requests an ATT MTU of 247. The firmware refuses to record when the MTU is below 64.
All integers are little-endian.

## Commands (CONTROL)

| Byte 0 | Name | Arguments | Effect |
|---|---|---|---|
| 0x01 | START | u32 n_samples (0 = 80000) | start a recording of n samples (1536 … 240000) |
| 0x02 | ABORT | | stop the running recording; clear pending resends |
| 0x03 | SEND | u32 offset, u32 count (0 = to the end) | send the packets covering those samples again (allowed during a recording) |
| 0x04 | RELEASE | u16 tag | forget the last recording (after the phone has verified it) |
| 0x05 | IDENTIFY | | blink the on-board LED for 3 s |
| 0x06 | STATUS | | notify the current status again |

## STATUS (JSON, notified on every change and every 250 ms while recording)

```
{"p":1,"st":"RECORDING","tag":34091,"rid":"a7103f6a","n":40832,"req":80000,"sr":8000,
 "crc":"00000000","spp":116,"mtu":247,"sent":352,"q":0,"done":false,"err":null}
```

| Key | Meaning |
|---|---|
| `st` | `IDLE`, `RECORDING`, `READY`, `TRANSFERRING`, `ERROR` |
| `tag` | 16-bit tag of the current / last recording (0 = none) |
| `rid` | 8-hex-digit recording id |
| `n` / `req` | samples captured so far / requested |
| `sr` | sample rate (always 8000) |
| `crc` | CRC-32 (IEEE, as `zlib.crc32`) of all samples as int16 LE bytes; valid only when `done` is true |
| `spp` | samples per packet of this recording |
| `q` | resend ranges still queued |
| `err` | `null` or an error code (below) |

Error codes: `BUSY`, `BAD_LENGTH`, `MTU_TOO_SMALL`, `NOTIFY_DISABLED`, `NOT_READY`, `BAD_RANGE`,
`RESEND_QUEUE_FULL`, `EXPIRED` (part of a requested range is no longer held), `I2S_READ_FAILED`,
`ABORTED`, `INCOMPLETE`, `BAD_TAG`, `BAD_COMMAND`, `I2S_INIT_FAILED`, `NO_MEMORY` (the last two are
fatal at boot).

## AUDIO packets

| Offset | Size | Field |
|---|---|---|
| 0 | 1 | type 0xA1 |
| 1 | 1 | protocol version (1) |
| 2 | 2 | tag of the recording |
| 4 | 4 | seq = offset / spp |
| 8 | 4 | offset of the first sample |
| 12 | 2·k | k int16 samples (k = spp, the last packet may be shorter) |

## Recording sequence

1. Phone subscribes to STATUS and AUDIO, writes START.
2. Device: STATUS `RECORDING` (tag, spp). It discards 100 ms of stale DMA data, then captures and
   **streams packets while it records**. Samples stay in a RAM ring buffer (43,008 samples = 5.4 s on
   the DevKit V1 with Bluedroid running) so that they can be sent again.
3. Phone: packets arrive in order; a jump in `seq` means lost packets, and the phone sends SEND for
   the gap at once, while it is still in the ring.
4. Device: after the last sample and the last packet, STATUS `READY` with `done: true`, `n` and `crc`.
5. Phone: waits briefly for packets still in flight (on Android the READY status can overtake the
   last audio packets), asks again for anything missing (up to 3 rounds), then verifies: 8000 Hz,
   exactly `req` samples, every packet present with its expected length, CRC-32 equal to the device's.
   Only then is the recording analysed. It reads META and writes RELEASE.

If the link drops, the device finishes the capture but the phone treats the recording as failed;
the user records again. Nothing partial is analysed.

## INFO and META

INFO: firmware, device id (`prism-esp32-<BT MAC>`), name, microphone, sample rate, I2S framing, the
int16 conversion, maximum/default/minimum sample counts, ring size, free heap, pre-roll.

META (per recording): `n`, `crc`, `elapsed_us` and `rate_hz` (samples read per second of the ESP32
clock; DMA buffers of 240 frames make it accurate to about ±0.3 % over 10 s), `raw_or` / `raw_and`
(OR / AND of every raw 32-bit I2S word), `low_byte_nonzero`, `min`, `max`, `clipped`, `jumps`
(sample-to-sample changes above 32768, i.e. wrap-around), `mean`, `short_reads`, `dma_overflows`
(I2S receive-queue overflows), `ring_overruns` (samples overwritten before they were sent).
