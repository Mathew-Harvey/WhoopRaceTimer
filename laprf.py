"""LapRF binary protocol — encode/decode for ImmersionRC LapRF timers.

Framing:  SOR | length u16le | crc u16le | recordType u16le | fields... | EOR
  length = total record byte count including SOR and EOR
  crc    = CRC-16 (reflected poly 0x8005, init 0) over the whole record, crc field zeroed
  fields = signature u8 | byteLength u8 | value (little endian)
Escaping is applied last, to every interior byte equal to SOR/EOR/ESC (+0x40 after ESC).
"""
import struct

SOR, EOR, ESC, ESC_OFFSET = 0x5A, 0x5B, 0x5C, 0x40

# Record types
RT_RSSI, RT_RF_SETUP, RT_STATE_CONTROL = 0xDA01, 0xDA02, 0xDA04
RT_SETTINGS, RT_DESCRIPTOR, RT_PASSING = 0xDA07, 0xDA08, 0xDA09
RT_STATUS, RT_TIME, RT_ERROR = 0xDA0A, 0xDA0C, 0xFFFF

RT_NAMES = {RT_RSSI: "rssi", RT_RF_SETUP: "rfSetup", RT_STATE_CONTROL: "stateControl",
            RT_SETTINGS: "settings", RT_DESCRIPTOR: "descriptor", RT_PASSING: "passing",
            RT_STATUS: "status", RT_TIME: "time", RT_ERROR: "error"}

# Field signatures
RF_SLOT, RF_ENABLED, RF_CHANNEL, RF_BAND, RF_THRESHOLD, RF_GAIN, RF_FREQ = \
    0x01, 0x20, 0x21, 0x22, 0x23, 0x24, 0x25
PS_SLOT, PS_RTC_TIME, PS_DECODER_ID, PS_PASSING_NUMBER, PS_PEAK_HEIGHT, PS_FLAGS = \
    0x01, 0x02, 0x20, 0x21, 0x22, 0x23
ST_SLOT, ST_FLAGS, ST_BATTERY, ST_LAST_RSSI, ST_GATE_STATE, ST_DETECT_COUNT = \
    0x01, 0x03, 0x21, 0x22, 0x23, 0x24
SET_STATUS_INTERVAL, SET_SAVE, SET_MIN_LAP = 0x22, 0x25, 0x26
SC_GATE_STATE = 0x20
TF_RTC_TIME, TF_TIME_RTC_TIME = 0x02, 0x20

# Band index order is 'FREBA' -> F=1 R=2 E=3 B=4 A=5.  Raceband is 2, not 1.
BAND_ORDER = "FREBA"
BANDS = {
    "A": [5865, 5845, 5825, 5805, 5785, 5765, 5745, 5725],
    "B": [5733, 5752, 5771, 5790, 5809, 5828, 5847, 5866],
    "E": [5705, 5685, 5665, 5645, 5885, 5905, 5925, 5945],
    "F": [5740, 5760, 5780, 5800, 5820, 5840, 5860, 5880],
    "R": [5658, 5695, 5732, 5769, 5806, 5843, 5880, 5917],
}

def channel_by_name(name):
    """'R4' -> (band_index, channel_index, frequency_mhz)"""
    name = name.strip().upper()
    b, c = name[0], int(name[1])
    return BAND_ORDER.index(b) + 1, c, BANDS[b][c - 1]

def channel_name(band_idx, chan_idx):
    return f"{BAND_ORDER[band_idx - 1]}{chan_idx}"

ALL_CHANNELS = [(f"{b}{i+1}", BANDS[b][i]) for b in BAND_ORDER for i in range(8)]

# ---- CRC-16, reflected poly 0x8005, init 0 ----
def _mk_table():
    t = []
    for i in range(256):
        r = (i << 8) & 0xFF00
        for _ in range(8):
            r = ((r << 1) & 0xFFFF) ^ 0x8005 if r & 0x8000 else (r << 1) & 0xFFFF
        t.append(r)
    return t
_CRC_TABLE = _mk_table()

def _reflect(v, nbits):
    o = 0
    for i in range(nbits):
        if (v >> i) & 1:
            o |= 1 << (nbits - 1 - i)
    return o

