// Race engine scenarios. Run: node tests/test_race_engine.mjs
// Each case is a thing that went wrong at a real gate, or would have.
import { Race } from '../static/js/race.js';

let fails = 0;
const ok = (name, cond, detail = '') => { if (!cond) { fails++; console.log('  ✗', name, detail); } };
const mk = (cfg = {}) => {
  const calls = [];
  const r = new Race({ onCallout: t => calls.push(t), onFinish: () => calls.push('<finish>') });
  r.configure({ minLap: 3, ...cfg });
  r._calls = calls;
  return r;
};
const solo = r => [2, 3, 4].forEach(s => r.setPilot(s, { enabled: false }));

// A pilot who has finished a laps race cannot keep lapping and steal the win.
{
  const r = mk({ mode: 'laps', targetLaps: 2 }); [3, 4].forEach(s => r.setPilot(s, { enabled: false }));
  r.startNow(); const t0 = r.startedAt;
  r.onPassing(1, t0 + 10); r.onPassing(1, t0 + 20);          // P1 done at 20
  r.onPassing(2, t0 + 11); r.onPassing(1, t0 + 30);          // P1 cool-down: ignored
  ok('finished pilot ignored', r.pilots.get(1).lapCount === 2);
  ok('win announced once', r._calls.filter(c => /wins/.test(c)).length === 1, JSON.stringify(r._calls));
  r.onPassing(2, t0 + 25);
  ok('auto finish', r.state === 'finished' && r.finishedBy === 'auto');
  ok('first finisher wins', r.results().results[0].slot === 1);
}
// Undo after a manual Stop does not restart the race.
{
  const r = mk({ mode: 'laps', targetLaps: 5 }); solo(r);
  r.startNow(); r.onPassing(1, r.startedAt + 10); r.stop();
  r.undoLap(1); ok('manual stop stays stopped', r.state === 'finished');
}
// Undo after an auto finish resumes; the refinish is the same race in history.
{
  const r = mk({ mode: 'laps', targetLaps: 1 }); solo(r);
  r.startNow(); const t0 = r.startedAt; r.onPassing(1, t0 + 10);
  const id = r.results().runId;
  const u = r.undoLap(1); ok('undo resumes an auto finish', r.state === 'running' && u.resumed);
  r.onPassing(1, t0 + 14); ok('refinish keeps runId', r.state === 'finished' && r.results().runId === id);
}
// Minimum lap applies to the first crossing: a quad rising past the gate is not a 0.4 s lap.
{
  const r = mk({ mode: 'practice' }); solo(r);
  r.startNow(); const t0 = r.startedAt;
  ok('0.4 s first lap rejected', r.onPassing(1, t0 + 0.4) === false);
  ok('3.5 s first lap accepted', r.onPassing(1, t0 + 3.5) === true);
}
// Holeshot: the away crossing is exempt from min-lap; undoing lap 1 keeps the pilot "away".
{
  const r = mk({ mode: 'practice', holeshot: true }); solo(r);
  r.startNow(); const t0 = r.startedAt;
  ok('away at 1 s accepted', r.onPassing(1, t0 + 1) === false && r.pilots.get(1).started);
  ok('lap 1 timed from away', r.onPassing(1, t0 + 13) === true && Math.abs(r.pilots.get(1).last - 12) < 1e-9);
  r.undoLap(1);
  ok('still away after undo', r.pilots.get(1).started === true);
  ok('next crossing is a lap', r.onPassing(1, t0 + 25) === true && r.pilots.get(1).lapCount === 1);
}
// A time limit is a wall: a late crossing ends the race at the limit and does not count.
{
  const r = mk({ mode: 'time', targetSeconds: 60 }); solo(r);
  r.startNow(); const t0 = r.startedAt; r.onPassing(1, t0 + 10);
  ok('late pass rejected', r.onPassing(1, t0 + 65) === false);
  ok('ended at the limit', r.state === 'finished' && Math.abs(r.elapsed - 60) < 1e-6 && r.finishedBy === 'auto');
}
// Standings follow crossing order among equal lap counts, so the announced winner is the winner.
{
  const r = mk({ mode: 'laps', targetLaps: 2, holeshot: true }); [3, 4].forEach(s => r.setPilot(s, { enabled: false }));
  r.startNow(); const t0 = r.startedAt;
  r.onPassing(1, t0 + 1); r.onPassing(2, t0 + 5);
  r.onPassing(1, t0 + 11); r.onPassing(2, t0 + 13);
  r.onPassing(1, t0 + 21); r.onPassing(2, t0 + 22);       // P1 crosses first; P2 has the smaller lap sum
  ok('winner by crossing order', r.results().results[0].slot === 1);
  ok('callout agrees', r._calls.includes('Pilot 1 wins!'));
}
// Lap times come from the timer's clock when it is sane, wall-clock when it reset.
{
  const r = mk({ mode: 'practice' }); solo(r);
  r.startNow(); const t0 = r.startedAt;
  r.onPassing(1, t0 + 5, 100000); r.onPassing(1, t0 + 15.3, 110120);
  ok('timer clock used', Math.abs(r.pilots.get(1).last - 10.12) < 1e-9);
  r.onPassing(1, t0 + 27, 500);
  ok('clock reset falls back to wall', Math.abs(r.pilots.get(1).last - 11.7) < 1e-9);
}
// Consecutive mode announces the leader and every change of leader.
{
  const r = mk({ mode: 'consecutive', consecN: 2 }); [3, 4].forEach(s => r.setPilot(s, { enabled: false }));
  r.startNow(); const t0 = r.startedAt;
  r.onPassing(1, t0 + 10); r.onPassing(1, t0 + 20); r.onPassing(1, t0 + 30);
  r.onPassing(2, t0 + 9); r.onPassing(2, t0 + 18); r.onPassing(2, t0 + 27);
  ok('two leader callouts', r._calls.filter(c => /leads/.test(c)).length === 2, JSON.stringify(r._calls));
}
// Undo with nothing to undo is refused; ties in standings keep slot order.
{
  const r = mk({ mode: 'practice' });
  r.startNow(); ok('undo empty refused', r.undoLap(1).ok === false);
  ok('empty standings keep slot order', r.standings().map(p => p.slot).join() === '1,2,3,4');
}

console.log(fails ? `${fails} FAILURES` : 'race engine: all scenarios pass');
process.exit(fails ? 1 : 0);
