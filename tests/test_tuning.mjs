/* Gate tuning: the ceiling that decides a trigger, and the pass watcher that
 * tells someone whether that trigger is right.
 *
 * Both of these are things nobody can check by looking at a screen: a ceiling
 * inflated by one spike looks exactly like a correct one, and a pass that
 * missed the trigger looks exactly like not having flown yet. So they are
 * pinned here instead.
 *
 *   node tests/test_tuning.mjs
 */
import { Calibration, SlotSignal, passReport, derive, gateHealth } from '../static/js/tuning.js';
import { viewBytes } from '../static/js/link.js';
import { ChannelScanner } from '../static/js/tuning.js';
import { ALL_CHANNELS, splitRecords, decodeRecord } from '../static/js/laprf.js';

let failures = 0;
function check(name, cond, detail) {
  if (cond) return;
  failures++;
  console.error(`FAIL ${name}${detail ? '\n  ' + detail : ''}`);
}
const eq = (name, got, want) => check(name, got === want, `got ${got}, want ${want}`);
const near = (name, got, want, tol = 0.51) =>
  check(name, Math.abs(got - want) <= tol, `got ${got}, want ~${want}`);

/* --------------------------------------------------- reading a notification --- */
/* Chrome hands out Bluetooth notifications as views into a buffer it reuses, so
 * a notification's ArrayBuffer routinely holds the previous one as well. Taking
 * the buffer instead of the view delivers every packet twice — once as itself
 * and once as the tail of its successor — and every record then fails its CRC,
 * which looks exactly like a receiver that cannot hear anything. */
{
  const pool = new ArrayBuffer(28);
  new Uint8Array(pool).set([...Array(14).keys(), ...Array(14).keys()].map((n, i) => i < 14 ? n : n + 100));
  const second = new DataView(pool, 14, 14);
  const got = viewBytes(second);
  eq('only this notification is taken', got.length, 14);
  eq('and from the right offset', got[0], 100);
  check('the buffer really did hold the previous packet too',
        new Uint8Array(second.buffer).length === 28,
        'the trap this guards against no longer exists in the fixture');
}

/* ------------------------------------------------------ finding a channel --- */
/* A sweep cannot resolve channels closer together than a video signal is wide.
 * R8 is 5917 and E7 is 5925: one quad on R8 lights up both, and either can read
 * higher on the day. Taking the strongest reading therefore reports a label the
 * pilot's goggles do not show. */
function sweep(overrides) {
  const rows = ALL_CHANNELS.map(c => ({ ...c, peak: 960, samples: 2 }));
  for (const [name, peak] of Object.entries(overrides)) {
    rows.find(r => r.name === name).peak = peak;
  }
  return rows;
}

{
  /* The observed case: the quad is on R8 and E7 came back marginally stronger. */
  const b = ChannelScanner.best(sweep({ R8: 2000, E7: 2050, E6: 1400, E8: 1300 }));
  eq('the label a pilot recognises wins a tie', b.name, 'R8');
  eq('at the right frequency', b.freq, 5917);
  eq('and the other name is offered too', b.alsoCalled.map(r => r.name).join(), 'E7');
  eq('still confident', b.confident, true);
}

/* Two transmitters in one room, from a real flight: the pilot's whoop on R8,
 * and somebody else's video on F1 reading thirty-eight counts stronger. Taking
 * the loudest reported a channel 177 MHz from the one their goggles showed, and
 * the receiver spent the flight listening to the wrong one. */
{
  const found = ChannelScanner.signals(sweep({ F1: 2387, R8: 2349, E7: 2346 }));
  eq('both transmitters are found', found.length, 2);
  eq('the loudest is still reported first', found[0].name, 'F1');
  eq('and the pilot’s quad is not swallowed by it', found[1].name, 'R8');
  eq('with its other label offered', found[1].alsoCalled.map(r => r.name).join(), 'E7');
  check('they are not merged into one signal', found[0].freq !== found[1].freq, 'grouped wrongly');
}

