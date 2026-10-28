/*
 * PRISM BLE recorder: ESP32 DevKit V1 + INMP441 I2S microphone.
 *
 * Records 8 kHz mono audio on request from the phone and streams it over BLE while it is being
 * captured, in sequenced packets, with a CRC-32 over the whole recording. Recent audio stays in a
 * RAM ring buffer so that lost packets can be sent again. Protocol: firmware/PROTOCOL.md
 * ("prism-ble-audio" version 1); the phone side is services/ble/ in the app repository.
 *
 * Why streaming: with the Bluedroid BLE stack running, about 118 KB of heap can be allocated on
 * this board (measured), less than the 160 KB a 10 s recording needs; streaming needs no
 * whole-recording buffer.
 *
 * Audio capture: the wiring and rate of the serial recorder (C:\CAPSTONE\hardware\prism_hardware.cpp +
 * record_audio.py): 8000 Hz, 32-bit slots, mono, LEFT slot (INMP441 L/R tied to GND), BCLK GPIO 26,
 * WS GPIO 25, SD GPIO 33; int16 sample = (int32 I2S word) >> 16. Two differences:
 *   1. The slot is sampled with bit_shift = false (MSB-aligned framing). Measured on this board
 *      (firmware/i2s_alignment_check, RESULT_2026-10-16.txt): with the Philips framing used by
 *      ESP_I2S and the serial sketch (bit_shift = true) the ESP32 samples the INMP441 one SCK late,
 *      so bits 31..9 hold data bits 22..0, the sign bit is lost, every value is doubled and loud
 *      sounds wrap around; with bit_shift = false all 24 data bits sit in bits 31..8 and bit 31
 *      is the sign. Recordings from this firmware are therefore 6 dB lower than the serial ones
 *      and do not wrap.
 *   2. The I2S clock runs from boot, so the microphone is powered and settled when a recording
 *      starts (the serial sketch started the clock just before recording).
 *
 * Each recording also reports, for verification (META characteristic): the OR / AND of every raw
 * 32-bit I2S word, the number of words with a non-zero low byte, clipping, large sample-to-sample
 * jumps, the mean (DC), the capture rate measured against the ESP32's clock, I2S DMA queue
 * overflows (dropped audio) and ring-buffer overruns (audio not sent before it was overwritten).
 *
 * Build: Arduino IDE or arduino-cli, board "ESP32 Dev Module" (esp32:esp32:esp32), core 3.3.x,
 * default partition scheme. See firmware/README.md.
 */

#include <Arduino.h>
#include <driver/i2s_std.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>
#include <esp_gatt_common_api.h>
#include <esp_mac.h>
#include <esp_random.h>
#include "protocol.h"

// ── Identity ────────────────────────────────────────────────────────────────
#define FIRMWARE_VERSION "prism-ble-recorder 1.0.0"

#define SERVICE_UUID "e11de72b-cbb8-4792-a4d7-79cdfc64cf24"
#define CONTROL_UUID "32881964-26ae-4fc0-8a67-1d9240d83c7e"  // write (with response): commands
#define STATUS_UUID  "81cb02bc-c729-4eca-b7e4-90ac538e30b7"  // read + notify: JSON state
#define AUDIO_UUID   "1885d8dd-81bd-4872-9bd4-018e66be46f4"  // notify: audio packets
#define INFO_UUID    "b7923a3c-4778-43a0-ab2c-84aa7c9d207e"  // read: JSON device information
#define META_UUID    "9b3769b5-452f-406b-a851-e1031f23bb65"  // read: JSON metadata of the last recording

// ── Audio ───────────────────────────────────────────────────────────────────
constexpr int PIN_BCLK = 26;
constexpr int PIN_WS = 25;
constexpr int PIN_DIN = 33;
constexpr int LED_PIN = 2;  // on-board LED of the DevKit V1