def crc16(buf):
    rem = 0
    for byte in buf:
        a = _reflect(byte, 8) & 0xFF
        b = (rem >> 8) & 0xFF
        c = (rem << 8) & 0xFFFF
        rem = _CRC_TABLE[a ^ b] ^ c
    return _reflect(rem, 16)

def escape(rec):
    out = bytearray()
    last = len(rec) - 1
    for i, byte in enumerate(rec):
        if byte in (ESC, SOR, EOR) and i != 0 and i != last:
            out += bytes([ESC, byte + ESC_OFFSET])
        else:
            out.append(byte)
    return bytes(out)

def unescape(rec):
    out, esc = bytearray(), False
    for byte in rec:
        if esc:
            out.append((byte - ESC_OFFSET) & 0xFF); esc = False
        elif byte == ESC:
            esc = True
        else:
            out.append(byte)
            if byte == EOR:
                break
    return bytes(out)

# ---- encoding ----
_FMT = {"u8": "<B", "u16": "<H", "u32": "<I", "f32": "<f"}

def encode(record_type, fields):
    """fields: list of (signature, type_str, value)"""
    body = bytearray()
    for sig, typ, val in fields:
        packed = struct.pack(_FMT[typ], val)
        body += bytes([sig, len(packed)]) + packed
    rec = bytearray([SOR]) + b"\x00\x00" + b"\x00\x00" + struct.pack("<H", record_type) + body + bytes([EOR])
    struct.pack_into("<H", rec, 1, len(rec))
    struct.pack_into("<H", rec, 3, crc16(bytes(rec)))
    return escape(bytes(rec))

def get_rtc_time():
    return encode(RT_TIME, [(TF_RTC_TIME, "u32", 0), (TF_TIME_RTC_TIME, "u32", 0)])

def get_rf_setup(slot=None):
    slots = [slot] if slot else range(1, 9)
    return encode(RT_RF_SETUP, [(RF_SLOT, "u8", s) for s in slots])

def set_rf_setup(slot, band, channel, frequency, threshold=900.0, gain=51, enabled=True):
    return encode(RT_RF_SETUP, [
        (RF_SLOT, "u8", slot), (RF_ENABLED, "u16", 1 if enabled else 0),
        (RF_CHANNEL, "u16", channel), (RF_BAND, "u16", band),
        (RF_THRESHOLD, "f32", threshold), (RF_GAIN, "u16", gain),
        (RF_FREQ, "u16", frequency)])

def set_min_lap_time(ms):
    return encode(RT_SETTINGS, [(SET_MIN_LAP, "u32", ms)])

def set_status_interval(ms):
    return encode(RT_SETTINGS, [(SET_STATUS_INTERVAL, "u16", ms)])

def set_gate_state(on):
    return encode(RT_STATE_CONTROL, [(SC_GATE_STATE, "u8", 1 if on else 0)])

# ---- decoding ----
# (signature -> python struct fmt) per record type, from the reference decoder
U8, U16, U32, U64, F32 = "<B", "<H", "<I", "<Q", "<f"
FIELD_TYPES = {
    RT_RF_SETUP: {RF_SLOT: U8, RF_ENABLED: U16, RF_CHANNEL: U16, RF_BAND: U16,
                  RF_THRESHOLD: F32, RF_GAIN: U16, RF_FREQ: U16},
    RT_PASSING:  {PS_SLOT: U8, PS_RTC_TIME: U64, PS_DECODER_ID: U32,
                  PS_PASSING_NUMBER: U32, PS_PEAK_HEIGHT: U16, PS_FLAGS: U16},
    RT_STATUS:   {ST_SLOT: U8, ST_FLAGS: U16, ST_BATTERY: U16,
                  ST_LAST_RSSI: F32, ST_GATE_STATE: U8, ST_DETECT_COUNT: U32},
    RT_RSSI:     {0x01: U8, 0x07: U32, 0x20: F32, 0x21: F32, 0x22: F32,
                  0x23: F32, 0x24: U32, 0x25: U32, 0x26: U32},
    RT_SETTINGS: {SET_STATUS_INTERVAL: U16, SET_SAVE: U8, SET_MIN_LAP: U32},
    RT_TIME:     {TF_RTC_TIME: U64, TF_TIME_RTC_TIME: U64},
    RT_STATE_CONTROL: {SC_GATE_STATE: U8},
}
FIELD_NAMES = {
    RT_RF_SETUP: {RF_SLOT: "slot", RF_ENABLED: "enabled", RF_CHANNEL: "channel",
                  RF_BAND: "band", RF_THRESHOLD: "threshold", RF_GAIN: "gain",
                  RF_FREQ: "frequency"},
    RT_PASSING:  {PS_SLOT: "slot", PS_RTC_TIME: "rtcTime", PS_DECODER_ID: "decoderId",
                  PS_PASSING_NUMBER: "passingNumber", PS_PEAK_HEIGHT: "peakHeight",
                  PS_FLAGS: "flags"},
    RT_STATUS:   {ST_SLOT: "slot", ST_FLAGS: "flags", ST_BATTERY: "batteryVoltage",
                  ST_LAST_RSSI: "lastRssi", ST_GATE_STATE: "gateState",
                  ST_DETECT_COUNT: "detectionCount"},
    RT_RSSI:     {0x01: "slot", 0x07: "sampleCount", 0x20: "minRssi",
                  0x21: "maxRssi", 0x22: "meanRssi"},
    RT_SETTINGS: {SET_STATUS_INTERVAL: "statusInterval", SET_MIN_LAP: "minLapTime"},
    RT_TIME:     {TF_RTC_TIME: "rtcTime", TF_TIME_RTC_TIME: "timeRtcTime"},
}