/* One transmitter is still one answer, however wide its skirts. */
{
  const found = ChannelScanner.signals(sweep({ R8: 2400, E7: 2380, E6: 1400 }));
  eq('overlapping readings are one signal', found.length, 1);
  eq('named the way a pilot would', found[0].name, 'R8');
}

/* A quiet room has nothing to offer. */
eq('silence is no signals', ChannelScanner.signals(sweep({})).length, 0);

{
  /* A genuine E-band signal, nothing near it, is not dragged to Raceband. */
  const b = ChannelScanner.best(sweep({ E4: 2400 }));
  eq('an unambiguous channel is reported as itself', b.name, 'E4');
  eq('with nothing to confuse it with', b.alsoCalled.length, 0);
}

{
  /* F8 and R7 are both 5880 — the same frequency under two names. */
  const b = ChannelScanner.best(sweep({ R7: 2300, F8: 2300 }));
  check('an exact duplicate frequency resolves to one of its names',
        ['R7', 'F8'].includes(b.name), `picked ${b.name}`);
  check('and names the other', b.alsoCalled.some(r => ['R7', 'F8'].includes(r.name)),
        'the duplicate label was not offered');
}

{
  /* Noise alone is not a channel. */
  const b = ChannelScanner.best(sweep({}));
  eq('a flat sweep is not confident', b.confident, false);
}

/* ------------------------------------------------- a sweep that waits ----- */
/* Reported from a real flight: a quad on 5917 read a thousand counts stronger
 * eight megahertz away at 5925. The cause was timing, not radio. Retuning is
 * queued and paced — chunked writes thirty milliseconds apart — so a settle
 * clock started when the instruction was queued expires while the receiver is
 * still on the previous frequency. The reading taken there then counts as the
 * new channel's, and because the rule deliberately takes the lower of two, a
 * stale reading from a quiet neighbour actively wins.
 *
 * That biases whole regions of the sweep by whatever preceded them: 5925 came
 * after a frequency near the signal and 5917 came after one nowhere near it. */
{
  const order = [5880, 5917, 5925];
  const truth = { 5880: 900, 5917: 2400, 5925: 1500 };
  let onAir = 5880, i = 0;
  const link = {
    connected: true,
    /* A real link is alive only while it is both connected and not retired. A
     * fixture that omits this models a link that cannot exist, and would have
     * hidden the very check that stops a sweep running on a dead link. */
    alive: true,
    /* Transmission takes real time, and the receiver only moves once it lands —
     * and only for a tuning record, not for the status-rate request the sweep
     * opens with. */
    send: async f => {
      await new Promise(r => setTimeout(r, 120));
      const isTune = f[5] === 0x02 && f[6] === 0xda;
      if (isTune) onAir = order[Math.min(++i, order.length - 1)];
    },
  };
  const sc = new ChannelScanner({
    link,
    /* Where the receiver was before the sweep: the restore depends on this
     * being present, and a fixture without a frequency never exercised it. */
    rfFor: () => ({ band: 2, channel: 8, frequency: 5917, threshold: 1600, gain: 58 }),
    sample: () => ({ v: truth[onAir], t: Date.now() / 1000 }),
    settleMs: 260, maxWaitMs: 900,
  });
  const rows = await sc.sweepRange(1, 5917, 5925, 8);
  const by = Object.fromEntries(rows.map(r => [r.name, r.peak]));
  eq('the strong frequency reads strong', by['5917'], 2400);
  eq('and its weaker neighbour reads weak', by['5925'], 1500);
  check('the neighbour is not inflated past it', by['5925'] < by['5917'],
        `5925 read ${by['5925']} against 5917 at ${by['5917']}`);
}