constexpr uint32_t SAMPLE_RATE = 8000;
constexpr uint32_t DEFAULT_SAMPLES = 80000;  // 10 s, as the serial recorder
constexpr uint32_t MIN_SAMPLES = 1536;       // one detector window, (25 - 1) * 64 (inference contract)
constexpr uint32_t MAX_SAMPLES = 240000;     // 30 s
constexpr uint32_t CHUNK_SAMPLES = 2048;     // the ring is allocated in 4 KB chunks
constexpr uint32_t MAX_CHUNKS = 48;
constexpr size_t HEAP_RESERVE = 40 * 1024;   // left free for the BLE stack
constexpr uint32_t READ_BLOCK = 256;         // samples per I2S read (32 ms)
constexpr uint32_t PREROLL_MS = 100;         // discarded before every recording (stale DMA data)

// ── Globals ─────────────────────────────────────────────────────────────────
static i2s_chan_handle_t rxChan;
static QueueHandle_t commandQueue;

static int16_t *ring[MAX_CHUNKS];
static uint32_t ringChunks = 0;
static uint32_t ringSamples = 0;

static BLEServer *server;
static BLECharacteristic *statusChar, *audioChar, *infoChar, *metaChar, *controlChar;
static BLE2902 *audioCccd;
static volatile bool connected = false;
static volatile uint16_t connId = 0;
static volatile uint16_t peerMtu = 23;
static volatile esp_gatt_if_t gattsIf = ESP_GATT_IF_NONE;

static volatile State state = State::IDLE;
static char deviceId[32];
static char deviceName[16];
static const char *lastError = nullptr;
static bool fatalError = false;  // I2S or memory failure at boot: recording impossible
static uint32_t identifyUntil = 0;

// The current / last recording. Written by the capture task, read by loop().
static volatile uint32_t recTag = 0;        // u16 tag (0 = no recording held)
static char recId[9] = "";                  // 8 hex digits
static volatile uint32_t recRequested = 0;
static volatile uint32_t recSamples = 0;    // samples captured so far
static volatile bool capturing = false;     // capture task is storing samples
static volatile bool captureDone = false;   // capture finished (all requested samples or a failure)
static volatile bool abortRequested = false;
static uint16_t recSpp = 0;                 // samples per packet, fixed for the recording
static uint32_t recCrc = 0xFFFFFFFFu;       // running CRC-32 of the int16 LE bytes

// Streaming state (loop() only)
static uint32_t sendPos = 0;        // next sample to stream live
static uint32_t packetsSent = 0;
static uint32_t ringOverruns = 0;   // samples overwritten before they were sent
struct Range {
  uint32_t from, end;  // samples [from, end)
};
constexpr uint32_t RESEND_SLOTS = 16;
static Range resendQueue[RESEND_SLOTS];  // ranges the phone asked for again (also during a recording)
static uint32_t resendHead = 0, resendCount = 0;
static uint32_t lastStatusMs = 0;

// Diagnostics of the current / last recording
struct Diag {
  uint32_t rawOr, rawAnd, lowNonzero, clipped, jumps, shortReads, readSamples;
  int16_t minV, maxV, previous;
  int64_t sum;
  uint32_t startUs, elapsedUs, startMs;
};
static Diag diag;
static volatile uint32_t dmaOverflows = 0;

// ── Helpers ─────────────────────────────────────────────────────────────────
static inline int16_t &ringAt(uint32_t sample) {
  uint32_t i = sample % ringSamples;
  return ring[i / CHUNK_SAMPLES][i % CHUNK_SAMPLES];
}
static inline uint32_t oldestAvailable() { return recSamples > ringSamples ? recSamples - ringSamples : 0; }

static uint32_t crcTable[256];
static void crcInit() {
  for (uint32_t i = 0; i < 256; i++) {
    uint32_t c = i;
    for (int k = 0; k < 8; k++) c = (c & 1) ? 0xEDB88320u ^ (c >> 1) : c >> 1;
    crcTable[i] = c;
  }
}
// CRC-32 (IEEE 802.3, as zlib.crc32) over the int16 little-endian sample bytes, updated per sample.
static inline uint32_t crcUpdate(uint32_t c, int16_t sample) {
  uint16_t v = (uint16_t)sample;
  c = crcTable[(c ^ (v & 0xFF)) & 0xFF] ^ (c >> 8);
  return crcTable[(c ^ (v >> 8)) & 0xFF] ^ (c >> 8);
}

