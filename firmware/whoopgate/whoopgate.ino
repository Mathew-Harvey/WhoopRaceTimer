/* WhoopGate — a lap timer that IS a LapRF, over Bluetooth LE.
 *
 * An ESP32 and up to four RX5808 receivers. The browser at
 * whooptimer.webfpv.org connects to it directly with Web Bluetooth: no bridge,
 * no laptop, no cable, no driver. As far as the app is concerned this is a
 * LapRF, because every frame it emits is a frame a LapRF emits — checked byte
 * for byte against the reference implementation by
 * firmware/test/test_firmware_parity.py, which runs on a host with no hardware
 * attached.
 *
 * What is honest about this build, and what is not:
 *
 *   The protocol layer is tested. Thirty-one checks, including a status record
 *   compared against bytes captured from a real puck.
 *
 *   The pass detector is tested. One crossing is one lap, a trigger under the
 *   noise floor invents nothing, and a pass dithering across the trigger is not
 *   chopped into several.
 *
 *   The signal scale is NOT measured on your hardware. RSSI_MV_QUIET and
 *   RSSI_MV_PEAK in config.h come from the RX5808's typical output range, not
 *   from your module. Send `r` over the serial monitor and set them to what you
 *   actually read. Everything the app decides about a gate is denominated in
 *   those two numbers.
 *
 *   Nothing here has been run against a quad. Bring it up on the bench, watch
 *   the gate screen, and believe the meter rather than this comment.
 */
#include <Arduino.h>

#include "ble.h"
#include "config.h"
#include "gate.h"
#include "laprf.h"
#include "rx5808.h"

/* ------------------------------------------------------------------ state -- */
struct Slot {
  Rx5808 rx;
  Gate gate;
  Median5 filter;

  bool enabled = false;
  uint8_t band = DEFAULT_BAND;
  uint8_t channel = 1;
  uint16_t frequency = 0;
  float threshold = DEFAULT_THRESHOLD;
  uint16_t gain = 58;
  float lastRssi = 0.0f;
  uint32_t passingNumber = 0;
};

static Slot slots[NUM_RX];
static BleUart ble;
static laprf::Framer framer;

static uint32_t minLapMs = DEFAULT_MIN_LAP_MS;
static uint16_t statusIntervalMs = DEFAULT_STATUS_INTERVAL_MS;
static uint8_t gateState = laprf::GATE_ACTIVE;
static uint32_t detectionCount = 0;

static uint32_t lastStatusAt = 0;
static uint32_t lastSampleAt = 0;

static uint8_t txBuf[512];

/* --------------------------------------------------------------- signal --- */
/* Millivolts on the receiver's RSSI pin, onto the scale the app reasons in.
 * See the long note in config.h: the two endpoints are the only thing standing
 * between this gate and every constant in the app meaning something else. */
static float countsFromMillivolts(float mv) {
  const float span = (float)(RSSI_MV_PEAK - RSSI_MV_QUIET);
  if (span <= 0.0f) return LAPRF_QUIET;
  float t = (mv - (float)RSSI_MV_QUIET) / span;
  float counts = LAPRF_QUIET + t * (LAPRF_PEAK - LAPRF_QUIET);
  /* The app treats a reading of zero as a receiver that is saying nothing, so
   * a quiet room must never round into one. */
  if (counts < 1.0f) counts = 1.0f;
  if (counts > 65000.0f) counts = 65000.0f;
  return counts;
}

static float readMillivolts(int pin) {
  uint32_t sum = 0;
  for (int i = 0; i < ADC_OVERSAMPLE; i++) sum += analogReadMilliVolts(pin);
  return (float)sum / (float)ADC_OVERSAMPLE;
}

static uint16_t readBatteryMillivolts() {
#if PIN_BATTERY >= 0
  return (uint16_t)(readMillivolts(PIN_BATTERY) * BATTERY_DIVIDER);
#else
  /* Zero, not a plausible-looking number. The app hides the battery pill when
   * a timer does not report one, which is the truth here. */
  return 0;
#endif
}

