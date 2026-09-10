#include "gate.h"

/* How far below the trigger the signal has to fall before another crossing can
 * be counted. Without it, a pass that hovers within ADC noise of the trigger is
 * chopped into several laps. Proportional so it means the same thing at 1000
 * counts as at 3000, with a floor so it never disappears on a low trigger. */
static float rearmLevel(float threshold) {
  float margin = threshold * 0.03f;
  if (margin < 30.0f) margin = 30.0f;
  return threshold - margin;
}

float Median5::push(float v) {
  ring_[at_] = v;
  at_ = (uint8_t)((at_ + 1) % 5);
  if (n_ < 5) n_++;

  /* Insertion sort of at most five values. No allocation, no library, and it
   * runs in the sampling loop. */
  float s[5];
  for (uint8_t i = 0; i < n_; i++) s[i] = ring_[i];
  for (uint8_t i = 1; i < n_; i++) {
    float key = s[i];
    int8_t j = (int8_t)(i - 1);
    while (j >= 0 && s[j] > key) {
      s[j + 1] = s[j];
      j--;
    }
    s[j + 1] = key;
  }
  return s[n_ / 2];
}

void Gate::configure(float threshold, uint32_t minLapMs) {
  threshold_ = threshold;
  rearm_ = rearmLevel(threshold);
  minLapMs_ = minLapMs;
  /* A trigger that moved while a quad was mid-crossing would otherwise emit a
   * pass measured against the old level. Start the next one clean. */
  armed_ = false;
  peak_ = 0.0f;
}

void Gate::reset() {
  armed_ = false;
  peak_ = 0.0f;
  crossedAt_ = 0;
  lastPassAt_ = 0;
  havePass_ = false;
  passCount_ = 0;
  last_ = 0.0f;
}

bool Gate::sample(float rssi, uint32_t nowMs, Pass& out) {
  last_ = rssi;
  if (!enabled_ || threshold_ <= 0.0f) return false;

  if (!armed_) {
    if (rssi > threshold_) {
      armed_ = true;
      peak_ = rssi;
      crossedAt_ = nowMs;
    }
    return false;
  }

  if (rssi > peak_) peak_ = rssi;
  if (rssi >= rearm_) return false;  /* still in the gate */

  /* Falling edge: the crossing is over and its peak is known. */
  armed_ = false;
  float peak = peak_;
  peak_ = 0.0f;

  /* Subtraction rather than a comparison of absolutes: the clock this is given
   * is a millisecond counter that wraps, and unsigned subtraction gives the
   * right interval across the wrap where `a < b` does not. */
  if (havePass_ && minLapMs_ > 0 && (uint32_t)(crossedAt_ - lastPassAt_) < minLapMs_)
    return false;

  lastPassAt_ = crossedAt_;
  havePass_ = true;
  passCount_++;

  out.peak = peak > 65535.0f ? 65535 : (uint16_t)(peak + 0.5f);
  out.crossedAt = crossedAt_;
  return true;
}
