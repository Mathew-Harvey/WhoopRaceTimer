#!/usr/bin/env python3
"""Is a RotorHazard node's receiver actually working?

Written because a node passed every software test and still could not find a
quad. It answers protocol questions and it answers radio questions, and the
distinction turned out to be the whole point: the node accepted every frequency
it was given, echoed it back correctly, reported a plausible signal, and was
tuned to none of them.

The trap this exists to avoid: READ_FREQUENCY returns what the node's own
processor stored, not what the receiver module is tuned to. A read-back that
agrees with the write proves the two ends agree about a number. It says nothing
about whether that number reached the RX5808. If the SPI lines to the module are
not connected — or the module was never modified for SPI control, which is a
build step that is easy to skip — every retune looks perfect and the receiver
never moves.

So every test here is designed to survive that, and to survive the other thing
that made this hard: the room. A broadband source that switches on and off lifts
whichever channel happens to be sampled while it is on, and a sweep taken once
in frequency order cannot tell that from a transmitter. Sweeping in order gave a
clean-looking hump that rose with frequency; sweeping the other way gave the
same hump; sweeping four times gave a flat line and three different "winners".
Every measurement below is therefore repeated, alternated, or paired.

    python3 tools/node_diagnose.py                 # everything
    python3 tools/node_diagnose.py sweep           # the raceband, four times
    python3 tools/node_diagnose.py pair 5917 5732  # two channels, paired
    python3 tools/node_diagnose.py watch 5917      # one channel over time
    python3 tools/node_diagnose.py settle 5917 5732

Stop the bridge first — the port takes one user.
"""
import statistics
import struct
import sys
import time

sys.path.insert(0, __file__.rsplit("/", 2)[0])
import laprf                                                    # noqa: E402
import rotorhazard as rh                                        # noqa: E402

PORT = "/dev/ttyUSB0"
#: The node was found at 5658 with these levels. Every mode restores them, so a
#: diagnostic session does not silently leave the timer somewhere else.
AS_FOUND = (5658, 114, 108)


def open_node(port=PORT):
    import serial
    s = serial.Serial(port, 115200, timeout=0.4)
    time.sleep(3.0)                     # the DTR assert reboots it
    s.reset_input_buffer()
    n = rh.RotorHazardNode(port=port)
    n._ser = s
    rev = n._read(rh.READ_REVISION_CODE)
    if not rev or rev[0] != rh.RotorHazardNode.REVISION_MARKER:
        raise SystemExit(f"no RotorHazard node on {port} "
                         f"(revision {rev.hex() if rev else 'unreadable'})")
    print(f"node on {port}: revision {rev.hex()}, API {rev[1]}")
    return n, s


def restore(n):
    mhz, enter, exit_ = AS_FOUND
    n._write(rh.WRITE_FREQUENCY, struct.pack(">H", mhz))
    n._write(rh.WRITE_ENTER_AT_LEVEL, bytes([enter]))
    n._write(rh.WRITE_EXIT_AT_LEVEL, bytes([exit_]))
    print(f"\nrestored: {mhz} MHz, enter {enter}, exit {exit_}")


def rssi(n, tries=6):
    """One reading, retried — a single failed read is not a dead node."""
    for _ in range(tries):
        raw = n._read(rh.READ_LAP_STATS)
        if raw is not None:
            return rh.LapStats(raw).rssi
        time.sleep(0.05)
    return None


def measure(n, mhz, settle=0.5, count=10):
    """Tune, wait, and take the median of several readings."""
    n._write(rh.WRITE_FREQUENCY, struct.pack(">H", mhz))
    time.sleep(settle)
    got = [v for v in (rssi(n) for _ in range(count)) if v is not None]
    return statistics.median(got) if got else float("nan")


def sweep(n, band="R", passes=4):
    """The band several times, alternating direction.

    One pass is not a spectrum. Sweeping in frequency order turns anything that
    varies in time into an apparent slope, and the first sweep run against this
    node rose smoothly from 43 to 131 — entirely an artefact of sweep order.
    Alternating the direction and repeating makes the difference obvious: a real
    transmitter sits in the same place every pass, and a per-channel spread of a
    count or two next to a "winner" that moves every pass is noise.
    """
    freqs = list(laprf.BANDS[band])
    runs = []
    for i in range(passes):
        order = freqs if i % 2 == 0 else list(reversed(freqs))
        runs.append({f: measure(n, f) for f in order})
    print(f"\nband {band}, {passes} passes, alternating direction\n")
    print(f"{'ch':>4} {'MHz':>5} |" + "".join(f" p{i + 1:>5}" for i in range(passes))
          + "   spread")
    print("-" * (20 + 7 * passes))
    for i, f in enumerate(freqs, start=1):
        v = [r[f] for r in runs]
        print(f"  {band}{i} {f:5d} |" + "".join(f" {x:6.0f}" for x in v)
              + f" {max(v) - min(v):8.0f}")
    print()
    picks = [max(r, key=r.get) for r in runs]
    for i, p in enumerate(picks):
        print(f"  pass {i + 1} would pick {p} MHz")
    if len(set(picks)) > 1:
        print("\n  The winner moves between passes, so nothing is transmitting that this\n"
              "  receiver can hear. A scan can only return noise here.")


