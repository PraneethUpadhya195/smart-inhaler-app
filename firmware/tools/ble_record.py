"""Record from the PRISM BLE recorder firmware on a PC (reference client of firmware/PROTOCOL.md).

Connects to the first device advertising the PRISM service, requests a recording, receives the
streamed packets, asks again for any missing ones, verifies the sample count and the CRC-32, and
writes a 16-bit mono 8 kHz WAV plus a JSON file with the device's recording metadata.

    python firmware/tools/ble_record.py --seconds 10 --out <directory>

Needs `bleak` (pip install bleak). The phone app implements the same protocol in services/ble/.
"""

import argparse
import asyncio
import json
import struct
import time
import wave
import zlib
from pathlib import Path

from bleak import BleakClient, BleakScanner

SERVICE = "e11de72b-cbb8-4792-a4d7-79cdfc64cf24"
CONTROL = "32881964-26ae-4fc0-8a67-1d9240d83c7e"
STATUS = "81cb02bc-c729-4eca-b7e4-90ac538e30b7"
AUDIO = "1885d8dd-81bd-4872-9bd4-018e66be46f4"
INFO = "b7923a3c-4778-43a0-ab2c-84aa7c9d207e"
META = "9b3769b5-452f-406b-a851-e1031f23bb65"

CMD_START, CMD_ABORT, CMD_SEND, CMD_RELEASE, CMD_IDENTIFY, CMD_STATUS = 1, 2, 3, 4, 5, 6
PACKET_AUDIO, HEADER = 0xA1, 12


class Recording:
    def __init__(self):
        self.packets = {}        # seq -> (offset, bytes)
        self.duplicates = 0
        self.foreign = 0
        self.status = None
        self.status_event = asyncio.Event()
        self.tag = None
        self.first_packet_at = None
        self.last_packet_at = None
        self.spp = None             # samples per packet (from the RECORDING status)
        self.next_seq = 0           # one past the highest seq seen
        self.gaps = asyncio.Queue()  # (first_seq, count) to ask for again at once
        self.gap_requests = 0

    def on_status(self, _, data: bytearray):
        self.status = json.loads(bytes(data).decode())
        self.status_event.set()

    def on_audio(self, _, data: bytearray):
        if len(data) < HEADER or data[0] != PACKET_AUDIO:
            self.foreign += 1
            return
        _, _, tag, seq, offset = struct.unpack_from("<BBHII", data, 0)
        if self.tag is not None and tag != self.tag:
            self.foreign += 1
            return
        now = time.monotonic()
        self.first_packet_at = self.first_packet_at or now
        self.last_packet_at = now
        if seq in self.packets:
            self.duplicates += 1
        self.packets[seq] = (offset, bytes(data[HEADER:]))
        if seq > self.next_seq:  # packets arrive in order: a jump means lost packets
            self.gaps.put_nowait((self.next_seq, seq - self.next_seq))
        self.next_seq = max(self.next_seq, seq + 1)

    def missing(self, n, spp):
        expected = (n + spp - 1) // spp
        return [s for s in range(expected) if s not in self.packets]

    def samples(self, n):
        out = bytearray(2 * n)
        for offset, payload in self.packets.values():
            out[2 * offset:2 * offset + len(payload)] = payload
        return bytes(out[:2 * n])


async def wait_status(rec, predicate, timeout):
    deadline = time.monotonic() + timeout
    while True:
        if rec.status is not None and predicate(rec.status):
            return rec.status
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError(f"no matching status; last {rec.status}")
        rec.status_event.clear()
        try:
            await asyncio.wait_for(rec.status_event.wait(), remaining)
        except asyncio.TimeoutError:
            pass


