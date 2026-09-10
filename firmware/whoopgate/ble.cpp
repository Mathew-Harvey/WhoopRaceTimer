#include "ble.h"

#include <Arduino.h>
#include <BLE2902.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>

static const char* NUS_SERVICE = "6e400001-b5a3-f393-e0a9-e50e24dcca9e";
static const char* NUS_CONTROL = "6e400002-b5a3-f393-e0a9-e50e24dcca9e";
static const char* NUS_STREAM = "6e400003-b5a3-f393-e0a9-e50e24dcca9e";

static BLEServer* server = nullptr;
static BLECharacteristic* streamChar = nullptr;
static volatile bool isConnected = false;
static volatile bool connChanged = false;

/* Inbound bytes arrive on the radio's own task and are consumed by loop(), so
 * the ring is entered under a spinlock. It is bytes rather than records on
 * purpose: framing is the protocol layer's job, and doing it here would mean
 * parsing LapRF inside a BLE callback. */
static const size_t RX_CAP = 1024;
static uint8_t rxBuf[RX_CAP];
static volatile size_t rxHead = 0, rxTail = 0;
static portMUX_TYPE rxMux = portMUX_INITIALIZER_UNLOCKED;

/* Notification payload. 23 is the default ATT MTU and 3 bytes of that are the
 * header, which is why a LapRF's own client writes in 20-byte pieces. If the
 * central negotiates more, use it; if it does not, 20 always works. */
static size_t chunkSize = 20;

class ServerCallbacks : public BLEServerCallbacks {
  void onConnect(BLEServer* s) override {
    isConnected = true;
    connChanged = true;
    uint16_t mtu = BLEDevice::getMTU();
    chunkSize = (mtu > 23) ? (size_t)(mtu - 3) : 20;
    if (chunkSize > 180) chunkSize = 180;
    (void)s;
  }

  void onDisconnect(BLEServer* s) override {
    isConnected = false;
    connChanged = true;
    chunkSize = 20;
    /* A real LapRF stops advertising after power-on and never starts again,
     * which is the single most common reason a timer "isn't showing up". There
     * is no reason to reproduce that: start advertising again immediately, so a
     * dropped link is one tap to recover rather than a power cycle. */
    s->startAdvertising();
  }
};

class ControlCallbacks : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic* c) override {
    String v = c->getValue();
    const uint8_t* p = (const uint8_t*)v.c_str();
    size_t n = v.length();
    portENTER_CRITICAL(&rxMux);
    for (size_t i = 0; i < n; i++) {
      size_t next = (rxHead + 1) % RX_CAP;
      if (next == rxTail) break;  /* full: drop the tail of this write */
      rxBuf[rxHead] = p[i];
      rxHead = next;
    }
    portEXIT_CRITICAL(&rxMux);
  }
};

void BleUart::begin(const char* deviceName) {
  BLEDevice::init(deviceName);
  BLEDevice::setMTU(185);

  server = BLEDevice::createServer();
  server->setCallbacks(new ServerCallbacks());

  BLEService* svc = server->createService(NUS_SERVICE);

  BLECharacteristic* control = svc->createCharacteristic(
      NUS_CONTROL,
      BLECharacteristic::PROPERTY_WRITE | BLECharacteristic::PROPERTY_WRITE_NR);
  control->setCallbacks(new ControlCallbacks());

  streamChar = svc->createCharacteristic(NUS_STREAM,
                                         BLECharacteristic::PROPERTY_NOTIFY);
  streamChar->addDescriptor(new BLE2902());

  svc->start();

  /* The service UUID goes in the advertisement and the name in the scan
   * response. A 128-bit UUID is 18 of the 31 bytes an advertisement has, and a
   * name long enough to tell two gates apart does not fit beside it — but the
   * chooser's filters see both packets, so both filters still match. */
  BLEAdvertising* adv = BLEDevice::getAdvertising();
  adv->addServiceUUID(NUS_SERVICE);
  adv->setScanResponse(true);
  adv->setMinPreferred(0x06);
  adv->setMinPreferred(0x12);
  BLEDevice::startAdvertising();
}

bool BleUart::connected() const { return isConnected; }

void BleUart::send(const uint8_t* data, size_t len) {
  if (!isConnected || streamChar == nullptr) return;
  for (size_t i = 0; i < len; i += chunkSize) {
    size_t n = len - i;
    if (n > chunkSize) n = chunkSize;
    streamChar->setValue((uint8_t*)(data + i), n);
    streamChar->notify();
    /* The stack queues a small number of notifications and silently drops the
     * rest. Yielding between them lets it drain, which costs a millisecond and
     * is the difference between a status record arriving and half of one. */
    delay(1);
  }
}

size_t BleUart::read(uint8_t* out, size_t max) {
  size_t n = 0;
  portENTER_CRITICAL(&rxMux);
  while (n < max && rxTail != rxHead) {
    out[n++] = rxBuf[rxTail];
    rxTail = (rxTail + 1) % RX_CAP;
  }
  portEXIT_CRITICAL(&rxMux);
  return n;
}

bool BleUart::takeConnectionChange() {
  if (!connChanged) return false;
  connChanged = false;
  return true;
}
