/*
 * I2S bit-alignment check for the INMP441 on the ESP32 DevKit V1 (diagnostic, not the recorder).
 *
 * The INMP441 sends 24-bit two's-complement samples, MSB first, one SCK after the WS edge
 * (Philips framing), and tri-states SD for the rest of the 32-bit slot. If the ESP32 samples the
 * slot at the right bit, the 24 data bits land in bits 31..8 of each 32-bit word and bit 31 is the
 * sign. If it samples one bit late, the sign bit is lost and every value is doubled; loud signals
 * then wrap around instead of clipping.
 *
 * This sketch captures the same pins in two framings and prints, per framing, which bits ever
 * change, the OR/AND of all words, and how often bit 31 differs from bit 30. For data that is
 * correctly aligned, bit 31 is the sign and equals bit 30 for every sample smaller than half of
 * full scale; a misaligned capture has bit 31 = a tri-stated bit (mostly 0) or a data bit.
 *   PHILIPS: bit_shift = true  (what ESP_I2S I2S_MODE_STD uses, and the recorder firmware)
 *   MSB:     bit_shift = false (left-justified: samples one SCK earlier)
 *
 * Pins and rate as the recorder: BCLK 26, WS 25, SD 33, 8000 Hz, 32-bit slots, mono left.
 * Output on the serial port at 115200 baud, repeated every few seconds.
 */
#include <Arduino.h>
#include <driver/i2s_std.h>

constexpr uint32_t SAMPLE_RATE = 8000;
constexpr uint32_t SETTLE_SAMPLES = 3 * SAMPLE_RATE;   // let the microphone's DC settle
constexpr uint32_t MEASURE_SAMPLES = 4 * SAMPLE_RATE;

static i2s_chan_handle_t rx;

static void configure(bool bitShift) {
  i2s_std_config_t cfg = {
    .clk_cfg = I2S_STD_CLK_DEFAULT_CONFIG(SAMPLE_RATE),
    .slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_32BIT, I2S_SLOT_MODE_MONO),
    .gpio_cfg = { .mclk = I2S_GPIO_UNUSED, .bclk = GPIO_NUM_26, .ws = GPIO_NUM_25, .dout = I2S_GPIO_UNUSED,
                  .din = GPIO_NUM_33, .invert_flags = { .mclk_inv = false, .bclk_inv = false, .ws_inv = false } },
  };
  cfg.slot_cfg.slot_mask = I2S_STD_SLOT_LEFT;
  cfg.slot_cfg.bit_shift = bitShift;
  i2s_channel_init_std_mode(rx, &cfg);
  i2s_channel_enable(rx);
}

static void measure(const char *name, bool bitShift) {
  static int32_t buf[256];
  configure(bitShift);
  uint32_t bitSet[32] = {0};
  uint32_t orBits = 0, andBits = 0xFFFFFFFFu, b31ne30 = 0, negative = 0, n = 0, total = 0;
  int32_t minHi = INT32_MAX, maxHi = INT32_MIN;
  while (n < MEASURE_SAMPLES) {
    size_t bytes = 0;
    i2s_channel_read(rx, buf, sizeof(buf), &bytes, 1000);
    for (size_t i = 0; i < bytes / 4; i++) {
      if (total++ < SETTLE_SAMPLES) continue;
      if (n >= MEASURE_SAMPLES) break;
      uint32_t w = (uint32_t)buf[i];
      orBits |= w;
      andBits &= w;
      for (int b = 0; b < 32; b++) bitSet[b] += (w >> b) & 1;
      if (((w >> 31) & 1) != ((w >> 30) & 1)) b31ne30++;
      if (w >> 31) negative++;
      int32_t hi = buf[i] >> 16;
      if (hi < minHi) minHi = hi;
      if (hi > maxHi) maxHi = hi;
      n++;
    }
  }
  i2s_channel_disable(rx);
  Serial.printf("[align] %s: n=%lu or=%08lx and=%08lx bit31!=bit30=%lu bit31set=%lu int16(>>16) min=%ld max=%ld\n",
                name, (unsigned long)n, (unsigned long)orBits, (unsigned long)andBits, (unsigned long)b31ne30,
                (unsigned long)negative, (long)minHi, (long)maxHi);
  Serial.printf("[align] %s: fraction of samples with each bit set, bit 31..0:", name);
  for (int b = 31; b >= 0; b--) Serial.printf(" %d:%.2f", b, (double)bitSet[b] / n);
  Serial.println();
}

void setup() {
  Serial.begin(115200);
  delay(500);
  i2s_chan_config_t chan = I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_0, I2S_ROLE_MASTER);
  i2s_new_channel(&chan, nullptr, &rx);
}

void loop() {
  measure("PHILIPS", true);
  i2s_del_channel(rx);
  i2s_chan_config_t chan = I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_0, I2S_ROLE_MASTER);
  i2s_new_channel(&chan, nullptr, &rx);
  measure("MSB", false);
  i2s_del_channel(rx);
  i2s_new_channel(&chan, nullptr, &rx);
  delay(1000);
}