static uint16_t samplesPerPacket(uint16_t mtu) {
  int payload = (int)mtu - 3 - (int)PACKET_HEADER;
  return payload < 2 ? 0 : (uint16_t)(payload / 2);
}

// Wait (briefly) until the controller can take another notification.
static bool waitSendable(uint32_t timeoutMs) {
  uint32_t start = millis();
  while (connected && esp_ble_get_cur_sendable_packets_num(connId) == 0) {
    if (millis() - start > timeoutMs) return false;
    vTaskDelay(1);
  }
  return connected;
}

static void publishStatus(bool reliable = false) {
  char json[220];
  bool done = captureDone;
  uint32_t n = recSamples;
  int len = snprintf(json, sizeof(json),
                     "{\"p\":%u,\"st\":\"%s\",\"tag\":%lu,\"rid\":\"%s\",\"n\":%lu,\"req\":%lu,\"sr\":%lu,"
                     "\"crc\":\"%08lx\",\"spp\":%u,\"mtu\":%u,\"sent\":%lu,\"q\":%lu,\"done\":%s,\"err\":%s%s%s}",
                     PROTOCOL_VERSION, stateName(state), (unsigned long)recTag, recId, (unsigned long)n,
                     (unsigned long)recRequested, (unsigned long)SAMPLE_RATE,
                     (unsigned long)(done ? (recCrc ^ 0xFFFFFFFFu) : 0), recSpp ? recSpp : samplesPerPacket(peerMtu),
                     peerMtu, (unsigned long)packetsSent, (unsigned long)resendCount, done ? "true" : "false",
                     lastError ? "\"" : "",
                     lastError ? lastError : "null", lastError ? "\"" : "");
  statusChar->setValue((uint8_t *)json, len);
  if (!connected) return;
  if (reliable) waitSendable(1000);
  statusChar->notify();
  lastStatusMs = millis();
}

static void publishInfo() {
  char json[440];
  int len = snprintf(json, sizeof(json),
                     "{\"p\":%u,\"fw\":\"%s\",\"dev\":\"%s\",\"name\":\"%s\",\"mic\":\"INMP441\",\"sr\":%lu,"
                     "\"bits\":16,\"i2s\":\"std, msb-aligned (bit_shift=false), 32-bit slot, mono left\","
                     "\"conv\":\"int16 = int32 >> 16\","
                     "\"max_n\":%lu,\"def_n\":%lu,\"min_n\":%lu,\"ring_n\":%lu,\"heap\":%lu,\"preroll_ms\":%lu,"
                     "\"transfer\":\"live\"}",
                     PROTOCOL_VERSION, FIRMWARE_VERSION, deviceId, deviceName, (unsigned long)SAMPLE_RATE,
                     (unsigned long)MAX_SAMPLES, (unsigned long)DEFAULT_SAMPLES, (unsigned long)MIN_SAMPLES,
                     (unsigned long)ringSamples, (unsigned long)ESP.getFreeHeap(), (unsigned long)PREROLL_MS);
  infoChar->setValue((uint8_t *)json, len);
}