def pair(n, a, b, rounds=14):
    """Two frequencies, alternated, each round measuring A-B and B-A.

    The measurement that settled it. Drift in time is the thing that ruins a
    sweep, and pairing cancels it: both frequencies are visited within a second
    of each other, in both orders, so anything that changes slowly affects them
    equally and subtracts out.
    """
    print(f"\npaired {a} against {b}, {rounds} rounds, both orders each round\n")
    diffs = []
    for i in range(rounds):
        x1, y1 = measure(n, a), measure(n, b)
        y2, x2 = measure(n, b), measure(n, a)
        d = ((x1 - y1) + (x2 - y2)) / 2
        diffs.append(d)
        print(f"  round {i + 1:2d}:  {a}={x1:5.1f}/{x2:5.1f}   "
              f"{b}={y1:5.1f}/{y2:5.1f}   diff {d:+6.1f}")
    m = statistics.mean(diffs)
    sd = statistics.stdev(diffs) if len(diffs) > 1 else 0.0
    print(f"\n  mean {a} - {b}: {m:+.1f} counts (sd {sd:.1f})")
    print(f"  A transmitter on {a} should put it a hundred counts or more above an\n"
          f"  empty channel. A difference inside a count or two means this receiver\n"
          f"  cannot tell the two apart — 185 MHz of separation reading the same.")


def watch(n, mhz, secs=40.0, bucket=2.0):
    """One frequency over time, so an intermittent source is visible as one."""
    n._write(rh.WRITE_FREQUENCY, struct.pack(">H", mhz))
    time.sleep(0.6)
    buckets, t0 = {}, time.monotonic()
    while time.monotonic() - t0 < secs:
        v = rssi(n)
        if v is not None:
            buckets.setdefault(int((time.monotonic() - t0) // bucket), []).append(v)
        time.sleep(0.04)
    print(f"\n{mhz} MHz for {secs:.0f}s, {bucket:.0f}s buckets\n")
    every = []
    for k in sorted(buckets):
        v = sorted(buckets[k])
        every += v
        print(f"  {k * bucket:5.0f}s  med {v[len(v) // 2]:3d}  min {v[0]:3d}  max {v[-1]:3d}")
    print(f"\n  whole window: min {min(every)}  max {max(every)}  "
          f"spread {max(every) - min(every)}")
    if max(every) - min(every) > 30:
        print("  Two levels far apart on one frequency is an intermittent source, and it\n"
              "  is what makes a single-visit sweep elect a channel at random.")


def settle(n, a, b, secs=6.0):
    """How long after a retune the reading means anything.

    Ruled out the easy explanation. The reading settles inside a second, so a
    scan that waits 260 ms and then samples is not being defeated by settle
    time — and both frequencies settle to the *same* value, which is the
    finding.
    """
    print(f"\nconvergence after a retune, {secs:.0f}s each\n")
    for mhz in (a, b, a, b):
        n._write(rh.WRITE_FREQUENCY, struct.pack(">H", mhz))
        buckets, t0 = {}, time.monotonic()
        while time.monotonic() - t0 < secs:
            v = rssi(n)
            if v is not None:
                buckets.setdefault(int((time.monotonic() - t0) * 2), []).append(v)
            time.sleep(0.04)
        row = "  ".join(f"{statistics.mean(v):3.0f}" for _, v in sorted(buckets.items()))
        print(f"  {mhz}: {row}")
    print("\n  (columns are half a second apart, from the moment of the write)")


def main():
    argv = sys.argv[1:]
    mode = argv[0] if argv else "all"
    n, s = open_node()
    try:
        if mode in ("all", "sweep"):
            sweep(n)
        if mode in ("all", "pair"):
            a = int(argv[1]) if len(argv) > 2 else 5917
            b = int(argv[2]) if len(argv) > 2 else 5732
            pair(n, a, b)
        if mode in ("all", "watch"):
            watch(n, int(argv[1]) if len(argv) > 1 and mode == "watch" else 5917)
        if mode in ("all", "settle"):
            a = int(argv[1]) if len(argv) > 2 else 5917
            b = int(argv[2]) if len(argv) > 2 else 5732
            settle(n, a, b)
        if mode not in ("all", "sweep", "pair", "watch", "settle"):
            raise SystemExit(__doc__)
    finally:
        try:
            restore(n)
        finally:
            s.close()


if __name__ == "__main__":
    main()
