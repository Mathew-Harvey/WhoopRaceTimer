# RotorHazard node integration — parked

The translator is finished and tested. It is parked because the node it was
written for cannot receive, and that is a hardware fault no software can reach.

`main` carries none of this. It is the LapRF timer and nothing else.

## Where it got to

`rotorhazard.py` presents a RotorHazard node to the browser as a LapRF. The page
is unmodified and cannot tell the difference: node counts and its lap tally
become LapRF records, and the app's instructions become node commands.

    python3 server.py --rotorhazard              # find a node
    python3 server.py --rotorhazard /dev/ttyUSB0 # or name its port

Verified end to end against the real node: 116 status records at 5.0/s, none
malformed, the app's threshold round-tripping to within f32 rounding, the node
retuned on command, and nothing invented in three minutes. Everything in the
protocol and translation layer works.

Six suites cover it, all green, every fix mutation-tested:

    python3 tests/test_rotorhazard.py     # the translator
    python3 tests/test_bridge.py          # one timer at a time
    python3 tests/test_laprf_golden.py    # the LapRF wire format, pinned

## Why it is parked

The node's receiver has no channel selectivity. Measured, with the quad
powered and broadcasting R8 (5917) throughout:

| test | result |
|---|---|
| Raceband, 4 passes, alternating direction | flat 56–57 on every channel; R8 read 57, 57, 57, 57 |
| Paired 5917 against 5732, 14 rounds, both orders | **+0.2 counts**, sd 0.5 |
| Both frequencies watched 6 s after retune | both settle to **115** — identical, 185 MHz apart |
| 5600–5990 MHz in 10 MHz steps | flat 83 across the whole range |

The node does respond to RF: with the quad touching the antenna it read a flat
112 and fell to 67 the moment the quad was switched off. So energy reaches it.
It just does not matter which frequency it is tuned to.

Reproduce any of it with `python3 tools/node_diagnose.py` (stop the bridge
first — the port takes one user).

## The two traps

Both cost real time, and both look like software bugs.

**`READ_FREQUENCY` echoes the processor, not the receiver.** A read-back that
agrees with the write proves the two ends agree about a number. It says nothing
about whether that number reached the RX5808. Every retune in the logs looks
perfect and the receiver may never have moved.

**One sweep is a time series, not a spectrum.** The room has a broadband source
that switches on and off, and it lifts whichever channel is being sampled while
it is on. The first sweep rose smoothly from 43 at R1 to 131 at R6 and looked
exactly like a real spectrum with a peak — it was sweep order. Sweeping the
other way reproduced the hump; sweeping four times gave a flat line and three
different winners. Later, one sweep showed R8 at 111.5 and looked like a hit;
four passes showed 57. Never trust a single pass.

## What to check on the node

1. **The RX5808 SPI mod.** A stock module takes its channel from hardware pins
   and ignores SPI until one SMD resistor is removed. Skip that step and the
   module sits on one fixed channel forever while the processor accepts every
   frequency written to it. This is general knowledge about these builds, not
   something verified on this board, but it produces exactly this signature.
2. **The three SPI lines** to the module — Data, Clock, Slave Select. One loose
   or on the wrong pin looks identical.
3. **The antenna** — a u.FL pigtail off its socket gives the same flat internal
   noise floor. Energy does reach the board at zero range, which may be direct
   coupling rather than anything arriving through a tuned receiver.

## The test that would settle it

Not yet run. Park the node on 5917 and step the VTX R1 → R8, holding each about
fifteen seconds (`python3 tools/node_diagnose.py watch 5917`):

- spike when the VTX reaches **R8** → the receiver tunes correctly and the
  diagnosis above is wrong
- spike at some **other** channel → the module is stuck there, so it is the SPI
  mod or its wiring
- **no spike anywhere** → the receive path is dead, antenna or front end

## One thing worth knowing if this is resumed

`SIGNAL_LIFT` in `tuning.js` is 150 LapRF counts. A node's RSSI is 0–255 scaled
by 16, so one count of node wander is 16 counts to the app, and this node's noise
moves about 10 counts across the band — around 160, just over the bar for
"confident". That is why the scan sometimes announced a channel with conviction
instead of reporting nothing found. It is a symptom of the receiver, not a
threshold to lower; a node that can actually hear a quad will clear 150 by an
order of magnitude.