static void publishMeta() {
  char json[512];
  if (recTag == 0 || !captureDone) {
    int len = snprintf(json, sizeof(json), "{\"p\":%u,\"tag\":0}", PROTOCOL_VERSION);
    metaChar->setValue((uint8_t *)json, len);
    return;
  }
  double mean = recSamples > 0 ? (double)diag.sum / recSamples : 0.0;
  // Samples read per second of the ESP32 clock, from the end of the pre-roll to the end of the last
  // read (DMA buffers of 240 frames make this accurate to about 30 ms over the recording).
  double rate = diag.elapsedUs > 0 ? (double)diag.readSamples * 1e6 / diag.elapsedUs : 0.0;
  int len = snprintf(json, sizeof(json),
                     "{\"p\":%u,\"tag\":%lu,\"rid\":\"%s\",\"n\":%lu,\"req\":%lu,\"sr\":%lu,\"crc\":\"%08lx\","
                     "\"elapsed_us\":%lu,\"rate_hz\":%.2f,\"raw_or\":\"%08lx\",\"raw_and\":\"%08lx\","
                     "\"low_byte_nonzero\":%lu,\"min\":%d,\"max\":%d,\"clipped\":%lu,\"jumps\":%lu,\"mean\":%.2f,"
                     "\"short_reads\":%lu,\"dma_overflows\":%lu,\"ring_overruns\":%lu,\"ring_n\":%lu,"
                     "\"preroll_ms\":%lu,\"err\":%s%s%s}",
                     PROTOCOL_VERSION, (unsigned long)recTag, recId, (unsigned long)recSamples,
                     (unsigned long)recRequested, (unsigned long)SAMPLE_RATE, (unsigned long)(recCrc ^ 0xFFFFFFFFu),
                     (unsigned long)diag.elapsedUs, rate, (unsigned long)diag.rawOr, (unsigned long)diag.rawAnd,
                     (unsigned long)diag.lowNonzero, diag.minV, diag.maxV, (unsigned long)diag.clipped,
                     (unsigned long)diag.jumps, mean, (unsigned long)diag.shortReads, (unsigned long)dmaOverflows,
                     (unsigned long)ringOverruns, (unsigned long)ringSamples, (unsigned long)PREROLL_MS,
                     lastError ? "\"" : "", lastError ? lastError : "null", lastError ? "\"" : "");
  metaChar->setValue((uint8_t *)json, len);
}

static void setError(const char *code) {
  lastError = code;
  Serial.printf("[prism] error %s\n", code);
}

// ── Capture task (core 1, above loop()): keeps the I2S clock and DMA running ─────
static bool IRAM_ATTR onRecvOverflow(i2s_chan_handle_t handle, i2s_event_data_t *event, void *ctx) {
  dmaOverflows = dmaOverflows + 1;
  return false;
}

static void captureTask(void *) {
  static int32_t raw[READ_BLOCK];
  uint32_t discardLeft = 0;
  bool wasCapturing = false;
  for (;;) {
    size_t bytes = 0;
    i2s_channel_read(rxChan, raw, sizeof(raw), &bytes, 500);
    uint32_t got = bytes / sizeof(int32_t);
    bool active = capturing;
    if (active && !wasCapturing) {  // a recording was just started: drop stale DMA data first
      discardLeft = SAMPLE_RATE * PREROLL_MS / 1000;
      wasCapturing = true;
      continue;
    }
    wasCapturing = active;
    if (!active) continue;
    if (discardLeft > 0) {
      discardLeft -= min(discardLeft, got);
      if (discardLeft == 0) {
        dmaOverflows = 0;
        diag.startUs = micros();
        diag.startMs = millis();
      }
      continue;
    }
    if (got == 0) {
      setError("I2S_READ_FAILED");
      capturing = false;
      captureDone = true;
      continue;
    }
    if (got < READ_BLOCK) diag.shortReads++;
    diag.readSamples += got;
    uint32_t n = recSamples;
    uint32_t take = min(got, recRequested - n);
    for (uint32_t i = 0; i < take; i++) {
      uint32_t word = (uint32_t)raw[i];
      int16_t v = (int16_t)(raw[i] >> 16);
      diag.rawOr |= word;
      diag.rawAnd &= word;
      if (word & 0xFF) diag.lowNonzero++;
      if (v >= 32767 || v <= -32768) diag.clipped++;
      if (n + i > 0 && abs((int32_t)v - (int32_t)diag.previous) > 32768) diag.jumps++;
      if (v < diag.minV) diag.minV = v;
      if (v > diag.maxV) diag.maxV = v;
      diag.sum += v;
      diag.previous = v;
      recCrc = crcUpdate(recCrc, v);
      ringAt(n + i) = v;
    }
    recSamples = n + take;  // published after the samples are in the ring
    if (recSamples >= recRequested || abortRequested) {
      diag.elapsedUs = micros() - diag.startUs;
      capturing = false;
      captureDone = true;
    }
  }
}