/* A sweep leaves the receiver where it found it, and does not quietly switch a
 * slot back on that the pilot had switched off. */
{
  const sent = [];
  const link = { connected: true, alive: true, send: async f => { sent.push(f); } };
  const sc = new ChannelScanner({
    link,
    rfFor: () => ({ band: 2, channel: 8, frequency: 5917, threshold: 1450, gain: 47,
                    enabled: false }),
    sample: () => ({ v: 1000, t: Date.now() / 1000 + 999 }),
    settleMs: 0, maxWaitMs: 1,
  });
  await sc.sweepRange(1, 5930, 5934, 4);
  const decoded = sent.map(f => decodeRecord(splitRecords(f.slice()).records[0]));
  const rf = decoded.filter(d => d.type === 'rfSetup');
  const last = rf[rf.length - 1];
  eq('the receiver goes back to its own frequency', last.frequency, 5917);
  eq('with the trigger it had', last.threshold, 1450);
  eq('and the gain it had', last.gain, 47);
  eq('and still switched off', last.enabled, 0);
  const intervals = decoded.filter(d => d.statusInterval !== undefined).map(d => d.statusInterval);
  eq('and the signal stream is left fast', intervals[intervals.length - 1], 200);
}

/* A sweep on a link that has been retired — replaced by one to the same device,
 * so still marked connected — must fail rather than invent a set of readings
 * from a receiver it never actually retuned. */
{
  const link = { connected: true, alive: false, send: async () => true };
  const sc = new ChannelScanner({
    link, rfFor: () => ({ frequency: 5917 }),
    sample: () => ({ v: 2000, t: Date.now() / 1000 + 999 }),
    settleMs: 0, maxWaitMs: 1,
  });
  const rows = await sc.sweepRange(1, 5910, 5920, 2);
  eq('a retired link measures nothing', rows.length, 0);
  eq('and says so', sc.lost, true);
}

/* --------------------------------------------------------- gate health --- */
/* What every screen shows about a receiver, and what the pre-race checks refuse
 * to start on. It had no coverage at all while its verdict ladder was rewritten
 * twice in a day. */
{
  const base = { threshold: 1600, floor: null, ceiling: null, live: 960 };

  eq('a slot nobody is racing is not a problem',
     gateHealth({ ...base, enabled: false }).level, 'off');
  eq('a trigger the timer has not reported is unknown',
     gateHealth({ ...base, threshold: null }).level, 'unknown');

  /* The gate that can never fire, and the one verdict that must always win. */
  const under = gateHealth({ ...base, threshold: 700, live: 962 });
  eq('a trigger under the noise is fatal', under.fatal, true);
  check('even when the flown laps say otherwise',
        gateHealth({ ...base, threshold: 700, live: 962,
                     cal: { ready: true, seen: 9, verdict: 'good' } }).fatal === true,
        'readiness overrode a gate that physically cannot report a lap');

  /* Calibrated by flying. */
  const flown = gateHealth({ ...base, cal: { ready: true, seen: 5, verdict: 'good' } });
  eq('flown laps calibrate a gate', flown.level, 'good');
  check('and it says where the trigger came from', /flown laps/.test(flown.detail), flown.detail);

  /* Stale bounds from a wizard run days ago must not overrule laps flown now —
   * that combination reported "trigger is above the strongest pass" seconds
   * after the app had announced the gate calibrated. */
  const stale = gateHealth({ threshold: 1560, floor: 900, ceiling: 1300, live: 900,
                             cal: { ready: true, seen: 6, verdict: 'good' } });
  eq('flown laps outrank stale wizard bounds', stale.level, 'good');

  /* A gate that has stopped counting laps must never be described as merely
   * still calibrating: the gate screen hides that level entirely. */
  const missing = gateHealth({ ...base, cal: { ready: false, seen: 6, verdict: 'some missed' } });
  eq('a gate missing passes warns', missing.level, 'warn');
  const none = gateHealth({ ...base, cal: { ready: false, seen: 6, verdict: 'all missed' } });
  eq('a gate counting nothing is bad', none.level, 'bad');
  check('and neither is hidden as "calibrating"',
        missing.level !== 'learning' && none.level !== 'learning', 'a dead gate said nothing');

  /* Counting every pass, on enough laps to mean it, outranks the wizard even
   * before the evidence bar for "ready" is met — that combination used to read
   * red on a gate that was timing every lap. */
  eq('a gate counting every pass is good',
     gateHealth({ threshold: 1560, floor: 900, ceiling: 1300, live: 900,
                  cal: { ready: false, seen: 4, verdict: 'good' } }).level, 'good');

  /* A thin margin is not the same as missing passes, and telling a pilot whose
   * gate counts every lap that laps are being missed is simply wrong. */
  const thin = gateHealth({ ...base, cal: { ready: false, seen: 6, verdict: 'fragile' } });
  eq('a thin margin warns', thin.level, 'warn');
  check('and says what is actually wrong', /thin|only just/i.test(thin.title + thin.detail),
        thin.title + ' — ' + thin.detail);

  /* Too little evidence is still just calibrating — that is not a fault, and
   * one lucky lap is not a calibrated gate either. */
  eq('a fresh receiver is calibrating',
     gateHealth({ ...base, cal: { ready: false, seen: 1, verdict: 'good' } }).level, 'learning');
  eq('and so is one that has flown nothing',
     gateHealth({ ...base, cal: { ready: false, seen: 0, verdict: 'none' } }).level, 'learning');
}

