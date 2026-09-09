"""The bridge holds one timer, and says the right thing when it holds none.

Small, but it covers the two ways a second transport could ruin a race that no
other suite can see: a LapRF and a node both feeding the page at once, and a
missing node explained as if it were a missing LapRF.

    python3 tests/test_bridge.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import server  # noqa: E402

FAILURES = []


def check(name, cond, detail=""):
    if not cond:
        FAILURES.append(f"{name}{chr(10) + '     ' + detail if detail else ''}")


class Fake:
    """Stands in for a transport: records that it was started, never opens anything."""

    def __init__(self, *a, **k):
        self.started = False
        self.connected = False
        self.detail = "fake"
        self.sent = []

    def start(self):
        self.started = True

    def stop(self):
        pass

    def send(self, data):
        self.sent.append(data)


class Module:
    """Stands in for the ble / device / rotorhazard modules."""

    def __init__(self):
        self.made = []

    def _make(self, *a, **k):
        f = Fake()
        self.made.append(f)
        return f

    LapRFBle = LapRFSerial = RotorHazardNode = property(lambda self: self._make)


def build(**kw):
    """A Bridge with every transport replaced by something that opens nothing."""
    mods = {"ble": Module(), "dev": Module(), "rh": Module()}
    saved = (server.blemod, server.devmod, server.rhmod)
    server.blemod, server.devmod, server.rhmod = mods["ble"], mods["dev"], mods["rh"]
    # _start_ble spawns a thread and an event loop; the flag is what matters here.
    started_ble = []
    saved_start = server.Bridge._start_ble
    server.Bridge._start_ble = lambda self: started_ble.append(True)
    try:
        b = server.Bridge(**kw)
    finally:
        server.blemod, server.devmod, server.rhmod = saved
        server.Bridge._start_ble = saved_start
    return b, mods, bool(started_ble)


# A node is opt-in and exclusive. Both LapRF paths must be off — not just the
# serial one. They share a fan-out and the page cannot tell two timers apart:
# every crossing would be counted twice, on one slot, at two different signal
# scales, with two unrelated passing-number sequences. Worse, the handshake goes
# to whichever transport ranks highest, so the node would never be told the
# app's threshold or minimum lap and would go on using its own.
b, mods, ble_started = build(rh_port="auto")
check("a node is opened", b.rh is not None)
check("and the LapRF serial path is not", b.usb is None,
      "it would open the node's own port and read LapRF records out of it")
check("and Bluetooth is not either", not ble_started,
      "a LapRF powered on in the same room would take the handshake and the node "
      "would never hear the app's threshold; both would feed the page at once")

# Without one, nothing changes about how a LapRF is found.
b, mods, ble_started = build()
check("without a node, the LapRF serial path is opened", b.usb is not None)
check("and Bluetooth is too", ble_started)
check("and no node is", b.rh is None)

# The node outranks Bluetooth wherever a transport is chosen, so that no
# ordering accident can route a write to a LapRF that happens to be switched on.
b, mods, _ = build(rh_port="auto")
b.rh.connected = True
b.rh.detail = "RotorHazard node (API 35, address 8) on /dev/ttyUSB0"
b.ble = Fake()
b.ble.connected = True                      # a LapRF switched on in the same room
b.ble.detail = "LapRF"
b._ble_loop = object()
to_ble = []
saved_schedule = server.asyncio.run_coroutine_threadsafe
server.asyncio.run_coroutine_threadsafe = lambda coro, loop: to_ble.append(coro)
try:
    check("the node is the transport", b.transport == "rotorhazard", f"got {b.transport}")
    check("  and its own detail is what the page shows", b.detail == b.rh.detail,
          f"page would show {b.detail!r}")
    b.send(b"\x5a\x00")
finally:
    server.asyncio.run_coroutine_threadsafe = saved_schedule
check("  and a write goes to it", b.rh.sent and not to_ble,
      "the handshake went to a LapRF, so the node never heard the app's threshold")

# When there is no timer, the reason must be about the hardware being used.
# Telling someone whose node is unplugged to check a LapRF's advertising window
# and its battery is advice about equipment they have said they are not using.
b, mods, _ = build(rh_port="auto")
reason = b.status()["reason"]
check("a missing node is explained as a missing node",
      reason and "node" in reason.lower() and "laprf" not in reason.lower(),
      f"said: {reason}")
check("  and it points at the log that names every port tried",
      reason and "log" in reason.lower(), f"said: {reason}")
b, mods, _ = build()
reason = b.status()["reason"]
check("a missing LapRF is still explained as one",
      reason and ("laprf" in reason.lower() or "bluetooth" in reason.lower()),
      f"said: {reason}")

if FAILURES:
    print(f"{len(FAILURES)} failure(s):\n")
    for f in FAILURES:
        print("  FAIL " + f)
    sys.exit(1)
print("bridge: one timer at a time, and the right reason when there is none")
