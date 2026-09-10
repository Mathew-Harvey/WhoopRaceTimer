/* Everything you might need to change to match the board in front of you.
 *
 * The defaults are for a plain ESP32 DevKit (WROOM-32) with up to four RX5808
 * modules. Nothing else in the firmware has a pin number in it.
 */
#pragma once
#include <stdint.h>

/* How many receivers are wired. One is a working solo gate; four is a race.
 * The app races slots 1-4 and asks all four about themselves, so a gate with
 * fewer simply reports the rest as disabled — which is the truth, and is what
 * the app's own "this receiver is switched off" state is for. */
#define NUM_RX 4

/* The pin tables are always full length so that building with NUM_RX 1, 2 or 3
 * is a matter of changing one number and wiring less. */
#define MAX_RX 4
static_assert(NUM_RX >= 1 && NUM_RX <= MAX_RX,
              "NUM_RX must be 1..4; add pins to PIN_RSSI and PIN_RX_SEL to go higher");

/* ---------------------------------------------------------------- pins ---- */
/* RSSI must be on ADC1. ADC2 shares hardware with the radio and reads garbage
 * (or nothing at all) whenever Bluetooth is on, which is always, here. ADC1 is
 * GPIO32-39; 34-39 are input-only, which is exactly what an analog input wants. */
static const int PIN_RSSI[MAX_RX] = {36, 39, 34, 35};

/* RX5808 SPI. CLK and DATA are shared by every module; only SEL is per-module,
 * so a fifth receiver costs one more GPIO and one more ADC1 pin. */
#define PIN_SPI_CLK 18
#define PIN_SPI_DATA 23
static const int PIN_RX_SEL[MAX_RX] = {25, 26, 27, 13};

/* POWER. An RX5808 is specified at 3.5-5 V and around 170 mA, so it goes on the
 * board's 5V/VIN pin and not on 3V3 — 3.3 V is below its minimum. Four of them
 * plus an ESP32 with the radio up is roughly 840 mA, which is more than a USB
 * port will give you: anything past two receivers wants an external 5 V supply
 * of an amp or more into VIN. See firmware/README.md.
 *
 * Optional. Set to -1 if you are not measuring the pack.
 * A 100k/100k divider from the cell to this pin halves the voltage; adjust
 * BATTERY_DIVIDER if yours is different. Also ADC1. */
#define PIN_BATTERY 32
#define BATTERY_DIVIDER 2.0f

/* Onboard LED on most DevKits. -1 to disable. */
#define PIN_LED 2

/* -------------------------------------------------------------- signal ---- */
/* Mapping the receiver's RSSI pin onto the scale the app is built for.
 *
 * A LapRF reports roughly 950 with the room quiet and up to about 3000 at a
 * close pass, and every constant in the app — the 120-count minimum span, the
 * rise a lap has to show, the track presets — is tuned to that. So this gate
 * has to speak in the same units or none of it means what it means.
 *
 * The reading is taken in millivolts rather than raw ADC counts, because the
 * ESP32's ADC is markedly non-linear and analogReadMilliVolts() applies the
 * per-chip calibration burned into its eFuses at the factory. That makes these
 * four numbers a property of the RX5808, not of the particular ESP32.
 *
 * THESE ARE A STARTING POINT, NOT A MEASUREMENT. They come from the RX5808's
 * typical RSSI output range, not from your module. Send `r` over the serial
 * monitor to see live millivolts, and set RSSI_MV_QUIET to what you read with
 * the room empty and RSSI_MV_PEAK to what you read with a quad at the gate. */
#define RSSI_MV_QUIET 200   /* millivolts with nothing flying */
#define RSSI_MV_PEAK 1100   /* millivolts with a quad at the gate */
#define LAPRF_QUIET 950.0f  /* what a LapRF reports when quiet */
#define LAPRF_PEAK 2900.0f  /* what a LapRF reports at a close pass */

/* Reads per sample, averaged. The ESP32's ADC is noisy enough that a single
 * read wanders by tens of millivolts, and averaging steadies it.
 *
 * Four rather than eight because of the loop budget: at SAMPLE_HZ 200 the whole
 * cycle has 5 ms, analogReadMilliVolts() costs on the order of 100 us because it
 * applies the per-chip calibration, and four receivers times eight reads is most
 * of that gone before the radio has had a turn. Four leaves room, and the
 * median-of-five in gate.h is what actually rejects a wild sample. */
#define ADC_OVERSAMPLE 4

/* How often each receiver is sampled. A whoop crossing lasts a few hundred
 * milliseconds, so 200 Hz puts dozens of samples inside one — enough that the
 * median filter cannot blunt a pass and enough to land on its peak. */
#define SAMPLE_HZ 200

/* -------------------------------------------------------------- defaults -- */
/* Only used until the app says otherwise, which it does within a second of
 * connecting. A gate that comes up on Raceband 1 with a trigger it can never
 * cross is still a gate that says nothing, so the defaults are deliberately
 * mid-range rather than optimistic. */
#define DEFAULT_BAND 2      /* FREBA -> 2 is Raceband */
#define DEFAULT_THRESHOLD 1500.0f
#define DEFAULT_MIN_LAP_MS 1000
#define DEFAULT_STATUS_INTERVAL_MS 200

/* --------------------------------------------------------------- radio ---- */
/* The app's device chooser filters on the Nordic UART service UUID or on a name
 * beginning with CrabLake, LapRF or ImmersionRC. This advertises the service
 * UUID, which is the reliable half; the name is there so a human can tell two
 * gates apart in the chooser, and starts with LapRF so the name filter matches
 * as well. Change the suffix, not the prefix. */
#define DEVICE_NAME "LapRF-WhoopGate"
