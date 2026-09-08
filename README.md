# WhoopTimer

Race timing for an **ImmersionRC LapRF** timer, built for indoor whoop racing.
Four pilots, live F1-style timing tower, spoken lap callouts, and a gate
sensitivity calibration wizard.

Runs entirely on your own machine. No cloud, no accounts, and no internet needed
at the track.

![Race view](docs/screenshot-race.png)

<p align="center">
  <img src="docs/screenshot-phone.png" width="270" alt="Phone race view">
  <img src="docs/screenshot-gate.png" width="270" alt="Phone gate tuning">
</p>

## Why this exists

The timer this was written for had **never reported a lap**. Its detection
threshold was set to 700 while its own noise floor sat at 963 — so it believed a
craft was permanently in the gate, never saw a crossing, and never emitted a
passing record. The receivers were fine the whole time.

That is not an obvious failure. Nothing in the stock tooling says "this slot can
never detect a lap". So this app makes gate sensitivity the thing it explains
best, and refuses to write a threshold it can prove will not work.

## Install

Python 3.9+ and a Bluetooth adapter. **Never needs root.**

```bash
git clone https://github.com/Mathew-Harvey/WhoopRaceTimer.git
cd WhoopRaceTimer
pip install -r requirements.txt
./whooptimer
```

On Windows, or if the launcher script is awkward:

```
python server.py --open
```

Then open **http://127.0.0.1:8080**.

### Use it from a phone or tablet

The UI is built for a phone as well as a laptop. Bind to the network and open the
address it prints on any device on the same wifi:

```bash
./whooptimer --lan
```

```
WhoopTimer -> http://127.0.0.1:8080
            on this network: http://192.168.1.42:8080
```

There is no authentication, so anyone on that network can control the race. Fine
for a club night; do not do it on public wifi.

### Voice callouts

Callouts use the browser's speech synthesis, so they use your system voices and
need nothing installed — **except on Linux**, where browsers route the Web Speech
API through `speech-dispatcher`. Without it `speechSynthesis` fails *silently*:

```bash
sudo apt install speech-dispatcher     # or: pacman -S speech-dispatcher
```

Restart the browser afterwards — voices are enumerated at startup. The header
shows a **NO VOICES** chip when the browser reports none, so this failure is
visible rather than silent.

### Optional: USB fallback signal

Bluetooth is the control transport and needs no special permissions. The USB
serial port is only a read-only fallback signal source, and the app works fine
without it. If you want it on Linux and hit a permissions error:

```bash
sudo cp contrib/99-laprf.rules /etc/udev/rules.d/
sudo udevadm control --reload-rules && sudo udevadm trigger
```

That grants access to whoever is logged in at the machine — no group changes, no
logout. Alternatively add yourself to the serial group (`uucp` on Arch, `dialout`
on Debian/Ubuntu) and log back in.

The serial port is found by USB id, so it works on any machine and any port
number. Override with `--device /dev/ttyACM0` or `--device COM3` if needed.

## Connecting

Control is over **Bluetooth LE**, not USB. The timer exposes a Nordic UART
Service:

```
service      6e400001-b5a3-f393-e0a9-e50e24dcca9e
control pt   6e400002-b5a3-f393-e0a9-e50e24dcca9e   (write without response, 20-byte chunks)
stream       6e400003-b5a3-f393-e0a9-e50e24dcca9e   (notify)
```

**The timer only advertises for a window after power-on.** Not after a
disconnect, and the bind button does not trigger it. If the link drops, power
cycle the timer — it reconnects in about a second.

On the unit this was developed against, USB is a **read-only ASCII debug
console**: it prints noise and battery voltage every 2.4 s, ignores everything
sent to it including the documented `Upp\r\n` binary-enable sequence, and carries
no passing records. It is used only as a fallback signal source.

## Gate sensitivity

The timer reports a lap when a receiver's RSSI rises **above its threshold**.
Correct placement is between two per-slot bounds:

```
floor (quiet noise)  ....  threshold  ....  ceiling (peak of a real pass)
```

Each receiver is on its own frequency, so **each slot has its own pair** — which
matters most on tiny tracks, where every quad is near the gate all the time and
neighbouring video bleeds across channels.

The calibration wizard on the Gate tab does this in three steps: measure the
quiet floor, fly one pass, apply. Track type biases where in the span the
threshold lands:

| preset | fraction | use when |
|---|---|---|
| Tiny | 0.62 | quads are never far from the gate |
| Small indoor | 0.50 | small track |
| Normal | 0.42 | default |
| Open/outdoor | 0.32 | weak or distant passes |

If a slot's floor and ceiling are closer than 120 counts, the app refuses to
derive a threshold and says why, rather than inventing one that will misfire.

## Racing

- **Formats** — first to N laps, fixed time, or best consecutive laps
- **Timing tower** — live reordering, gap to leader, purple for session-fastest
  and green for a personal best, F1-style
- **Voice callouts** — pilot name, lap number and time. With a single pilot
  enabled it detects that and drops the name: *"Lap 3, 24.7"*
- **Minimum lap time** — enforced in software as well as on the timer; essential
  for whoops, since one hovering in the gate otherwise racks up a dozen laps
- **Manual gate triggers** — keys `1`–`4`, a real backup if a receiver misses
- **Undo** — removes the last lap and rewinds the timing reference
- Results, session bests and race history, with CSV export

Everything persists to `data/`, so restarts never reset your pilots, channels or
thresholds.

## Files

| file | what |
|---|---|
| `laprf.py` | LapRF binary protocol: CRC-16, escaping, record encode/decode, channel tables |
| `ble.py` | Bluetooth LE transport (Nordic UART), auto-reconnect |
| `device.py` | USB serial fallback; parses the ASCII debug console |
| `race.py` | race state machine, lap timing, formats, callout text |
| `tuning.py` | gate sensitivity: per-slot bounds and threshold derivation |
| `sigtrack.py` | signal history and the software fallback detector |
| `store.py` | JSON persistence |
| `server.py` | HTTP + Server-Sent Events, JSON API |
| `static/index.html` | the whole UI, self-contained |

## Protocol notes

Record framing is `SOR(0x5A) | length u16le | crc u16le | recordType u16le |
fields | EOR(0x5B)`, where length counts the whole record and the CRC is CRC-16
(reflected poly `0x8005`, init 0) over the record with the CRC field zeroed.
Escaping is applied last: interior bytes equal to `0x5A/0x5B/0x5C` become `0x5C`
followed by the byte plus `0x40`.

Band indexes follow the string `FREBA`, so **Raceband is band 2, not band 1**.
Getting this wrong puts every pilot on the wrong frequency.

Cross-checked against [fpvcult/laprf](https://github.com/fpvcult/laprf) (TypeScript),
[hydrafpv/irc-swifty-laprf](https://github.com/hydrafpv/irc-swifty-laprf) (Swift) and
[ImmersionRC/LapRFUtilities](https://github.com/ImmersionRC/LapRFUtilities) (official C#).

## Licence

MIT.
