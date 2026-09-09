/* The spoken side of calibrating a gate.
 *
 * Nobody at a track is looking at a phone. They are holding a quad, wearing
 * goggles, or standing at the far end of a room — so the whole calibration
 * conversation happens out loud, and the screen is only there for anyone who
 * wants to check the numbers.
 *
 * The conversation has three beats and never more:
 *
 *   brief     what to do, once, at the start — set 25 mW and fly
 *   progress  that it is working, per lap solo, per pilot in a race
 *   done      that it is finished and timing is live
 *
 * It is a state machine over that, rather than a set of conditions checked in
 * the render loop, because the one thing worse than silence here is a phone
 * repeating itself every animation frame.
 */
'use strict';

/* 25 mW is not arbitrary. On a micro track a hotter transmitter floods every
 * receiver in the room, so a pass on one channel lifts all four and the gate
 * can no longer tell whose quad went through. Low power keeps the peak local,
 * which is the whole basis of RSSI timing indoors. */
export const CALIBRATION_POWER = '25 milliwatts';

/* Silence this long from a receiver that has never heard anything is a channel
 * problem, not a patience problem. */
export const SILENT_S = 25;

export class CalibrationCoach {
  /**
   * @param say   speak a line; the caller decides whether the voice is on
   * @param note  optional on-screen echo of the same line
   */
  constructor({ say, note = () => {} } = {}) {
    this.say = say;
    this.note = note;
    this.reset();
  }

  /** A new timer, or a new session, is a new conversation. */
  reset() {
    this.phase = 'idle';        // idle | briefed | done
    this.saidFor = {};          // slot -> passes already announced
    this.doneSlots = new Set();
    this.silentSaid = new Set();
    this.lastLine = null;
  }

  _speak(line, { priority = false } = {}) {
    this.lastLine = line;
    this.say(line, { priority });
    this.note(line);
    return line;
  }

  /**
   * Called whenever the evidence changes.
   *
   * `slots` is one entry per racing receiver: { slot, name, seen, need, ready }.
   * Returns the line spoken this time, or null when there was nothing to say —
   * which is most of the time, and is the point.
   */
  update({ solo, slots, connected = true }) {
    if (!connected || !slots.length) return null;

    if (this.phase === 'done') {
      /* A gate that was calibrated and has drifted back is worth saying once,
       * because from here on the lap times are not to be trusted. */
      if (slots.some(s => !s.ready)) {
        this.phase = 'briefed';
        this.doneSlots = new Set(slots.filter(s => s.ready).map(s => s.slot));
        /* Take the laps already flown as read. Without this the very next
         * update follows "needs calibrating again" with a progress line about
         * the same laps, which is the phone talking to itself. */
        for (const s of slots) this.saidFor[s.slot] = s.seen;
        return this._speak('Gate out of calibration. Keep flying.');
      }
      return null;
    }

    if (this.phase === 'idle') {
      this.phase = 'briefed';
      /* Said before anything has been flown, so it is an instruction rather
       * than a running commentary. */
      return this._speak(solo
        ? `Set video power to ${CALIBRATION_POWER}. Fly the gate to calibrate.`
        : `All pilots: video power ${CALIBRATION_POWER}. Fly practice laps until every ` +
          `quad is calibrated.`);
    }

    /* A receiver that has heard nothing at all is not calibrating slowly, it is
     * not listening to the right thing — almost always the wrong channel, since
     * a whoop on R1 is invisible to a receiver sitting on R8. Saying "keep
     * flying" to someone whose quad cannot be heard is the worst thing this
     * flow could do, so it says the useful thing instead, once per receiver. */
    for (const s of slots) {
      if (s.seen === 0 && s.silentFor > SILENT_S && !this.silentSaid.has(s.slot)) {
        this.silentSaid.add(s.slot);
        return this._speak(solo
          ? 'No signal on this receiver. Check your video channel.'
          : `No signal from ${s.name || 'slot ' + s.slot}. Check their video channel.`);
      }
      if (s.seen > 0) this.silentSaid.delete(s.slot);
    }

    /* Per-pilot completion, in a race: the useful progress report is who is
     * finished, because that is who can stop flying. */
    if (!solo) {
      for (const s of slots) {
        if (s.ready && !this.doneSlots.has(s.slot)) {
          this.doneSlots.add(s.slot);
          const left = slots.filter(x => !x.ready).length;
          if (left) {
            return this._speak(`${s.name || 'Slot ' + s.slot} calibrated. ` +
                               `${left} remaining.`);
          }
        }
      }
    }

    if (slots.every(s => s.ready)) {
      this.phase = 'done';
      return this._speak(solo ? 'Calibration complete. Timing live.'
                              : 'All quads calibrated. Ready to race.',
                         { priority: true });
    }

    /* Solo progress: one line per calibration lap, so the pilot flying knows it
     * is counting and roughly how much longer. */
    if (solo) {
      const s = slots[0];
      if (s.seen > (this.saidFor[s.slot] || 0)) {
        this.saidFor[s.slot] = s.seen;
        if (s.seen < s.need) {
          return this._speak(`Calibration lap ${s.seen} of ${s.need}.`);
        }
        /* Seen enough laps but not yet confident — say why, rather than going
         * quiet at the exact moment someone expects to hear "complete". */
        return this._speak('Passes inconsistent. More laps needed.');
      }
    }
    return null;
  }
}