/* ------------------------------------------------------------- outbound --- */
static void sendStatus() {
  laprf::Writer w(txBuf, sizeof(txBuf));
  w.begin(laprf::RT_STATUS);
  w.u16(laprf::ST_BATTERY, readBatteryMillivolts());
  w.u8(laprf::ST_GATE_STATE, gateState);
  w.u32(laprf::ST_DETECT_COUNT, detectionCount);
  /* Eight slots, in the shape a real puck sends: the app binds each lastRssi to
   * the slot field before it, so the pairing is the wire format. Receivers this
   * gate does not have report nothing, and their rfSetup says they are off. */
  for (int s = 1; s <= 8; s++) {
    w.u8(laprf::ST_SLOT, (uint8_t)s);
    w.f32(laprf::ST_LAST_RSSI, s <= NUM_RX ? slots[s - 1].lastRssi : 0.0f);
  }
  w.u16(laprf::ST_FLAGS, 0);
  size_t n = w.finish();
  if (n) ble.send(txBuf, n);
}

static void sendPassing(int index, const Gate::Pass& pass) {
  Slot& sl = slots[index];
  laprf::Writer w(txBuf, sizeof(txBuf));
  w.begin(laprf::RT_PASSING);
  w.u8(laprf::PS_SLOT, (uint8_t)(index + 1));
  /* Milliseconds. The app divides this difference by a thousand and compares it
   * against its own measurement of the same lap; microseconds here would fail
   * that check silently and throw away the hardware timing entirely. */
  w.u64(laprf::PS_RTC_TIME, (uint64_t)pass.crossedAt);
  w.u32(laprf::PS_PASSING_NUMBER, sl.passingNumber);
  w.u16(laprf::PS_PEAK_HEIGHT, pass.peak);
  w.u16(laprf::PS_FLAGS, 0);
  size_t n = w.finish();
  if (n) ble.send(txBuf, n);
}

static void sendRfSetup(uint8_t slotNumber) {
  bool real = (slotNumber >= 1 && slotNumber <= NUM_RX);
  const Slot* sl = real ? &slots[slotNumber - 1] : nullptr;

  laprf::Writer w(txBuf, sizeof(txBuf));
  w.begin(laprf::RT_RF_SETUP);
  w.u8(laprf::RF_SLOT, slotNumber);
  w.u16(laprf::RF_ENABLED, (real && sl->enabled) ? 1 : 0);
  w.u16(laprf::RF_CHANNEL, real ? sl->channel : 1);
  w.u16(laprf::RF_BAND, real ? sl->band : DEFAULT_BAND);
  w.f32(laprf::RF_THRESHOLD, real ? sl->threshold : 0.0f);
  w.u16(laprf::RF_GAIN, real ? sl->gain : 0);
  w.u16(laprf::RF_FREQ, real ? sl->frequency : 0);
  size_t n = w.finish();
  if (n) ble.send(txBuf, n);
}

/* -------------------------------------------------------------- inbound --- */
static void applyRfSetup(const uint8_t* rec, size_t len) {
  laprf::Reader r(rec, len);
  if (!r.ok()) return;

  uint8_t slotNumber = 0;
  bool sawOnlySlot = true;
  bool haveEnabled = false, haveBand = false, haveChannel = false;
  bool haveThreshold = false, haveGain = false, haveFreq = false;
  uint16_t enabled = 0, band = 0, channel = 0, gain = 0, freq = 0;
  float threshold = 0.0f;

  laprf::Field f;
  while (r.next(f)) {
    switch (f.sig) {
      case laprf::RF_SLOT: slotNumber = f.u8(); break;
      case laprf::RF_ENABLED: enabled = f.u16(); haveEnabled = true; sawOnlySlot = false; break;
      case laprf::RF_CHANNEL: channel = f.u16(); haveChannel = true; sawOnlySlot = false; break;
      case laprf::RF_BAND: band = f.u16(); haveBand = true; sawOnlySlot = false; break;
      case laprf::RF_THRESHOLD: threshold = f.f32(); haveThreshold = true; sawOnlySlot = false; break;
      case laprf::RF_GAIN: gain = f.u16(); haveGain = true; sawOnlySlot = false; break;
      case laprf::RF_FREQ: freq = f.u16(); haveFreq = true; sawOnlySlot = false; break;
      default: break;
    }
  }

  /* A record carrying nothing but a slot number is a question, not an order. */
  if (sawOnlySlot) {
    if (slotNumber >= 1 && slotNumber <= 8) sendRfSetup(slotNumber);
    return;
  }

  /* A write aimed at a receiver this gate does not have is refused rather than
   * absorbed. The app asks three times and then says so out loud, which is the
   * right outcome — quietly accepting it would show four gates where there are
   * two, on one frequency, and put a pilot on somebody else's receiver. */
  if (slotNumber < 1 || slotNumber > NUM_RX) {
    if (slotNumber >= 1 && slotNumber <= 8) sendRfSetup(slotNumber);
    return;
  }

  Slot& sl = slots[slotNumber - 1];
  if (haveEnabled) {
    sl.enabled = (enabled != 0);
    sl.gate.setEnabled(sl.enabled);
  }
  if (haveBand) sl.band = (uint8_t)band;
  if (haveChannel) sl.channel = (uint8_t)channel;
  if (haveGain) sl.gain = gain;
  if (haveThreshold) {
    sl.threshold = threshold;
    sl.gate.configure(sl.threshold, minLapMs);
  }

  /* Prefer the frequency the app named. Band and channel are a label for it,
   * and the receiver has no idea what "Raceband 8" means — but if only the
   * label arrived, derive the number rather than sit on the old channel. */
  uint16_t want = haveFreq && freq ? freq : laprf::frequencyFor(sl.band, sl.channel);
  if (want && want != sl.frequency) {
    sl.frequency = want;
    sl.rx.setFrequency(want);
    /* The receiver has moved. Everything in the filter was measured somewhere
     * else, and a window straddling a retune takes its quiet level from the
     * lower of two frequencies — which is how a gate counts a lap a second on
     * an empty track. */
    sl.filter.reset();
    sl.gate.configure(sl.threshold, minLapMs);
  }
}