// ── Recording control (loop()) ──────────────────────────────────────────────
static void startRecording(uint32_t requested) {
  recSpp = samplesPerPacket(peerMtu);
  recTag = (esp_random() & 0xFFFF) | 1;  // never 0
  snprintf(recId, sizeof(recId), "%08lx", (unsigned long)esp_random());
  recRequested = requested;
  recSamples = 0;
  recCrc = 0xFFFFFFFFu;
  sendPos = 0;
  packetsSent = 0;
  ringOverruns = 0;
  resendCount = 0;
  lastError = nullptr;
  abortRequested = false;
  memset(&diag, 0, sizeof(diag));
  diag.rawAnd = 0xFFFFFFFFu;
  diag.minV = INT16_MAX;
  diag.maxV = INT16_MIN;
  captureDone = false;
  state = State::RECORDING;
  publishMeta();
  publishStatus(true);
  capturing = true;
  Serial.printf("[prism] recording %lu samples, tag %lu, %u samples/packet\n", (unsigned long)requested,
                (unsigned long)recTag, recSpp);
}

// Send the packet that starts at sample `pos` (a multiple of recSpp). False if the link failed.
static bool sendPacket(uint32_t pos, uint32_t end) {
  static uint8_t packet[517];
  uint32_t n = min((uint32_t)recSpp, end - pos);
  uint32_t seq = pos / recSpp;
  uint16_t tag = recTag;
  packet[0] = PACKET_AUDIO;
  packet[1] = PROTOCOL_VERSION;
  packet[2] = tag & 0xFF;
  packet[3] = tag >> 8;
  memcpy(packet + 4, &seq, 4);
  memcpy(packet + 8, &pos, 4);
  for (uint32_t i = 0; i < n; i++) {
    uint16_t v = (uint16_t)ringAt(pos + i);
    packet[PACKET_HEADER + 2 * i] = v & 0xFF;
    packet[PACKET_HEADER + 2 * i + 1] = v >> 8;
  }
  if (!waitSendable(2000)) return false;
  for (int attempt = 0; attempt < 20 && connected; attempt++) {
    if (esp_ble_gatts_send_indicate(gattsIf, connId, audioChar->getHandle(), PACKET_HEADER + 2 * n, packet, false)
        == ESP_OK) {
      packetsSent++;
      return true;
    }
    vTaskDelay(2);
  }
  return false;
}

// Stream whatever is ready: the live position first, then a pending resend range.
static void serviceStreaming() {
  if (recTag == 0 || recSpp == 0 || !connected) return;
  if (audioCccd != nullptr && !audioCccd->getNotifications()) return;
  bool done = captureDone;
  uint32_t available = recSamples;
  // Live: full packets while capturing; the last (partial) packet once the capture has finished.
  for (int burst = 0; burst < 8; burst++) {
    uint32_t oldest = oldestAvailable();
    if (sendPos < oldest) {  // overwritten before it could be sent: those packets are lost
      uint32_t skipTo = ((oldest + recSpp - 1) / recSpp) * recSpp;
      ringOverruns += skipTo - sendPos;
      sendPos = skipTo;
    }
    uint32_t end = min(sendPos + recSpp, available);
    if (end <= sendPos || (!done && end - sendPos < recSpp)) break;
    if (!sendPacket(sendPos, end)) return;
    sendPos = end;
  }
  // Requested ranges, after the live data that is ready (they are older and still in the ring).
  for (int burst = 0; burst < 4 && resendCount > 0; burst++) {
    Range &r = resendQueue[resendHead];
    uint32_t oldest = oldestAvailable();
    if (r.from < oldest) {
      setError("EXPIRED");  // part of the range is no longer in the ring
      r.from = ((oldest + recSpp - 1) / recSpp) * recSpp;
    }
    if (r.from < r.end) {
      uint32_t end = min(r.from + recSpp, r.end);
      if (!sendPacket(r.from, end)) return;
      r.from = end;
    }
    if (r.from >= r.end) {
      resendHead = (resendHead + 1) % RESEND_SLOTS;
      resendCount--;
    }
  }
}

// ── Commands ────────────────────────────────────────────────────────────────
static uint32_t readU32(const uint8_t *p) { return p[0] | (p[1] << 8) | (p[2] << 16) | ((uint32_t)p[3] << 24); }