/* ------------------------------------------------------------- ceiling --- */
/* A pass is several samples rising and falling; a spike is one sample. The
 * ceiling has to keep the first and ignore the second, because it sets the
 * trigger and a trigger set too high loses laps silently. */
function ceilingOf(samples) {
  const cal = new Calibration();
  cal.beginNoise([1]);
  for (const v of [960, 962, 961, 963, 960]) cal.feed(1, v);   // quiet
  cal.beginPass([1]);
  for (const v of samples) cal.feed(1, v);
  return cal.results()[1].ceiling;
}

/* One lap: the ceiling reads the shoulder rather than the tip. That is the
 * documented cost of taking the second-highest, and it errs toward a more
 * sensitive gate, which is the safe direction to be wrong in. */
const ONE_PASS = [960, 980, 1400, 2100, 2400, 2050, 1300, 970, 961];
eq('one lap reads the shoulder, not the tip', ceilingOf(ONE_PASS), 2100);

/* Three laps, as the wizard actually asks for: the second-highest is another
 * lap's peak, so the under-read disappears. */
const THREE_PASSES = [
  960, 980, 1400, 2100, 2400, 2050, 1300, 970, 961,
  960, 990, 1450, 2150, 2380, 2000, 1280, 972, 960,
  961, 985, 1420, 2120, 2350, 2030, 1310, 968, 960];
eq('three laps read the real peak', ceilingOf(THREE_PASSES), 2380);

/* The bug this exists for: one absurd sample must not become the ceiling. */
const WITH_SPIKE = [960, 961, 9999, 962, 980, 1400, 2100, 2400, 2050, 1300, 970];
eq('a one-sample spike does not become the ceiling', ceilingOf(WITH_SPIKE), 2400);

/* Two adjacent high samples are a signal, not a glitch. Refusing to believe
 * them would be its own kind of wrong. */
const TWIN = [960, 961, 5000, 5000, 962, 980, 1400, 2100];
eq('a sustained excursion is believed', ceilingOf(TWIN), 5000);

/* And the derived trigger moves with it: the spike used to drag it up. */
const floorV = 961;
near('trigger from a clean ceiling', derive(floorV, 2380, 0.42), 961 + (2380 - 961) * 0.42, 1);
check('a spiked ceiling would have set a much higher trigger',
      derive(floorV, 9999, 0.42) > derive(floorV, 2400, 0.42) + 2000,
      'the bug this guards against was worth thousands of counts');

/* -------------------------------------------------------- pass watching --- */
/* Feed a signal one sample at a time, exactly as status records arrive. */
function watch(values, threshold, quiet = 960, dt = 0.2) {
  const sig = new SlotSignal(1);
  let t = 1000;
  const events = [];
  for (const v of values) {
    t += dt;
    sig.add(v, t);
    const p = sig.observe(threshold, quiet, t);
    if (p) events.push(p);
  }
  return { sig, events };
}