static void applySettings(const uint8_t* rec, size_t len) {
  laprf::Reader r(rec, len);
  if (!r.ok()) return;
  laprf::Field f;
  while (r.next(f)) {
    if (f.sig == laprf::SET_MIN_LAP) {
      minLapMs = f.u32();
      for (int i = 0; i < NUM_RX; i++) slots[i].gate.configure(slots[i].threshold, minLapMs);
    } else if (f.sig == laprf::SET_STATUS_INTERVAL) {
      uint16_t ms = f.u16();
      /* Faster than the radio can carry is not faster. */
      if (ms < 50) ms = 50;
      statusIntervalMs = ms;
    }
  }
}

static void applyStateControl(const uint8_t* rec, size_t len) {
  laprf::Reader r(rec, len);
  if (!r.ok()) return;
  laprf::Field f;
  while (r.next(f)) {
    if (f.sig == laprf::SC_GATE_STATE) gateState = f.u8();
  }
}

static void sendTime() {
  laprf::Writer w(txBuf, sizeof(txBuf));
  w.begin(laprf::RT_TIME);
  w.u64(laprf::TF_RTC_TIME, (uint64_t)millis());
  w.u64(laprf::TF_TIME_RTC_TIME, (uint64_t)millis());
  size_t n = w.finish();
  if (n) ble.send(txBuf, n);
}

static void handleRecord(const uint8_t* rec, size_t len) {
  laprf::Reader r(rec, len);
  if (!r.ok()) return;
  switch (r.type()) {
    case laprf::RT_RF_SETUP: applyRfSetup(rec, len); break;
    case laprf::RT_SETTINGS: applySettings(rec, len); break;
    case laprf::RT_STATE_CONTROL: applyStateControl(rec, len); break;
    case laprf::RT_TIME: sendTime(); break;
    default: break;
  }
}

/* --------------------------------------------------------------- serial --- */
static void printDiagnostics() {
  /* Integers only. This is the tool somebody calibrates with, and whether %f
   * prints anything depends on how the core was built — a diagnostic that
   * silently emits nothing is worse than no diagnostic at all. */
  Serial.println();
  Serial.println("slot  mV     counts  trigger  freq   enabled  laps");
  for (int i = 0; i < NUM_RX; i++) {
    Slot& sl = slots[i];
    int mv = (int)(readMillivolts(PIN_RSSI[i]) + 0.5f);
    Serial.printf("%-5d %-6d %-7d %-8d %-6u %-8s %lu\n", i + 1, mv,
                  (int)(countsFromMillivolts((float)mv) + 0.5f),
                  (int)(sl.threshold + 0.5f), sl.frequency,
                  sl.enabled ? "yes" : "no",
                  (unsigned long)sl.gate.passCount());
  }
  Serial.printf("map: %d mV -> %d counts, %d mV -> %d counts   (config.h)\n",
                RSSI_MV_QUIET, (int)LAPRF_QUIET, RSSI_MV_PEAK, (int)LAPRF_PEAK);
  Serial.printf("link: %s   min lap %lu ms   status every %u ms   gate 0x%02x\n",
                ble.connected() ? "connected" : "advertising",
                (unsigned long)minLapMs, statusIntervalMs, gateState);
}

