/* LapRF binary protocol — encoder and streaming decoder, for a gate that IS a
 * LapRF rather than one that is translated into being one.
 *
 * Portable C++ on purpose: no Arduino headers anywhere in this file or its .cpp,
 * so firmware/test/parity.cpp compiles it with g++ on a host and checks every
 * frame byte-for-byte against laprf.py — the reference implementation that was
 * cross-checked against three independent decoders and pinned to real captured
 * hardware bytes in tests/test_laprf_golden.py.
 *
 * That is the whole reason the protocol lives in its own file. Firmware you
 * cannot test without hardware is firmware you find out about at a track.
 *
 * Framing:  SOR | length u16le | crc u16le | recordType u16le | fields | EOR
 *   length = total record byte count including SOR and EOR
 *   crc    = CRC-16 (reflected poly 0x8005, init 0) over the record, crc zeroed
 *   field  = signature u8 | byteLength u8 | value, little endian
 * Escaping is applied last, to interior bytes equal to SOR/EOR/ESC, which
 * become ESC followed by the byte plus 0x40.
 */
#pragma once
#include <stddef.h>
#include <stdint.h>

namespace laprf {

enum : uint8_t { SOR = 0x5A, EOR = 0x5B, ESC = 0x5C, ESC_OFFSET = 0x40 };

enum : uint16_t {
  RT_RSSI = 0xDA01,
  RT_RF_SETUP = 0xDA02,
  RT_STATE_CONTROL = 0xDA04,
  RT_SETTINGS = 0xDA07,
  RT_DESCRIPTOR = 0xDA08,
  RT_PASSING = 0xDA09,
  RT_STATUS = 0xDA0A,
  RT_TIME = 0xDA0C,
};

/* rfSetup */
enum : uint8_t {
  RF_SLOT = 0x01, RF_ENABLED = 0x20, RF_CHANNEL = 0x21, RF_BAND = 0x22,
  RF_THRESHOLD = 0x23, RF_GAIN = 0x24, RF_FREQ = 0x25,
};
/* passing */
enum : uint8_t {
  PS_SLOT = 0x01, PS_RTC_TIME = 0x02, PS_DECODER_ID = 0x20,
  PS_PASSING_NUMBER = 0x21, PS_PEAK_HEIGHT = 0x22, PS_FLAGS = 0x23,
};
/* status */
enum : uint8_t {
  ST_SLOT = 0x01, ST_FLAGS = 0x03, ST_BATTERY = 0x21,
  ST_LAST_RSSI = 0x22, ST_GATE_STATE = 0x23, ST_DETECT_COUNT = 0x24,
};
/* settings */
enum : uint8_t { SET_STATUS_INTERVAL = 0x22, SET_SAVE = 0x25, SET_MIN_LAP = 0x26 };
/* stateControl */
enum : uint8_t { SC_GATE_STATE = 0x20 };
/* time */
enum : uint8_t { TF_RTC_TIME = 0x02, TF_TIME_RTC_TIME = 0x20 };

/* Gate state, as the app names it. `crashed` is a real thing a LapRF reports,
 * and the app says it out loud — so this firmware must never send it lightly. */
enum : uint8_t { GATE_IDLE = 0x00, GATE_ACTIVE = 0x01, GATE_CRASHED = 0x02 };

/* Band index order is "FREBA", so Raceband is 2 and not 1. Getting this wrong
 * puts every pilot on the wrong frequency, silently. */
extern const char BAND_ORDER[6];

/** Frequency in MHz for a 1-based band index and 1-based channel, 0 if out of
 *  range. Band 1..5 = F R E B A. */
uint16_t frequencyFor(uint8_t bandIndex, uint8_t channel);

uint16_t crc16(const uint8_t* buf, size_t len);

/** Build one record. Fields are appended in call order, which matters: the app
 *  reads a status record as a stream and binds lastRssi to whichever slot field
 *  preceded it. */
class Writer {
 public:
  Writer(uint8_t* out, size_t cap) : out_(out), cap_(cap) {}

  void begin(uint16_t recordType);
  void u8(uint8_t sig, uint8_t v);
  void u16(uint8_t sig, uint16_t v);
  void u32(uint8_t sig, uint32_t v);
  void u64(uint8_t sig, uint64_t v);
  void f32(uint8_t sig, float v);

  /** Close the record, escape it into the output buffer, and return its length.
   *  Returns 0 if it did not fit — a truncated record is a corrupt one, so the
   *  caller gets nothing rather than something plausible. */
  size_t finish();

 private:
  void raw(uint8_t b);
  uint8_t* out_;
  size_t cap_;
  uint8_t buf_[256];
  size_t len_ = 0;
  bool overflow_ = false;
};

/** Reassembles records out of a byte stream that arrives in 20-byte BLE chunks,
 *  with junk, back-to-back records and records cut in half — all of which a real
 *  radio delivers. Unescapes as it goes. */
class Framer {
 public:
  /** Feed one byte. Returns true when `record()`/`recordLen()` hold a complete
   *  unescaped record, including its SOR and EOR. */
  bool feed(uint8_t b);
  const uint8_t* record() const { return rec_; }
  size_t recordLen() const { return recLen_; }
  void reset() { inRecord_ = false; esc_ = false; len_ = 0; recLen_ = 0; }

 private:
  uint8_t buf_[256];
  uint8_t rec_[256];
  size_t len_ = 0;
  size_t recLen_ = 0;
  bool inRecord_ = false;
  bool esc_ = false;
};

struct Field {
  uint8_t sig;
  uint8_t len;
  const uint8_t* data;

  uint8_t u8() const;
  uint16_t u16() const;
  uint32_t u32() const;
  uint64_t u64() const;
  float f32() const;
};

/** Walks the fields of one unescaped record. Verifies the CRC first: `ok()` is
 *  false for anything that did not survive the air. */
class Reader {
 public:
  Reader(const uint8_t* rec, size_t len);
  bool ok() const { return ok_; }
  uint16_t type() const { return type_; }
  bool next(Field& f);

 private:
  const uint8_t* rec_;
  size_t len_;
  size_t pos_;
  uint16_t type_ = 0;
  bool ok_ = false;
};

}  // namespace laprf
