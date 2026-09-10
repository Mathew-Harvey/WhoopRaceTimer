/* The Nordic UART Service, which is how a LapRF is talked to.
 *
 * The app's device chooser filters on this service UUID, opens the control
 * characteristic for writes and subscribes to the stream characteristic for
 * notifications. Those three UUIDs are the whole contract; match them and a
 * browser connects to this gate with no bridge, no driver and no cable.
 */
#pragma once
#include <stddef.h>
#include <stdint.h>

class BleUart {
 public:
  void begin(const char* deviceName);

  bool connected() const;

  /** Queue a record for the stream characteristic. Split into MTU-sized
   *  notifications; the app reassembles them, which it has to do anyway
   *  because a real LapRF's records do not fit in one either. */
  void send(const uint8_t* data, size_t len);

  /** Bytes written to the control characteristic, oldest first. Returns the
   *  number copied. Safe to call from loop(); the radio fills the buffer from
   *  its own task. */
  size_t read(uint8_t* out, size_t max);

  /** True once since the last call if a client connected or dropped — the
   *  cue to reset per-connection state rather than carry it into a new race. */
  bool takeConnectionChange();
};
