/* Tuning an RX5808 (RTC6715) over its three-wire SPI.
 *
 * The module ships with SPI disabled on many batches: a single SMD resistor
 * ties it to hardware channel-select pins, and until that resistor is removed
 * the receiver ignores everything written here and sits on one fixed channel
 * forever. Nothing in software detects that — the write succeeds, there is no
 * read-back path worth trusting, and the only symptom is a receiver whose
 * signal does not depend on the frequency it was told to use.
 *
 * If your gate reads the same level on every channel, that resistor is the
 * first thing to check, not this file.
 */
#pragma once
#include <stdint.h>

class Rx5808 {
 public:
  /** clk and data are shared across every module; sel is this one's alone. */
  void begin(int clkPin, int dataPin, int selPin);

  /** Tune to a frequency in MHz. Ignores anything outside the 5.8 GHz band. */
  void setFrequency(uint16_t mhz);

  uint16_t frequency() const { return freq_; }

 private:
  void writeRegister(uint8_t address, uint32_t data);
  void sendBit(uint8_t bit);

  int clk_ = -1, data_ = -1, sel_ = -1;
  uint16_t freq_ = 0;
};
