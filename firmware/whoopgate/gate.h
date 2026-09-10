/* Pass detection: the part of a timer that decides a quad went through.
 *
 * Portable C++ with no Arduino in it, for the same reason as laprf.h — this is
 * the logic that decides whether a lap happened, and "it looked right on the
 * bench" is not a standard a timing device gets to be held to. It is exercised
 * by firmware/test/parity.cpp on a host.
 *
 * What a LapRF does, and what this does differently.
 *
 * A LapRF re-triggers while a quad sits in the gate, which is why the app has a
 * minimum lap time at all — the README's words are "one hovering in the gate
 * otherwise racks up a dozen laps". This is edge-triggered instead: one crossing
 * yields one passing record, emitted when the signal falls away again, and a
 * quad that hovers over the trigger produces nothing until it leaves. The
 * minimum lap time is still honoured on top of that, because two real laps
 * flown impossibly close together are still worth refusing.
 *
 * The record is emitted on the falling edge and not the rising one, because the
 * app calibrates its gate from the peak height the timer reports, and a peak is
 * not known until the pass is over. The timestamp carried in the record is the
 * moment the signal crossed the trigger on the way up, so lap times are not
 * lengthened by the width of the pass — only the record's arrival is.
 */
#pragma once
#include <stdint.h>

/** Median of the last five samples. A single wild reading — an ADC glitch, a
 *  receiver re-tuning — is outvoted; a real pass spans dozens of samples and is
 *  untouched. This sits between the ADC and the Gate, because that is where the
 *  noise is, and keeping it out of Gate keeps the trigger logic testable with
 *  the exact numbers a test names. */
class Median5 {
 public:
  float push(float v);
  void reset() { n_ = 0; }

 private:
  float ring_[5] = {0, 0, 0, 0, 0};
  uint8_t n_ = 0;
  uint8_t at_ = 0;
};

class Gate {
 public:
  struct Pass {
    uint16_t peak;      /* highest sample of the crossing, in LapRF counts */
    uint32_t crossedAt; /* ms, when it went over the trigger on the way up */
  };

  /** threshold in LapRF counts, minLapMs 0 to disable the filter. */
  void configure(float threshold, uint32_t minLapMs);

  void setEnabled(bool on) { enabled_ = on; }
  bool enabled() const { return enabled_; }

  float threshold() const { return threshold_; }
  float lastRssi() const { return last_; }
  uint32_t passCount() const { return passCount_; }

  /** Feed one filtered sample. Returns true and fills `out` when a crossing has
   *  completed and counts as a lap. */
  bool sample(float rssi, uint32_t nowMs, Pass& out);

  /** For callers that do not care about the result. */
  void sample(float rssi, uint32_t nowMs) {
    Pass ignored;
    sample(rssi, nowMs, ignored);
  }

  void reset();

 private:
  float threshold_ = 0.0f;
  float rearm_ = 0.0f;
  uint32_t minLapMs_ = 0;
  float last_ = 0.0f;

  bool enabled_ = true;
  bool armed_ = false;
  float peak_ = 0.0f;
  uint32_t crossedAt_ = 0;
  uint32_t lastPassAt_ = 0;
  bool havePass_ = false;
  uint32_t passCount_ = 0;
};