static void handleCommand(const CommandMsg &msg) {
  switch (msg.data[0]) {
    case CMD_START: {
      if (state == State::RECORDING || state == State::TRANSFERRING) {
        setError("BUSY");
        publishStatus(true);
        return;
      }
      uint32_t n = msg.len >= 5 ? readU32(msg.data + 1) : 0;
      if (n == 0) n = DEFAULT_SAMPLES;
      if (n < MIN_SAMPLES || n > MAX_SAMPLES) {
        setError("BAD_LENGTH");
        publishStatus(true);
        return;
      }
      if (peerMtu < MIN_TRANSFER_MTU) {
        setError("MTU_TOO_SMALL");
        publishStatus(true);
        return;
      }
      if (audioCccd != nullptr && !audioCccd->getNotifications()) {
        setError("NOTIFY_DISABLED");
        publishStatus(true);
        return;
      }
      startRecording(n);
      return;
    }
    case CMD_SEND: {  // allowed during a recording too: a gap is asked for while it is still in the ring
      if (recTag == 0 || recSpp == 0) {
        setError("NOT_READY");
        publishStatus(true);
        return;
      }
      uint32_t offset = msg.len >= 5 ? readU32(msg.data + 1) : 0;
      uint32_t count = msg.len >= 9 ? readU32(msg.data + 5) : 0;
      uint32_t captured = recSamples;
      uint32_t end = (count == 0 || offset + count > captured) ? captured : offset + count;
      uint32_t from = (offset / recSpp) * recSpp;
      if (from >= end) {
        setError("BAD_RANGE");
        publishStatus(true);
        return;
      }
      if (resendCount >= RESEND_SLOTS) {
        setError("RESEND_QUEUE_FULL");
        publishStatus(true);
        return;
      }
      resendQueue[(resendHead + resendCount) % RESEND_SLOTS] = {from, end};
      resendCount++;
      if (state != State::RECORDING) {
        lastError = nullptr;
        state = State::TRANSFERRING;
        publishStatus(true);
      }
      return;
    }
    case CMD_RELEASE: {
      uint16_t tag = msg.len >= 3 ? (msg.data[1] | (msg.data[2] << 8)) : 0;
      if (recTag != 0 && tag != recTag) {
        setError("BAD_TAG");
        publishStatus(true);
        return;
      }
      if (capturing || state == State::RECORDING) {
        setError("BUSY");
        publishStatus(true);
        return;
      }
      lastError = nullptr;
      recTag = 0;
      recId[0] = 0;
      recSamples = 0;
      recRequested = 0;
      resendCount = 0;
      captureDone = false;
      state = State::IDLE;
      publishMeta();
      publishStatus(true);
      return;
    }
    case CMD_ABORT:
      if (capturing) {
        abortRequested = true;  // the capture task stops at its next block
        setError("ABORTED");
      } else {
        resendCount = 0;
        lastError = nullptr;
        if (state == State::TRANSFERRING) state = State::READY;
      }
      publishStatus(true);
      return;
    case CMD_IDENTIFY:
      identifyUntil = millis() + 3000;
      return;
    case CMD_STATUS:
      publishStatus(true);
      return;
    default:
      setError("BAD_COMMAND");
      publishStatus(true);
  }
}

// ── BLE callbacks (BT task: only hand work to loop()) ───────────────────────
class ServerCallbacks : public BLEServerCallbacks {
  void onConnect(BLEServer *s, esp_ble_gatts_cb_param_t *param) override {
    connId = param->connect.conn_id;
    peerMtu = 23;
    connected = true;
    // 7.5-15 ms interval, no latency, 4 s supervision timeout
    s->requestConnParams(param->connect.remote_bda, 6, 12, 0, 400);
    Serial.println("[prism] connected");
  }
  void onDisconnect(BLEServer *s, esp_ble_gatts_cb_param_t *param) override {
    connected = false;
    peerMtu = 23;
    Serial.println("[prism] disconnected");
    BLEDevice::startAdvertising();  // the last recording stays available after a reconnect
  }
  void onMtuChanged(BLEServer *s, esp_ble_gatts_cb_param_t *param) override {
    peerMtu = param->mtu.mtu;
    Serial.printf("[prism] mtu %u\n", peerMtu);
  }
};

