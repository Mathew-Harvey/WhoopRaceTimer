/* Entry point. Kept separate from app.js so the module graph has one root and
 * the service worker has one stable file to precache. */
'use strict';
import app from './app.js';
import { toast } from './ui.js';

/* ---- staging countdown overlay -------------------------------------------
 * The countdown is the one moment where the screen must be readable from the
 * far side of a hall, so it takes the whole viewport rather than sitting in the
 * timing band. */
const staging = document.getElementById('staging');
const cdNum = document.getElementById('cdNum');
const cdTip = document.getElementById('cdTip');
const goFlash = document.getElementById('goflash');
/* The countdown covers the whole screen, so the one thing anyone needs during
 * it has to live on the overlay itself. */
document.getElementById('cdCancel').addEventListener('click', () => app.resetRace());
let spokenAt = null, lastState = 'idle';

function overlayTick() {
  const r = app.race;
  const left = r.countdownLeft;
  if (r.state === 'staging' && left != null) {
    staging.hidden = false;
    const whole = Math.ceil(left);
    cdNum.textContent = String(whole);
    cdTip.textContent = r.solo ? 'Get on the line' : 'Arm your quads';
    if (whole !== spokenAt && whole > 0 && whole <= 3) {
      spokenAt = whole;
      app.voice.say(String(whole), { priority: true });
    }
  } else {
    staging.hidden = true;
    spokenAt = null;
  }
  if (lastState !== r.state) {
    if (lastState === 'staging' && r.state === 'running') {
      goFlash.hidden = false;
      setTimeout(() => { goFlash.hidden = true; }, 700);
    }
    lastState = r.state;
  }
  requestAnimationFrame(overlayTick);
}
requestAnimationFrame(overlayTick);

/* ---- offline ------------------------------------------------------------- */
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}

/* A race that dies because a browser tab was closed by accident is worth one
 * dialog. Nothing else in the app blocks. */
addEventListener('beforeunload', e => {
  if (app.race.state === 'running') { e.preventDefault(); e.returnValue = ''; }
});

addEventListener('error', e => {
  console.error(e.error || e.message);
  toast('Something went wrong — check the browser console', 'err');
});