async def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--seconds", type=float, default=10.0)
    parser.add_argument("--out", default=".")
    parser.add_argument("--drop-every", type=int, default=0,
                        help="test only: ignore every Nth live packet to exercise the resend path")
    args = parser.parse_args()

    device = await BleakScanner.find_device_by_filter(
        lambda d, adv: SERVICE.lower() in [u.lower() for u in adv.service_uuids], timeout=15)
    if device is None:
        raise SystemExit("no PRISM recorder found")
    print(f"found {device.name} {device.address}")
    async with BleakClient(device) as client:
        mtu = client.mtu_size
        print(f"connected, mtu {mtu}")
        info = json.loads((await client.read_gatt_char(INFO)).decode())
        print("info", info)
        rec = Recording()
        dropped = {"n": 0}
        if args.drop_every:
            original = rec.on_audio

            def lossy(sender, data):
                dropped["n"] += 1
                if dropped["n"] % args.drop_every == 0:
                    return
                original(sender, data)
            audio_handler = lossy
        else:
            audio_handler = rec.on_audio
        await client.start_notify(STATUS, rec.on_status)
        await client.start_notify(AUDIO, audio_handler)

        n_req = int(round(args.seconds * 8000))
        t0 = time.monotonic()
        rec.status = None
        await client.write_gatt_char(CONTROL, struct.pack("<BI", CMD_START, n_req), response=True)
        started = await wait_status(rec, lambda s: s["st"] in ("RECORDING", "ERROR"), 5)
        if started["st"] == "ERROR" or started.get("err"):
            raise SystemExit(f"start refused: {started}")
        rec.tag = started["tag"]
        rec.spp = started["spp"]
        recorded_at = time.strftime("%Y-%m-%dT%H:%M:%S%z")

        async def ask_for_gaps():  # during the recording, while the gap is still in the ring
            while True:
                first, count = await rec.gaps.get()
                rec.gap_requests += 1
                await client.write_gatt_char(
                    CONTROL, struct.pack("<BII", CMD_SEND, first * rec.spp, count * rec.spp), response=True)
        gap_task = asyncio.create_task(ask_for_gaps())
        final = await wait_status(rec, lambda s: s["st"] in ("READY", "ERROR") and s["tag"] == rec.tag, args.seconds + 20)
        t_done = time.monotonic()
        gap_task.cancel()
        n, spp = final["n"], final["spp"]
        resends = 0
        for _ in range(5):
            missing = rec.missing(n, spp)
            if not missing:
                break
            print(f"missing {len(missing)} packets: asking again")
            resends += 1
            # contiguous runs of missing packets -> one SEND each
            runs, start = [], missing[0]
            for a, b in zip(missing, missing[1:] + [None]):
                if b != a + 1:
                    runs.append((start, a))
                    start = b
            for first, last in runs:
                rec.status = None
                await client.write_gatt_char(
                    CONTROL, struct.pack("<BII", CMD_SEND, first * spp, (last - first + 1) * spp), response=True)
                await wait_status(rec, lambda s: s["st"] == "READY", 20)
        missing = rec.missing(n, spp)
        pcm = rec.samples(n)
        crc = f"{zlib.crc32(pcm):08x}"
        meta = json.loads((await client.read_gatt_char(META)).decode())
        ok = not missing and crc == final["crc"] and n == n_req
        print(f"samples {n}/{n_req}, packets {len(rec.packets)}, missing {len(missing)}, duplicates "
              f"{rec.duplicates}, live gap requests {rec.gap_requests}, resend rounds {resends}, "
              f"crc phone {crc} device {final['crc']} -> "
              f"{'OK' if ok else 'FAILED'}")
        print("meta", meta)
        if ok:
            await client.write_gatt_char(CONTROL, struct.pack("<BH", CMD_RELEASE, rec.tag), response=True)

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    stem = f"prism_ble_{time.strftime('%Y%m%d_%H%M%S')}"
    if ok:
        with wave.open(str(out / f"{stem}.wav"), "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(8000)
            w.writeframes(pcm)
    transfer = {"recorded_at": recorded_at, "n_requested": n_req, "n_received": n, "packets": len(rec.packets),
                "missing_packets": len(missing), "duplicates": rec.duplicates, "live_gap_requests": rec.gap_requests,
                "resend_rounds": resends,
                "crc_phone": crc, "crc_device": final["crc"], "verified": ok, "mtu": mtu,
                "samples_per_packet": spp, "seconds_from_start_to_ready": round(t_done - t0, 3),
                "test_dropped_every": args.drop_every}
    (out / f"{stem}.json").write_text(json.dumps({"info": info, "meta": meta, "transfer": transfer}, indent=2))
    print(f"wrote {out / stem}.*  verified={ok}")


if __name__ == "__main__":
    asyncio.run(main())