class ControlCallbacks : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic *c, esp_ble_gatts_cb_param_t *param) override {
    CommandMsg msg;
    size_t len = c->getLength();
    msg.len = (uint8_t)min(len, sizeof(msg.data));
    memcpy(msg.data, c->getData(), msg.len);
    if (msg.len > 0 && msg.data[0] == CMD_ABORT && capturing) abortRequested = true;  // act at once
    if (xQueueSend(commandQueue, &msg, 0) != pdTRUE) Serial.println("[prism] command queue full");
  }
};

// Raw GATTS events: only used to learn the GATT interface for direct notifications.
static void gattsEvent(esp_gatts_cb_event_t event, esp_gatt_if_t gatts_if, esp_ble_gatts_cb_param_t *param) {
  if (event == ESP_GATTS_CONNECT_EVT) gattsIf = gatts_if;
}

// ── Setup ───────────────────────────────────────────────────────────────────
static bool setupI2s() {
  i2s_chan_config_t chan = I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_0, I2S_ROLE_MASTER);
  if (i2s_new_channel(&chan, nullptr, &rxChan) != ESP_OK) return false;
  i2s_std_config_t cfg = {
    .clk_cfg = I2S_STD_CLK_DEFAULT_CONFIG(SAMPLE_RATE),
    .slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_32BIT, I2S_SLOT_MODE_MONO),
    .gpio_cfg = { .mclk = I2S_GPIO_UNUSED, .bclk = (gpio_num_t)PIN_BCLK, .ws = (gpio_num_t)PIN_WS,
                  .dout = I2S_GPIO_UNUSED, .din = (gpio_num_t)PIN_DIN,
                  .invert_flags = { .mclk_inv = false, .bclk_inv = false, .ws_inv = false } },
  };
  cfg.slot_cfg.slot_mask = I2S_STD_SLOT_LEFT;
  cfg.slot_cfg.bit_shift = false;  // MSB-aligned: see the header comment (measured alignment)
  if (i2s_channel_init_std_mode(rxChan, &cfg) != ESP_OK) return false;
  // Count DMA queue overflows (= audio dropped because nobody read it in time).
  i2s_event_callbacks_t callbacks = {};
  callbacks.on_recv_q_ovf = onRecvOverflow;
  i2s_channel_register_event_callback(rxChan, &callbacks, nullptr);
  return i2s_channel_enable(rxChan) == ESP_OK;
}

static void setupBle() {
  uint8_t mac[6];
  esp_read_mac(mac, ESP_MAC_BT);
  snprintf(deviceId, sizeof(deviceId), "prism-esp32-%02x%02x%02x%02x%02x%02x", mac[0], mac[1], mac[2], mac[3], mac[4],
           mac[5]);
  snprintf(deviceName, sizeof(deviceName), "PRISM-%02X%02X", mac[4], mac[5]);

  BLEDevice::setCustomGattsHandler(gattsEvent);
  BLEDevice::init(deviceName);
  BLEDevice::setMTU(247);
  server = BLEDevice::createServer();
  server->setCallbacks(new ServerCallbacks());
  BLEService *service = server->createService(BLEUUID(SERVICE_UUID), 20);

  controlChar = service->createCharacteristic(CONTROL_UUID, BLECharacteristic::PROPERTY_WRITE);
  controlChar->setCallbacks(new ControlCallbacks());
  statusChar = service->createCharacteristic(STATUS_UUID, BLECharacteristic::PROPERTY_READ | BLECharacteristic::PROPERTY_NOTIFY);
  statusChar->addDescriptor(new BLE2902());
  audioChar = service->createCharacteristic(AUDIO_UUID, BLECharacteristic::PROPERTY_NOTIFY);
  audioCccd = new BLE2902();
  audioChar->addDescriptor(audioCccd);
  infoChar = service->createCharacteristic(INFO_UUID, BLECharacteristic::PROPERTY_READ);
  metaChar = service->createCharacteristic(META_UUID, BLECharacteristic::PROPERTY_READ);
  service->start();

  BLEAdvertising *advertising = BLEDevice::getAdvertising();
  BLEAdvertisementData adv;
  adv.setFlags(0x06);  // LE general discoverable, BR/EDR not supported
  adv.setCompleteServices(BLEUUID(SERVICE_UUID));
  BLEAdvertisementData scan;
  scan.setName(deviceName);
  advertising->setAdvertisementData(adv);
  advertising->setScanResponseData(scan);
  BLEDevice::startAdvertising();
}

