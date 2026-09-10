# WhoopGate — a LapRF you can build

An ESP32 and one to four RX5808 receivers, running firmware that speaks the
LapRF protocol over Bluetooth LE. [whooptimer.webfpv.org](https://whooptimer.webfpv.org)
connects to it directly with Web Bluetooth — no bridge, no laptop, no cable, no
driver. The app is not told it is talking to anything unusual, because it is not:
every frame this emits is a frame a LapRF emits.

About twenty-five dollars in parts, and one file to flash.

## What is checked and what is not

This matters more than the parts list, so it is first.

**Checked, on every push, with no hardware attached:**

- The protocol. `laprf.cpp` is compiled on a host and every frame it produces is
  compared byte for byte against `laprf.py` — the reference implementation this
  project cross-checked against three independent decoders. That includes a
  status record held against bytes captured from a real ImmersionRC puck.
- The pass detector. One crossing is one lap; a trigger below the noise floor
  invents nothing; a pass dithering across the trigger is not chopped into
  several; the minimum lap time is honoured and released.
- That the firmware builds, for one, two, three and four receivers, with
  `--warnings all`.

```bash
python3 firmware/test/test_firmware_parity.py
```

**Not checked, because it needs hardware:**

- **The signal scale.** `RSSI_MV_QUIET` and `RSSI_MV_PEAK` in `config.h` come
  from the RX5808's typical RSSI output range, not from your module. Every
  number the app reasons about — the 120-count minimum span, the rise a lap has
  to show, where a track preset puts a trigger — is denominated in those two.
  Calibrating them is a step below, not an optimisation.
- Timing accuracy against a real quad. The sampling loop runs at 200 Hz, which
  puts dozens of samples inside a whoop crossing, but nobody has flown one
  through this.
- BLE behaviour under four pilots' worth of traffic.

Bring it up on the bench, open the gate screen, and believe the meter.

## Parts

| Qty | Part | Notes |
|---|---|---|
| 1 | ESP32 DevKit (WROOM-32, 38-pin) | Not an ESP32-C3/S3/C6 — the pin map in `config.h` is for the original ESP32 |
| 1–4 | RX5808 5.8 GHz receiver module | One per pilot. **The SPI mod below is not optional** |
| 3 per RX | 1 kΩ resistor, ¼ W | In series on each SPI line |
| 1 per RX | 100 kΩ resistor, ¼ W | RSSI to ground |
| — | 26 and 30 AWG silicone wire | |
| 1 | USB cable, data not charge-only | Flashing and power |
| 1–4 | 5.8 GHz antenna + u.FL pigtail | Optional, and worth it |

One receiver is a working solo gate. Four is a race. The app races slots 1–4
either way, and reports the ones you did not build as switched off, which is
what they are.

## 1 · The SPI mod, first

Many RX5808 modules ship with SPI disabled by a single SMD resistor, and until
it is removed the module takes its channel from hardware pins and ignores
everything the firmware writes.

**Do not defer this and check later.** There is no read-back path worth
trusting: the write succeeds, the firmware has no way to know it did nothing,
and the only symptom is a receiver whose signal does not depend on the frequency
it was told to use. That failure costs an evening and looks exactly like a
software bug.

Remove the shield — a few spots of solder around the edge, and small holes to
push through — remove
[the resistor RotorHazard's guide arrows](https://github.com/RotorHazard/RotorHazard/blob/main/doc/Hardware%20Setup.md#rx5808-video-receivers),
and solder the shield back on.

If your finished gate reads the same level on every channel, this is the reason.

## 2 · Wiring

Per receiver. CLK and DATA are shared by every module; only SEL is its own.

| RX5808 pin | ESP32 | Through |
|---|---|---|
| CH1 / SPI_DATA | GPIO23 | 1 kΩ in series |
| CH2 / SPI_SEL | GPIO25 / 26 / 27 / 13 — one per receiver | 1 kΩ in series |
| CH3 / SPI_CLK | GPIO18 | 1 kΩ in series |
| RSSI | GPIO36 / 39 / 34 / 35 — one per receiver | 100 kΩ to GND |
| +5V | 5V (VIN when USB-powered) | |
| GND | GND | |

AUDIO and VIDEO are unused.

**The RSSI pins have to be on ADC1.** GPIO36, 39, 34 and 35 are, and they are
input-only, which is exactly what an analog input wants. ADC2 shares hardware
with the radio and reads garbage whenever Bluetooth is on — which here is
always. If you move these pins, move them within GPIO32–39.

Optional: a 100k/100k divider from your pack to GPIO32 reports battery voltage
to the app. Leave `PIN_BATTERY` at `-1` if you are not measuring it — the app
hides the battery pill rather than showing an invented number.

## 3 · Flash it

1. Install the [Arduino IDE](https://www.arduino.cc/en/software).
2. **File → Preferences → Additional board manager URLs**, add
   `https://espressif.github.io/arduino-esp32/package_esp32_index.json`
3. **Tools → Board → Boards Manager**, install **esp32** by Espressif
   (built and tested against 3.3.11).
4. Open `firmware/whoopgate/whoopgate.ino`.
5. **Tools → Board → ESP32 Dev Module**. Leave the rest at defaults — the build
   is 84% of the standard partition scheme, which fits.
6. Select the port, click Upload.

Or from the command line:

```bash
arduino-cli core install esp32:esp32
arduino-cli compile --fqbn esp32:esp32:esp32 firmware/whoopgate
arduino-cli upload  --fqbn esp32:esp32:esp32 -p /dev/ttyUSB0 firmware/whoopgate
```

Set `NUM_RX` in `config.h` to how many receivers you actually wired.

## 4 · Calibrate the signal scale

This is the step that decides whether the gate works.

Open the serial monitor at **115200** and send `r`:

```
slot  mV     counts  trigger  freq   enabled  laps
1     198    948     1500     5658   yes      0
```

- With the room quiet and nothing flying, note the **mV** column. Put that in
  `RSSI_MV_QUIET`.
- Hold a quad at 25 mW where it will cross the gate, send `r` again, note the
  mV. Put that in `RSSI_MV_PEAK`.
- Re-flash.

The `counts` column should then read about 950 quiet and about 2900 at the gate.
Those are the numbers a real LapRF reports, and the app's entire notion of a
usable gate is built on them.

## 5 · Fly it

Power the gate, open [whooptimer.webfpv.org](https://whooptimer.webfpv.org),
tap **Connect by Bluetooth**, and pick **LapRF-WhoopGate**.

From there it is the app's own manual: set 25 mW, fly three laps, and the gate
calibrates itself.

## Where this differs from a real LapRF, on purpose

**It keeps advertising.** A LapRF advertises for about a minute after power-on
and never again, which is the single most common reason a timer "isn't showing
up" — the app's troubleshooting leads with it. This one advertises whenever
nothing is connected, so a dropped link is one tap back rather than a power
cycle.

**A quad hovering in the gate is not a lap per sample.** A LapRF re-triggers
while a craft sits over the threshold, which is why the app has a minimum lap
time at all. This is edge-triggered: one crossing, one passing record, emitted
when the signal falls away again. The minimum lap time is still honoured on top.

**The record is emitted on the falling edge**, carrying the timestamp of the
rising one. The app calibrates from the peak height a timer reports, and a peak
is not known until the crossing is over — so the record arrives about half a
pass late while the *lap time* stays exact.

**A write to a receiver it does not have is refused.** Wire two and the app will
still ask all four about themselves; slots 3 and 4 answer that they are off, and
a write to them is not absorbed. The app asks three times and then says so out
loud, which is the correct outcome — quietly accepting would show four gates on
one frequency.

## Files

| file | what |
|---|---|
| `whoopgate/whoopgate.ino` | sampling loop, record handling, serial diagnostics |
| `whoopgate/laprf.h/.cpp` | the protocol. No Arduino headers — that is what makes it testable |
| `whoopgate/gate.h/.cpp` | pass detection and the median filter. Also portable |
| `whoopgate/rx5808.h/.cpp` | tuning an RX5808 over its three-wire SPI |
| `whoopgate/ble.h/.cpp` | Nordic UART service |
| `whoopgate/config.h` | every pin and constant worth changing |
| `test/parity.cpp` | dumps every frame as hex, for the test below |
| `test/test_firmware_parity.py` | holds those frames against `laprf.py`, byte for byte |
