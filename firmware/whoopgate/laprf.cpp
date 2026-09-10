#include "laprf.h"

#include <string.h>

namespace laprf {

const char BAND_ORDER[6] = "FREBA";

/* The standard tables. Raceband is index 2 because the order is FREBA. */
static const uint16_t BAND_FREQ[5][8] = {
    /* F */ {5740, 5760, 5780, 5800, 5820, 5840, 5860, 5880},
    /* R */ {5658, 5695, 5732, 5769, 5806, 5843, 5880, 5917},
    /* E */ {5705, 5685, 5665, 5645, 5885, 5905, 5925, 5945},
    /* B */ {5733, 5752, 5771, 5790, 5809, 5828, 5847, 5866},
    /* A */ {5865, 5845, 5825, 5805, 5785, 5765, 5745, 5725},
};

uint16_t frequencyFor(uint8_t bandIndex, uint8_t channel) {
  if (bandIndex < 1 || bandIndex > 5 || channel < 1 || channel > 8) return 0;
  return BAND_FREQ[bandIndex - 1][channel - 1];
}

/* ------------------------------------------------------------------- crc -- */
/* Reflected poly 0x8005, init 0. Each input byte is reflected on the way in and
 * the remainder reflected on the way out, which is what the reference does and
 * what the hardware agrees with. The table is built once at first use rather
 * than stored, because 512 bytes of flash is worth more than 8 microseconds. */
static uint16_t crcTable[256];
static bool crcReady = false;

static uint8_t reflect8(uint8_t v) {
  uint8_t o = 0;
  for (int i = 0; i < 8; i++)
    if (v & (1u << i)) o = (uint8_t)(o | (1u << (7 - i)));
  return o;
}

static uint16_t reflect16(uint16_t v) {
  uint16_t o = 0;
  for (int i = 0; i < 16; i++)
    if (v & (1u << i)) o = (uint16_t)(o | (1u << (15 - i)));
  return o;
}

static void buildCrcTable() {
  for (int i = 0; i < 256; i++) {
    uint16_t r = (uint16_t)((i << 8) & 0xFF00);
    for (int b = 0; b < 8; b++)
      r = (r & 0x8000) ? (uint16_t)(((r << 1) & 0xFFFF) ^ 0x8005)
                       : (uint16_t)((r << 1) & 0xFFFF);
    crcTable[i] = r;
  }
  crcReady = true;
}

uint16_t crc16(const uint8_t* buf, size_t len) {
  if (!crcReady) buildCrcTable();
  uint16_t rem = 0;
  for (size_t i = 0; i < len; i++) {
    uint8_t a = reflect8(buf[i]);
    uint8_t b = (uint8_t)((rem >> 8) & 0xFF);
    uint16_t c = (uint16_t)((rem << 8) & 0xFFFF);
    rem = (uint16_t)(crcTable[a ^ b] ^ c);
  }
  return reflect16(rem);
}

/* ---------------------------------------------------------------- writer -- */
void Writer::raw(uint8_t b) {
  if (len_ >= sizeof(buf_)) {
    overflow_ = true;
    return;
  }
  buf_[len_++] = b;
}

void Writer::begin(uint16_t recordType) {
  len_ = 0;
  overflow_ = false;
  raw(SOR);
  raw(0); raw(0);  /* length, filled in by finish() */
  raw(0); raw(0);  /* crc,    filled in by finish() */
  raw((uint8_t)(recordType & 0xFF));
  raw((uint8_t)(recordType >> 8));
}

void Writer::u8(uint8_t sig, uint8_t v) {
  raw(sig); raw(1); raw(v);
}

void Writer::u16(uint8_t sig, uint16_t v) {
  raw(sig); raw(2);
  raw((uint8_t)(v & 0xFF)); raw((uint8_t)(v >> 8));
}

void Writer::u32(uint8_t sig, uint32_t v) {
  raw(sig); raw(4);
  for (int i = 0; i < 4; i++) raw((uint8_t)((v >> (8 * i)) & 0xFF));
}

void Writer::u64(uint8_t sig, uint64_t v) {
  raw(sig); raw(8);
  for (int i = 0; i < 8; i++) raw((uint8_t)((v >> (8 * i)) & 0xFF));
}

/* memcpy rather than a cast: a float punned through a uint32_t* is undefined
 * behaviour, and -O2 is entitled to notice. */
void Writer::f32(uint8_t sig, float v) {
  uint32_t bits;
  memcpy(&bits, &v, 4);
  u32(sig, bits);
}

size_t Writer::finish() {
  raw(EOR);
  if (overflow_) return 0;

  buf_[1] = (uint8_t)(len_ & 0xFF);
  buf_[2] = (uint8_t)(len_ >> 8);
  buf_[3] = 0;
  buf_[4] = 0;
  uint16_t crc = crc16(buf_, len_);
  buf_[3] = (uint8_t)(crc & 0xFF);
  buf_[4] = (uint8_t)(crc >> 8);

  /* Escape last, and never the first or last byte — those two are the frame. */
  size_t n = 0;
  for (size_t i = 0; i < len_; i++) {
    uint8_t b = buf_[i];
    bool interior = (i != 0 && i != len_ - 1);
    if (interior && (b == ESC || b == SOR || b == EOR)) {
      if (n + 2 > cap_) return 0;
      out_[n++] = ESC;
      out_[n++] = (uint8_t)(b + ESC_OFFSET);
    } else {
      if (n + 1 > cap_) return 0;
      out_[n++] = b;
    }
  }
  return n;
}

/* ---------------------------------------------------------------- framer -- */
bool Framer::feed(uint8_t b) {
  if (!inRecord_) {
    if (b != SOR) return false;  /* junk between records is ordinary */
    inRecord_ = true;
    esc_ = false;
    len_ = 0;
    buf_[len_++] = SOR;
    return false;
  }

  if (esc_) {
    esc_ = false;
    if (len_ < sizeof(buf_)) buf_[len_++] = (uint8_t)(b - ESC_OFFSET);
    else reset();
    return false;
  }
  if (b == ESC) {
    esc_ = true;
    return false;
  }
  /* A second SOR before an EOR means the first record was truncated in the air.
   * Start again from here rather than gluing two halves together. */
  if (b == SOR) {
    len_ = 0;
    buf_[len_++] = SOR;
    return false;
  }
  if (len_ >= sizeof(buf_)) {
    reset();
    return false;
  }
  buf_[len_++] = b;
  if (b == EOR) {
    memcpy(rec_, buf_, len_);
    recLen_ = len_;
    inRecord_ = false;
    len_ = 0;
    return true;
  }
  return false;
}

/* ---------------------------------------------------------------- reader -- */
uint8_t Field::u8() const { return len >= 1 ? data[0] : 0; }

uint16_t Field::u16() const {
  if (len < 2) return u8();
  return (uint16_t)(data[0] | (data[1] << 8));
}

uint32_t Field::u32() const {
  if (len < 4) return u16();
  uint32_t v = 0;
  for (int i = 0; i < 4; i++) v |= (uint32_t)data[i] << (8 * i);
  return v;
}

uint64_t Field::u64() const {
  if (len < 8) return u32();
  uint64_t v = 0;
  for (int i = 0; i < 8; i++) v |= (uint64_t)data[i] << (8 * i);
  return v;
}

float Field::f32() const {
  if (len < 4) return 0.0f;
  uint32_t bits = u32();
  float f;
  memcpy(&f, &bits, 4);
  return f;
}

Reader::Reader(const uint8_t* rec, size_t len) : rec_(rec), len_(len), pos_(7) {
  if (len < 8 || rec[0] != SOR) return;
  uint16_t stated = (uint16_t)(rec[1] | (rec[2] << 8));
  if (stated != len) return;
  uint16_t want = (uint16_t)(rec[3] | (rec[4] << 8));
  uint8_t copy[256];
  if (len > sizeof(copy)) return;
  memcpy(copy, rec, len);
  copy[3] = 0;
  copy[4] = 0;
  if (crc16(copy, len) != want) return;
  type_ = (uint16_t)(rec[5] | (rec[6] << 8));
  ok_ = true;
}

bool Reader::next(Field& f) {
  if (!ok_) return false;
  if (pos_ + 2 > len_ - 1) return false;
  if (rec_[pos_] == EOR) return false;
  uint8_t sig = rec_[pos_];
  uint8_t n = rec_[pos_ + 1];
  if (pos_ + 2 + n > len_ - 1) return false;
  f.sig = sig;
  f.len = n;
  f.data = rec_ + pos_ + 2;
  pos_ += 2 + n;
  return true;
}

}  // namespace laprf