/* A pass that clears the trigger counts. */
{
  const { events } = watch([960, 961, 1500, 2300, 2400, 1800, 980, 960, 960], 1600);
  eq('a strong pass is seen once', events.length, 1);
  eq('a strong pass counts', events[0].counted, true);
  eq('its peak is the peak', events[0].peak, 2400);
  check('its margin is positive', events[0].margin > 0, `margin ${events[0]?.margin}`);
}

/* The one that matters: a pass that missed. Without this it is invisible —
 * indistinguishable from nobody having flown. */
{
  const { events } = watch([960, 961, 1200, 1520, 1480, 1100, 970, 960, 960], 1600);
  eq('a near miss is still seen', events.length, 1);
  eq('a near miss does not count', events[0].counted, false);
  near('and it reports how far short it fell', events[0].margin, -80);
}

/* A signal resting on the watch level must not rattle out a pass per sample.
 * This is the hysteresis, and without it the report is nonsense. */
{
  const onTheLine = [];
  for (let i = 0; i < 40; i++) onTheLine.push(1000 + (i % 2 ? 22 : -18));
  const { events } = watch(onTheLine, 1600);
  check('a signal sitting on the line does not chatter', events.length <= 1,
        `emitted ${events.length} passes from one wobble`);
}

/* Quiet stays quiet. */
{
  const { events } = watch(Array.from({ length: 60 }, (_, i) => 958 + (i % 5)), 1600);
  eq('noise alone is not a pass', events.length, 0);
}

/* ------------------------------------------------------------- report ---- */
{
  const { sig } = watch([960, 1500, 2400, 1000, 960,          // counts
                         960, 1400, 1520, 1000, 960,          // misses by 80
                         960, 1500, 2200, 1000, 960], 1600);  // counts
  const r = passReport(sig.passes, 1600);
  eq('every excursion is reported', r.seen, 3);
  eq('two of them counted', r.counted, 2);
  eq('one missed', r.missed, 1);
  near('and the report says by how much', r.worstMiss, 80);
  eq('the verdict names the situation', r.verdict, 'some missed');
  check('the suggestion would catch the weakest pass',
        r.suggest < 1520, `suggested ${r.suggest}, weakest pass 1520`);
  check('and still sits clear of the noise',
        r.suggest > 960 + 120, `suggested ${r.suggest} is too close to quiet 960`);
}

{
  const { sig } = watch([960, 1500, 2400, 1000, 960], 1600);
  const r = passReport(sig.passes, 1600);
  eq('all clear reads as good', r.verdict, 'good');
}

eq('no passes reads as none', passReport([], 1600).verdict, 'none');

/* ------------------------------------------------- counted, but only just --- */
/* A trigger tucked just under the weakest peak counts every pass today and
 * misses on the next flight. Reporting that as "good" is the worst kind of
 * reassurance, because the failure it sets up is the silent one. */
{
  const { sig } = watch([960, 1500, 2400, 1000, 960,
                         960, 1400, 2380, 1000, 960,
                         960, 1450, 2350, 1000, 960], 2300);
  const r = passReport(sig.passes, 2300);
  eq('a thin margin is not called good', r.verdict, 'fragile');
  eq('every pass still counted', r.missed, 0);
  near('and the thinnest margin is named', r.thinnest, 50);
  check('the fix moves it somewhere safer', r.suggest < 2300 && r.suggest > 960,
        `suggested ${r.suggest}`);
  check('and the move is worth making', r.worthIt === true, 'a real move was called noise');
}

/* A comfortable margin stays good. Nothing is offered for a good gate — that
 * is decided by the verdict, not by how big the arithmetic move would be. */
{
  const { sig } = watch([960, 1500, 2400, 1000, 960,
                         960, 1400, 2380, 1000, 960], 1600);
  const r = passReport(sig.passes, 1600);
  eq('a comfortable gate is good', r.verdict, 'good');
}

/* worthIt is about the size of the move, not whether one is wanted: a trigger
 * already sitting where the evidence would put it must not be rewritten to the
 * timer for a rounding difference. */
{
  /* Placed where the "normal" preset would put it: quiet 960, weakest 2380,
   * fraction 0.42 -> 1556. Spelt out rather than inherited from whichever
   * preset happens to be the default. */
  const { sig } = watch([960, 1500, 2400, 1000, 960,
                         960, 1400, 2380, 1000, 960], 1556);
  const r = passReport(sig.passes, 1556, 0.42);
  near('the suggestion lands where the trigger already is', r.suggest, 1556, 6);
  eq('so the move is not worth making', r.worthIt, false);
}

