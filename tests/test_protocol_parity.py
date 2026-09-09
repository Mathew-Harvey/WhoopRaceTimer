#!/usr/bin/env python3
"""Pin static/js/laprf.js to laprf.py.

There are two implementations of the LapRF wire format in this repository: the
Python one, which is the reference and was cross-checked against three
independent decoders, and the JavaScript one the browser actually uses. A
divergence between them is invisible until a race silently records nothing, so
this generates vectors from Python and asserts the JavaScript agrees, byte for
byte and field for field.

    python3 tests/test_protocol_parity.py
"""
import json, os, random, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)

import laprf


def build_vectors():
    random.seed(7)
    out = []
    # Every channel, with thresholds chosen to push escape bytes into the body.
    for i, (name, freq) in enumerate(laprf.ALL_CHANNELS):
        band, chan, f = laprf.channel_by_name(name)
        raw = laprf.set_rf_setup(i % 8 + 1, band, chan, f, threshold=100.0 + i * 47.3,
                                 gain=20 + i, enabled=i % 2 == 0)
        out.append({"hex": raw.hex(), "decoded": laprf.decode_record(laprf.unescape(raw))})
    # A passing record whose payload contains SOR, EOR and ESC bytes.
    passing = laprf.encode(laprf.RT_PASSING, [
        (laprf.PS_SLOT, "u8", 3), (laprf.PS_PASSING_NUMBER, "u32", 91),
        (laprf.PS_PEAK_HEIGHT, "u16", 0x5A5B), (laprf.PS_FLAGS, "u16", 0x5C00)])
    out.append({"hex": passing.hex(), "decoded": laprf.decode_record(laprf.unescape(passing))})
    # Status records interleave slot/value pairs; the decoders must both scope
    # each value to the slot that preceded it.
    status = laprf.encode(laprf.RT_STATUS, [
        (laprf.ST_BATTERY, "u16", 8321),
        (laprf.ST_SLOT, "u8", 1), (laprf.ST_LAST_RSSI, "f32", 963.0),
        (laprf.ST_SLOT, "u8", 2), (laprf.ST_LAST_RSSI, "f32", 1702.5),
        (laprf.ST_SLOT, "u8", 3), (laprf.ST_LAST_RSSI, "f32", 90.0)])
    out.append({"hex": status.hex(), "decoded": laprf.decode_record(laprf.unescape(status))})

    # A realistic stream: leading junk, every record back to back, then a record
    # cut in half — the framer has to keep the tail for the next read.
    stream = b"\x00\x11" + b"".join(bytes.fromhex(o["hex"]) for o in out) \
             + bytes.fromhex(out[0]["hex"])[:6]
    recs, rest = laprf.split_records(stream)
    return {"vectors": out, "stream": stream.hex(),
            "streamRecords": [laprf.decode_record(r) for r in recs],
            "streamRest": rest.hex(),
            "encode": {
                "setRfSetup": laprf.set_rf_setup(1, 2, 4, 5769, threshold=1600.0,
                                                 gain=58, enabled=True).hex(),
                "getRfSetup": laprf.get_rf_setup().hex(),
                "setMinLapTime": laprf.set_min_lap_time(3000).hex(),
                "getRtcTime": laprf.get_rtc_time().hex(),
                # Both were unpinned while the app came to depend on them: the
                # status rate is what makes any signal arrive at all, and the
                # gate state is what arms a timer that came up idle. A one-sided
                # edit to either would have passed this suite.
                "setStatusInterval": laprf.set_status_interval(200).hex(),
                "setGateStateActive": laprf.set_gate_state(True).hex(),
                "setGateStateIdle": laprf.set_gate_state(False).hex(),
            },
            "channels": [{"name": n, "freq": f} for n, f in laprf.ALL_CHANNELS]}


CHECKER = r"""
import fs from 'node:fs';
const V = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const m = await import(process.argv[3]);
const bytes = hex => Uint8Array.from(Buffer.from(hex, 'hex'));
const hex = u8 => Buffer.from(u8).toString('hex');
const norm = o => {
  const c = { ...o };
  delete c.rtype;
  c.slots = Object.fromEntries(Object.entries(c.slots || {}).map(([k, v]) => [String(k), v]));
  return JSON.stringify(c, Object.keys(c).sort());
};
const fail = [];
let checks = 0;

for (const [name, expected] of Object.entries(V.encode)) {
  const got = hex({
    setRfSetup: m.setRfSetup({ slot: 1, band: 2, channel: 4, frequency: 5769,
                               threshold: 1600, gain: 58, enabled: true }),
    getRfSetup: m.getRfSetup(),
    setMinLapTime: m.setMinLapTime(3000),
    getRtcTime: m.getRtcTime(),
    setStatusInterval: m.setStatusInterval(200),
    setGateStateActive: m.setGateState(m.GATE.active),
    setGateStateIdle: m.setGateState(m.GATE.idle),
  }[name]);
  checks++;
  if (got !== expected) fail.push(`encode ${name}\n  py ${expected}\n  js ${got}`);
}

if (V.channels.length !== m.ALL_CHANNELS.length) fail.push('channel table length differs');
V.channels.forEach((c, i) => {
  checks++;
  const j = m.ALL_CHANNELS[i];
  if (c.name !== j.name || c.freq !== j.freq) fail.push(`channel ${i}: ${c.name}/${c.freq} vs ${j.name}/${j.freq}`);
});

for (const v of V.vectors) {
  checks++;
  const got = m.decodeRecord(m.unescape(bytes(v.hex)));
  if (norm(got) !== norm(v.decoded)) fail.push(`decode\n  py ${norm(v.decoded)}\n  js ${norm(got)}`);
}

const { records, rest } = m.splitRecords(bytes(V.stream));
checks++;
if (records.length !== V.streamRecords.length) {
  fail.push(`stream framing: ${records.length} records vs ${V.streamRecords.length}`);
}
records.forEach((r, i) => {
  checks++;
  const got = m.decodeRecord(r);
  if (norm(got) !== norm(V.streamRecords[i])) fail.push(`stream record ${i} differs`);
});
checks++;
if (hex(rest) !== V.streamRest) fail.push(`stream tail ${hex(rest)} vs ${V.streamRest}`);

if (fail.length) { console.error(fail.join('\n')); process.exit(1); }
console.log(`${checks} checks pass: static/js/laprf.js matches laprf.py`);
"""


def main():
    vectors = build_vectors()
    with tempfile.TemporaryDirectory() as tmp:
        vpath = os.path.join(tmp, "vectors.json")
        cpath = os.path.join(tmp, "check.mjs")
        with open(vpath, "w") as f:
            json.dump(vectors, f)
        with open(cpath, "w") as f:
            f.write(CHECKER)
        js = os.path.join(ROOT, "static", "js", "laprf.js")
        try:
            r = subprocess.run(["node", cpath, vpath, js], capture_output=True, text=True)
        except FileNotFoundError:
            print("node not found — skipping the JavaScript half of the parity check")
            return 0
        sys.stdout.write(r.stdout)
        sys.stderr.write(r.stderr)
        return r.returncode


if __name__ == "__main__":
    sys.exit(main())
