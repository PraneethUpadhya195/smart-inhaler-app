// Protocol types of prism_ble_recorder.ino, in a header so that the Arduino prototype generator
// (which declares every function at the top of the sketch) sees them first.
#pragma once
#include <stdint.h>

constexpr uint8_t PROTOCOL_VERSION = 1;

// ── Audio packets (AUDIO notifications) ─────────────────────────────────────
// type u8 = 0xA1, version u8, tag u16, seq u32 (= offset / samples per packet), offset u32 (first
// sample), then int16 little-endian samples. All integers little-endian.
constexpr uint8_t PACKET_AUDIO = 0xA1;
constexpr size_t PACKET_HEADER = 12;
constexpr uint16_t MIN_TRANSFER_MTU = 64;

// ── Commands (first byte of a CONTROL write) ────────────────────────────────
enum Command : uint8_t {
  CMD_START = 0x01,     // u32 n_samples (0 = default)
  CMD_ABORT = 0x02,     // stop a recording or a transfer
  CMD_SEND = 0x03,      // u32 offset, u32 count (0 = to the end): send that sample range again
  CMD_RELEASE = 0x04,   // u16 tag: forget the last recording (after the phone has verified it)
  CMD_IDENTIFY = 0x05,  // blink the LED for 3 s
  CMD_STATUS = 0x06,    // notify the current status again
};

enum class State : uint8_t { IDLE, RECORDING, READY, TRANSFERRING, ERROR };

inline const char *stateName(State s) {
  switch (s) {
    case State::IDLE: return "IDLE";
    case State::RECORDING: return "RECORDING";
    case State::READY: return "READY";
    case State::TRANSFERRING: return "TRANSFERRING";
    default: return "ERROR";
  }
}

struct CommandMsg {
  uint8_t len;
  uint8_t data[19];
};