/* The same evidence on a micro track wants a higher trigger, because there the
 * danger is a hovering quad inventing a lap rather than a weak pass being
 * missed. That is the track preset doing its job through the new path. */
{
  const { sig } = watch([960, 1500, 2400, 1000, 960,
                         960, 1400, 2380, 1000, 960], 1556);
  const tiny = passReport(sig.passes, 1556, 0.62);
  check('a micro track moves the trigger up', tiny.suggest > 1556 && tiny.worthIt,
        `suggested ${tiny.suggest}`);
}

/* The gate that can never fire. A trigger under the noise means the timer
 * thinks a quad is permanently in the gate and never sees a crossing — so no
 * lap is ever reported. By raw margin arithmetic every pass clears it, which
 * made the most broken gate possible read as the healthiest. */
{
  const { sig } = watch([960, 1500, 2400, 1000, 960,
                         960, 1400, 2380, 1000, 960,
                         960, 1450, 2350, 1000, 960], 700);
  const r = passReport(sig.passes, 700);
  eq('a trigger under the noise is not good', r.verdict, 'below noise');
  check('and it is worth fixing', r.worthIt, 'the one gate that must always be fixed was skipped');
  check('the fix is above the noise', r.suggest > 960, `suggested ${r.suggest}`);
}

/* Moving the trigger must not un-fly the laps. Self-tuning adjusts at three
 * passes; if that reset the evidence, the count could never reach three again
 * and calibration would never finish. */
{
  const { sig } = watch([960, 1500, 2400, 1000, 960,
                         960, 1400, 2380, 1000, 960,
                         960, 1450, 2350, 1000, 960], 3000);
  eq('three passes seen against a hopeless trigger', sig.passes.length, 3);
  eq('and none of them counted', passReport(sig.passes, 3000).counted, 0);
  sig.rejudge(1600);
  eq('the same three passes survive the move', sig.passes.length, 3);
  eq('and now all count', passReport(sig.passes, 1600).counted, 3);
  eq('which is a calibrated gate', passReport(sig.passes, 1600).verdict, 'good');
}

/* ------------------------------------------- what the timer itself reports --- */
/* The LapRF measures each pass peak in firmware. It is the only fully
 * trustworthy peak we ever see, and it used to be decoded and dropped. */
{
  const sig = new SlotSignal(1);
  sig.add(960, 1000);
  const p = sig.recordHardwarePass(2400, 1600, 960, 1001);
  check('a reported pass is kept', !!p, 'the timer told us and we ignored it');
  eq('it counts by definition', p.counted, true);
  eq('its margin is measured against the trigger', p.margin, 800);
  eq('and it is marked as the timer speaking', p.source, 'timer');
}

/* Some units report nothing as zero. Believing that would invent a gate whose
 * every pass looks like it barely scraped through. */
{
  const sig = new SlotSignal(1);
  sig.add(960, 1000);
  eq('a zero peak is not a pass', sig.recordHardwarePass(0, 1600, 960, 1001), null);
  eq('nor is one below the noise', sig.recordHardwarePass(900, 1600, 960, 1002), null);
  eq('nothing was recorded', sig.passes.length, 0);
}

/* One crossing seen by both the slow sampler and the timer is one crossing. */
{
  const sig = new SlotSignal(1);
  sig.add(960, 1000);
  sig.recordHardwarePass(2400, 1600, 960, 1001);
  sig.recordHardwarePass(2400, 1600, 960, 1001.2);
  eq('the same crossing is not counted twice', sig.passes.length, 1);
  sig.recordHardwarePass(2400, 1600, 960, 1009);
  eq('a later crossing is its own pass', sig.passes.length, 2);
}

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log('gate tuning: all scenarios pass');