static void allocateRing() {
  for (ringChunks = 0; ringChunks < MAX_CHUNKS; ringChunks++) {
    if (ESP.getFreeHeap() < HEAP_RESERVE + CHUNK_SAMPLES * sizeof(int16_t)) break;
    ring[ringChunks] = (int16_t *)malloc(CHUNK_SAMPLES * sizeof(int16_t));
    if (ring[ringChunks] == nullptr) break;
  }
  ringSamples = ringChunks * CHUNK_SAMPLES;
}

void setup() {
  Serial.begin(115200);
  pinMode(LED_PIN, OUTPUT);
  digitalWrite(LED_PIN, LOW);
  crcInit();
  commandQueue = xQueueCreate(8, sizeof(CommandMsg));

  bool i2sOk = setupI2s();

  setupBle();
  allocateRing();
  publishInfo();
  publishMeta();
  if (!i2sOk) {
    setError("I2S_INIT_FAILED");
    fatalError = true;
    state = State::ERROR;
  } else if (ringSamples < 4 * CHUNK_SAMPLES) {
    setError("NO_MEMORY");
    fatalError = true;
    state = State::ERROR;
  } else {
    xTaskCreatePinnedToCore(captureTask, "capture", 4096, nullptr, 5, nullptr, 1);
  }
  publishStatus();
  Serial.printf("[prism] %s ready as %s (%s); ring %lu samples; heap %lu\n", FIRMWARE_VERSION, deviceName, deviceId,
                (unsigned long)ringSamples, (unsigned long)ESP.getFreeHeap());
}

void loop() {
  CommandMsg msg;
  TickType_t wait = (state == State::RECORDING || resendCount > 0) ? 0 : pdMS_TO_TICKS(20);
  if (xQueueReceive(commandQueue, &msg, wait) == pdTRUE && msg.len > 0) {
    if (fatalError && msg.data[0] != CMD_STATUS && msg.data[0] != CMD_IDENTIFY) {
      publishStatus(true);  // nothing can be recorded; the status carries the error
    } else {
      handleCommand(msg);
    }
  }

  if (state == State::RECORDING || state == State::TRANSFERRING) {
    serviceStreaming();
    if (state == State::RECORDING && captureDone && ((sendPos >= recSamples && resendCount == 0) || !connected)) {
      if (lastError == nullptr && recSamples < recRequested) setError("INCOMPLETE");
      state = State::READY;
      publishMeta();
      publishStatus(true);
      Serial.printf("[prism] recorded %lu samples in %lu us; crc %08lx; raw_or %08lx; raw_and %08lx; low_nz %lu; "
                    "dma_ovf %lu; overruns %lu; packets %lu\n",
                    (unsigned long)recSamples, (unsigned long)diag.elapsedUs, (unsigned long)(recCrc ^ 0xFFFFFFFFu),
                    (unsigned long)diag.rawOr, (unsigned long)diag.rawAnd, (unsigned long)diag.lowNonzero,
                    (unsigned long)dmaOverflows, (unsigned long)ringOverruns, (unsigned long)packetsSent);
    } else if (state == State::TRANSFERRING && resendCount == 0) {
      state = State::READY;
      publishStatus(true);
    } else if (state == State::RECORDING && millis() - lastStatusMs >= 250) {
      publishStatus();  // progress
    }
    if (!connected) vTaskDelay(pdMS_TO_TICKS(10));
  }

  // LED: fast blink while identifying, slow blink while recording, on while connected.
  uint32_t now = millis();
  bool led = now < identifyUntil ? (now / 100) % 2 : (state == State::RECORDING ? (now / 400) % 2 : connected);
  digitalWrite(LED_PIN, led ? HIGH : LOW);
}