def decode_record(rec):
    """rec: one unescaped record incl. SOR/EOR. Returns a dict, or None if not a record.

    Status records interleave slot/lastRssi pairs, so slot-scoped values are
    collected into rec['slots'][slot_index] rather than flattened.
    """
    if len(rec) < 8 or rec[0] != SOR:
        return None
    length = struct.unpack_from("<H", rec, 1)[0]
    crc_rx = struct.unpack_from("<H", rec, 3)[0]
    chk = bytearray(rec)
    struct.pack_into("<H", chk, 3, 0)
    if crc16(bytes(chk)) != crc_rx:
        return {"type": "crc_error", "raw": rec.hex()}
    rtype = struct.unpack_from("<H", rec, 5)[0]
    types = FIELD_TYPES.get(rtype, {})
    names = FIELD_NAMES.get(rtype, {})
    out = {"type": RT_NAMES.get(rtype, f"0x{rtype:04x}"), "rtype": rtype, "slots": {}}
    cur_slot = None
    i = 7
    while i < len(rec) - 1:
        if rec[i] == EOR:
            break
        sig, size = rec[i], rec[i + 1]
        data = rec[i + 2:i + 2 + size]
        if len(data) < size:
            break
        fmt = types.get(sig)
        if fmt and struct.calcsize(fmt) == size:
            val = struct.unpack(fmt, data)[0]
        elif size in (1, 2, 4, 8):
            val = int.from_bytes(data, "little")
        else:
            val = data.hex()
        name = names.get(sig, f"f{sig:02x}")
        if rtype in (RT_STATUS, RT_RSSI) and name == "slot":
            cur_slot = val
            out.setdefault("slots", {}).setdefault(cur_slot, {})
        elif rtype in (RT_STATUS, RT_RSSI) and cur_slot is not None and name in (
                "lastRssi", "minRssi", "maxRssi", "meanRssi", "sampleCount"):
            out["slots"].setdefault(cur_slot, {})[name] = val
        else:
            out[name] = val
        i += 2 + size
    return out

def split_records(buf):
    """Extract complete records from buf.
    Returns (records, leftover_bytes) so a partial tail can be re-fed next read."""
    recs, pos = [], 0
    while True:
        sor = buf.find(bytes([SOR]), pos)
        if sor < 0:
            pos = len(buf)
            break
        i, esc = sor + 1, False
        end = -1
        while i < len(buf):
            b = buf[i]
            if esc:
                esc = False
            elif b == ESC:
                esc = True
            elif b == EOR:
                end = i
                break
            i += 1
        if end < 0:            # incomplete record, keep from sor onwards
            pos = sor
            break
        recs.append(unescape(buf[sor:end + 1]))
        pos = end + 1
    return recs, buf[pos:]

# The magic sequence that switches a LapRF's USB endpoint from its ASCII debug
# stream to the binary protocol. Device must be power-cycled afterwards.
ENABLE_BINARY = bytes([0x55, 0x70, 0x70, 0x0d, 0x0a])