static void handleSerial() {
  while (Serial.available()) {
    int c = Serial.read();
    if (c == 'r' || c == 'R') {
      printDiagnostics();
    } else if (c == '?' || c == 'h') {
      Serial.println("r  read every receiver, to calibrate RSSI_MV_* in config.h");
      Serial.println("?  this");
    }
  }
}

/* ----------------------------------------------------------------- main --- */
void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.println();
  Serial.println("WhoopGate — a LapRF-compatible gate over Bluetooth LE");
  Serial.printf("%d receiver(s). Send ? for commands.\n", NUM_RX);

#if PIN_LED >= 0
  pinMode(PIN_LED, OUTPUT);
  digitalWrite(PIN_LED, LOW);
#endif

  /* 11 dB of attenuation puts the full ~0-3.1 V range on the pin, which covers
   * an RX5808's RSSI output with room to spare. analogReadMilliVolts() then
   * applies this chip's factory calibration, so the numbers in config.h are a
   * property of the receiver rather than of this particular ESP32. */
  analogReadResolution(12);
  for (int i = 0; i < NUM_RX; i++) {
    analogSetPinAttenuation(PIN_RSSI[i], ADC_11db);
  }
#if PIN_BATTERY >= 0
  analogSetPinAttenuation(PIN_BATTERY, ADC_11db);
#endif

  /* Raceband 1, 3, 6, 8 — the spread the manual recommends for four pilots.
   * Overwritten by the app within a second of connecting; this only decides
   * what the gate is listening to before anyone has told it. */
  static const uint8_t defaultChannels[4] = {1, 3, 6, 8};
  for (int i = 0; i < NUM_RX; i++) {
    Slot& sl = slots[i];
    sl.rx.begin(PIN_SPI_CLK, PIN_SPI_DATA, PIN_RX_SEL[i]);
    sl.channel = defaultChannels[i % 4];
    sl.band = DEFAULT_BAND;
    sl.frequency = laprf::frequencyFor(sl.band, sl.channel);
    sl.enabled = true;
    sl.threshold = DEFAULT_THRESHOLD;
    sl.gate.configure(sl.threshold, minLapMs);
    sl.gate.setEnabled(true);
    delay(10);
    sl.rx.setFrequency(sl.frequency);
    Serial.printf("  slot %d: %c%d, %u MHz\n", i + 1,
                  laprf::BAND_ORDER[sl.band - 1], sl.channel, sl.frequency);
  }

  /* The receivers need a moment after power-on before their RSSI means
   * anything, and the first samples of a session become the app's noise floor. */
  delay(500);

  ble.begin(DEVICE_NAME);
  Serial.printf("advertising as %s\n", DEVICE_NAME);
}

void loop() {
  handleSerial();

  if (ble.takeConnectionChange()) {
    framer.reset();
    Serial.println(ble.connected() ? "client connected" : "client gone, advertising");
#if PIN_LED >= 0
    digitalWrite(PIN_LED, ble.connected() ? HIGH : LOW);
#endif
  }

  /* Inbound bytes, framed into records. Records arrive in 20-byte pieces with
   * gaps between them, so this has to survive being fed half of one. */
  uint8_t in[128];
  size_t n;
  while ((n = ble.read(in, sizeof(in))) > 0) {
    for (size_t i = 0; i < n; i++)
      if (framer.feed(in[i])) handleRecord(framer.record(), framer.recordLen());
  }

  const uint32_t now = millis();

  if ((uint32_t)(now - lastSampleAt) >= (1000 / SAMPLE_HZ)) {
    lastSampleAt = now;
    for (int i = 0; i < NUM_RX; i++) {
      Slot& sl = slots[i];
      float counts = countsFromMillivolts(readMillivolts(PIN_RSSI[i]));
      sl.lastRssi = sl.filter.push(counts);

      Gate::Pass pass;
      if (!sl.gate.sample(sl.lastRssi, now, pass)) continue;
      if (gateState != laprf::GATE_ACTIVE) continue;
      sl.passingNumber++;
      detectionCount++;
      sendPassing(i, pass);
      Serial.printf("slot %d lap %lu, peak %u\n", i + 1,
                    (unsigned long)sl.passingNumber, pass.peak);
    }
  }

  if ((uint32_t)(now - lastStatusAt) >= statusIntervalMs) {
    lastStatusAt = now;
    if (ble.connected()) sendStatus();
  }
}
