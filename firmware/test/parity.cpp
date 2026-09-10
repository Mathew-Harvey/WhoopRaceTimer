/* Emits every frame the firmware can put on the air, as hex, so
 * test_firmware_parity.py can hold it against laprf.py byte for byte.
 *
 * This compiles with plain g++ on a host. That is the point: the protocol layer
 * of this firmware is checkable without an ESP32, an RX5808, or a quad.
 */
#include <stdio.h>
#include <string.h>

#include "../whoopgate/gate.h"
#include "../whoopgate/laprf.h"

static void emit(const char* name, const uint8_t* buf, size_t n) {
  printf("%s ", name);
  for (size_t i = 0; i < n; i++) printf("%02x", buf[i]);
  printf("\n");
}

static uint8_t out[512];

int main() {
  laprf::Writer w(out, sizeof(out));

  /* ---- what a client sends. The firmware never sends these, but the encoder
   * is shared, and a divergence here is a divergence everywhere. ---- */
  for (int slot = 1; slot <= 4; slot++) {
    char name[32];
    snprintf(name, sizeof(name), "getRfSetup%d", slot);
    w.begin(laprf::RT_RF_SETUP);
    w.u8(laprf::RF_SLOT, (uint8_t)slot);
    emit(name, out, w.finish());
  }

  w.begin(laprf::RT_SETTINGS);
  w.u16(laprf::SET_STATUS_INTERVAL, 200);
  emit("setStatusInterval200", out, w.finish());

  w.begin(laprf::RT_SETTINGS);
  w.u32(laprf::SET_MIN_LAP, 3000);
  emit("setMinLap3000", out, w.finish());

  w.begin(laprf::RT_SETTINGS);
  w.u32(laprf::SET_MIN_LAP, 1000);
  emit("setMinLap1000", out, w.finish());

  w.begin(laprf::RT_RF_SETUP);
  w.u8(laprf::RF_SLOT, 1);
  w.u16(laprf::RF_ENABLED, 1);
  w.u16(laprf::RF_CHANNEL, 8);
  w.u16(laprf::RF_BAND, 2);
  w.f32(laprf::RF_THRESHOLD, 1600.0f);
  w.u16(laprf::RF_GAIN, 58);
  w.u16(laprf::RF_FREQ, 5917);
  emit("setRfSetupR8", out, w.finish());

  w.begin(laprf::RT_STATE_CONTROL);
  w.u8(laprf::SC_GATE_STATE, 1);
  emit("setGateStateActive", out, w.finish());

  /* ---- what this firmware actually puts on the air ---- */
  w.begin(laprf::RT_PASSING);
  w.u8(laprf::PS_SLOT, 1);
  w.u32(laprf::PS_PASSING_NUMBER, 1);
  w.u16(laprf::PS_PEAK_HEIGHT, 2915);
  emit("passing", out, w.finish());

  /* The status record, in the field order a real puck used — battery, gate
   * state, detection count, then slot/lastRssi pairs, then flags at the end.
   * The captured frame in tests/test_laprf_golden.py is the authority. */
  {
    const float rssi[8] = {958, 0, 0, 959, 0, 0, 0, 0};
    w.begin(laprf::RT_STATUS);
    w.u16(laprf::ST_BATTERY, 4033);
    w.u8(laprf::ST_GATE_STATE, 1);
    w.u32(laprf::ST_DETECT_COUNT, 0);
    for (int s = 0; s < 8; s++) {
      w.u8(laprf::ST_SLOT, (uint8_t)(s + 1));
      w.f32(laprf::ST_LAST_RSSI, rssi[s]);
    }
    w.u16(laprf::ST_FLAGS, 0);
    emit("status", out, w.finish());
  }

  /* ---- primitives ---- */
  printf("crcEmpty %04x\n", laprf::crc16(nullptr, 0));

  {
    /* Escaping must leave the frame bytes alone and rewrite only the interior. */
    const uint8_t body[4] = {0x5a, 0x5b, 0x5c, 0x5b};
    uint8_t esc[16];
    size_t n = 0;
    for (size_t i = 0; i < 4; i++) {
      bool interior = (i != 0 && i != 3);
      if (interior && (body[i] == 0x5a || body[i] == 0x5b || body[i] == 0x5c)) {
        esc[n++] = 0x5c;
        esc[n++] = (uint8_t)(body[i] + 0x40);
      } else {
        esc[n++] = body[i];
      }
    }
    emit("escaped", esc, n);
  }

  /* ---- decoding. Feed the captured status frame through the framer exactly as
   * it arrives over BLE: junk in front, then the record, then half of another. */
  {
    static const char STATUS_HEX[] =
        "5a61008f1a0ada2102c10f230101240400000000010101220400806f4401010222040000"
        "0000010103220400000000010104220400c06f4401010522040000000001010622040000"
        "0000010107220400000000010108220400000000030200005b";
    uint8_t frame[256];
    size_t flen = strlen(STATUS_HEX) / 2;
    for (size_t i = 0; i < flen; i++) {
      unsigned byte;
      sscanf(STATUS_HEX + i * 2, "%2x", &byte);
      frame[i] = (uint8_t)byte;
    }

    laprf::Framer f;
    int found = 0;
    uint16_t battery = 0, gate = 0;
    float slot1 = -1, slot4 = -1;

    const uint8_t junk[2] = {0x00, 0x11};
    for (uint8_t b : junk) f.feed(b);
    for (size_t i = 0; i < flen; i++) {
      if (!f.feed(frame[i])) continue;
      found++;
      laprf::Reader r(f.record(), f.recordLen());
      printf("decodeOk %d\n", r.ok() ? 1 : 0);
      printf("decodeType %04x\n", r.type());
      laprf::Field fld;
      uint8_t cur = 0;
      while (r.next(fld)) {
        if (fld.sig == laprf::ST_BATTERY) battery = fld.u16();
        else if (fld.sig == laprf::ST_GATE_STATE) gate = fld.u8();
        else if (fld.sig == laprf::ST_SLOT) cur = fld.u8();
        else if (fld.sig == laprf::ST_LAST_RSSI) {
          if (cur == 1) slot1 = fld.f32();
          if (cur == 4) slot4 = fld.f32();
        }
      }
    }
    for (size_t i = 0; i < 9; i++) if (f.feed(frame[i])) found++;  /* partial tail */

    printf("framedRecords %d\n", found);
    printf("decodeBattery %u\n", battery);
    printf("decodeGate %u\n", gate);
    printf("decodeSlot1 %.0f\n", slot1);
    printf("decodeSlot4 %.0f\n", slot4);
  }

  /* A record with a corrupted CRC must be refused, not half-believed. */
  {
    w.begin(laprf::RT_STATE_CONTROL);
    w.u8(laprf::SC_GATE_STATE, 1);
    size_t n = w.finish();
    uint8_t bad[64];
    memcpy(bad, out, n);
    bad[3] ^= 0xFF;
    laprf::Reader r(bad, n);
    printf("crcRejected %d\n", r.ok() ? 0 : 1);
  }

  /* ---- the gate, which is the part with no hardware in it ---- */
  {
    Gate g;
    g.configure(1600.0f, 1000);
    int passes = 0;
    uint16_t peak = 0;

    /* quiet, then a pass that peaks at 2900, then quiet */
    for (int t = 0; t < 50; t++) g.sample(950.0f, (uint32_t)(t * 10));
    const float rise[9] = {1200, 1800, 2400, 2900, 2600, 2000, 1500, 1100, 950};
    for (int i = 0; i < 9; i++) {
      Gate::Pass p;
      if (g.sample(rise[i], (uint32_t)(500 + i * 10), p)) { passes++; peak = p.peak; }
    }
    for (int t = 0; t < 50; t++) g.sample(950.0f, (uint32_t)(600 + t * 10));
    printf("gatePasses %d\n", passes);
    printf("gatePeak %u\n", peak);

    /* A second crossing inside the minimum lap time is not a lap. */
    int suppressed = 0;
    for (int i = 0; i < 9; i++) {
      Gate::Pass p;
      if (g.sample(rise[i], (uint32_t)(1200 + i * 10), p)) suppressed++;
    }
    printf("gateMinLapSuppressed %d\n", suppressed == 0 ? 1 : 0);

    /* Past the minimum lap time it counts again. */
    int later = 0;
    for (int t = 0; t < 20; t++) g.sample(950.0f, (uint32_t)(1300 + t * 10));
    for (int i = 0; i < 9; i++) {
      Gate::Pass p;
      if (g.sample(rise[i], (uint32_t)(2000 + i * 10), p)) later++;
    }
    printf("gateCountsAgain %d\n", later);

    /* A quad hovering above the trigger is one crossing, not a lap per sample. */
    Gate h;
    h.configure(1600.0f, 1000);
    int hover = 0;
    for (int t = 0; t < 200; t++) {
      Gate::Pass p;
      if (h.sample(2200.0f, (uint32_t)(t * 10), p)) hover++;
    }
    printf("gateHoverPasses %d\n", hover);

    /* A trigger under the noise floor can never see an edge. The app refuses to
     * write one, but a club can type one in, and the firmware must not then
     * invent a lap on every sample. */
    Gate b;
    b.configure(700.0f, 1000);
    int below = 0;
    for (int t = 0; t < 200; t++) {
      Gate::Pass p;
      if (b.sample(950.0f, (uint32_t)(t * 10), p)) below++;
    }
    printf("gateBelowFloorPasses %d\n", below);

    /* A pass that dithers across the trigger inside ADC noise is one crossing.
     * Minimum lap is off here on purpose, so this measures the hysteresis and
     * not the lap filter standing in for it. */
    Gate d;
    d.configure(1600.0f, 0);
    const float dither[7] = {1400, 1700, 1580, 1700, 1590, 1700, 1400};
    int chopped = 0;
    for (int i = 0; i < 7; i++) {
      Gate::Pass p;
      if (d.sample(dither[i], (uint32_t)(i * 10), p)) chopped++;
    }
    printf("gateDitherPasses %d\n", chopped);
  }

  /* ---- the median that stands between the ADC and the trigger ---- */
  {
    Median5 m;
    /* A single wild sample among quiet ones must not reach the trigger. */
    float quiet[5] = {950, 951, 4000, 949, 950};
    float last = 0;
    for (float v : quiet) last = m.push(v);
    printf("medianRejectsSpike %.0f\n", last);

    /* A real pass lasts many samples and must survive intact. */
    Median5 p;
    float pass[9] = {950, 1200, 1800, 2400, 2900, 2900, 2900, 2900, 2900};
    for (float v : pass) last = p.push(v);
    printf("medianKeepsPass %.0f\n", last);

    /* And it must be usable from the first sample, not after five. */
    Median5 f;
    printf("medianFirstSample %.0f\n", f.push(950));
  }

  return 0;
}
