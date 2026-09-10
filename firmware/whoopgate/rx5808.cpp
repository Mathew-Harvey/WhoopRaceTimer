#include "rx5808.h"

#include <Arduino.h>

/* Synthesiser register B. The RTC6715's local oscillator is
 *
 *     f_lo = 2 * (N * 32 + A) + 479
 *
 * so tuning to an RF frequency means solving for N and A and writing them as
 * one 20-bit word, A in the low seven bits. This is the same arithmetic every
 * open RX5808 project uses, and it is the reason a frequency is written rather
 * than a channel: the receiver has no idea what "Raceband 8" means. */
#define REG_SYNTH_B 0x01

/* The RTC6715 latches on the rising edge and wants roughly a microsecond
 * either side. It is a slow bus and there is no reason to hurry it — tuning
 * happens when the app changes a channel, not in the sampling loop. */
static const int BIT_US = 1;

void Rx5808::begin(int clkPin, int dataPin, int selPin) {
  clk_ = clkPin;
  data_ = dataPin;
  sel_ = selPin;
  pinMode(clk_, OUTPUT);
  pinMode(data_, OUTPUT);
  pinMode(sel_, OUTPUT);
  digitalWrite(sel_, HIGH);
  digitalWrite(clk_, LOW);
  digitalWrite(data_, LOW);
}

void Rx5808::sendBit(uint8_t bit) {
  digitalWrite(clk_, LOW);
  delayMicroseconds(BIT_US);
  digitalWrite(data_, bit ? HIGH : LOW);
  delayMicroseconds(BIT_US);
  digitalWrite(clk_, HIGH);
  delayMicroseconds(BIT_US);
  digitalWrite(clk_, LOW);
  delayMicroseconds(BIT_US);
}

void Rx5808::writeRegister(uint8_t address, uint32_t data) {
  if (sel_ < 0) return;

  digitalWrite(sel_, LOW);
  delayMicroseconds(BIT_US);

  /* 25 bits, least significant first: four of address, one write flag, twenty
   * of payload. */
  for (int i = 0; i < 4; i++) sendBit((address >> i) & 1);
  sendBit(1);
  for (int i = 0; i < 20; i++) sendBit((data >> i) & 1);

  digitalWrite(sel_, HIGH);
  digitalWrite(clk_, LOW);
  digitalWrite(data_, LOW);
}

void Rx5808::setFrequency(uint16_t mhz) {
  if (mhz < 5600 || mhz > 6000) return;
  freq_ = mhz;

  uint32_t f = (uint32_t)((mhz - 479) / 2);
  uint32_t n = f / 32;
  uint32_t a = f % 32;
  writeRegister(REG_SYNTH_B, (n << 7) | (a & 0x7F));
}
