/* What this machine still needs before the app can do its job.
 *
 * A page cannot install a package, edit a config file, or restart a browser.
 * Every one of those sits on the other side of the sandbox, and a page that
 * could reach through it would be a page every other site could reach through
 * too. So "fix it automatically" stops at the sandbox wall, and the honest
 * split is:
 *
 *   here          name the exact thing missing on THIS machine, and hand over
 *                 the exact command that fixes it
 *   the terminal  scripts/whooptimer-doctor, which actually installs and edits
 *
 * The value is in the first half being specific. "Speech isn't supported" sends
 * someone searching; "Chromium on Linux needs --enable-speech-dispatcher, here
 * is the line, here is the file" is one paste. This file exists to make that
 * difference, not to pretend the wall isn't there.
 */
'use strict';

const DOCTOR = 'https://github.com/Mathew-Harvey/WhoopRaceTimer#setup-check';

/** Package installs, per package manager. The doctor script picks for itself. */
const PKGS = [
  ['Arch, Omarchy, Manjaro', 'sudo pacman -S --needed speech-dispatcher espeak-ng'],
  ['Debian, Ubuntu, Raspberry Pi OS', 'sudo apt install -y speech-dispatcher espeak-ng'],
  ['Fedora', 'sudo dnf install -y speech-dispatcher espeak-ng'],
];

/**
 * Wait for the voice list to settle before calling it empty.
 *
 * getVoices() is empty on the first call in every browser that loads voices
 * asynchronously, and 'voiceschanged' may fire late or — on a browser with no
 * voices at all — never. Declaring "no speech on this machine" off the first
 * synchronous read would put a scary warning in front of people whose voices
 * arrive 200 ms later.
 */
export function voicesSettled(voice, ms = 2000) {
  return new Promise(resolve => {
    if (voice.available) return resolve(true);
    const prev = voice.onChange;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      voice.onChange = prev;
      resolve(voice.available);
    };
    const t = setTimeout(finish, ms);
    voice.onChange = () => {
      try { prev?.(); } catch (e) { /* the app's own hook is not ours to break */ }
      if (voice.available) { clearTimeout(t); finish(); }
    };
  });
}

/** Is there a radio at all? Chrome knows; nothing else implements it. */
async function bluetoothAvailable() {
  if (!navigator.bluetooth?.getAvailability) return null;      // unknown, not absent
  try { return await navigator.bluetooth.getAvailability(); } catch (e) { return null; }
}

/**
 * Everything wrong with this machine, worst first, each with its own fix.
 * An empty list is the normal case and the app says nothing at all about it.
 */
export async function checkSetup(app) {
  const c = app.caps;
  const problems = [];

  /* ---- the page itself ---- */
  if (!c.secure) {
    problems.push({
      id: 'insecure',
      title: 'This page is not on a secure origin',
      body: 'Bluetooth is refused outright on a plain-http page that is not localhost. ' +
            'Nothing installed on this machine can change that — the address has to change.',
      commands: [],
      hint: 'Open the https address, or run the local app and use the address it prints.',
    });
  }

  /* ---- bluetooth ---- */
  if (!c.bluetooth && c.secure) {
    problems.push({
      id: 'no-web-bluetooth',
      title: 'This browser cannot reach Bluetooth',
      body: c.advice,
      commands: c.linux && c.chromium
        ? ['# Chromium on Linux needs BlueZ running and the feature enabled',
           'systemctl --no-pager is-active bluetooth || sudo systemctl enable --now bluetooth',
           "grep -qs -- '--enable-features=.*WebBluetooth' ~/.config/chromium-flags.conf ||",
           "  echo '--enable-features=WebBluetooth' >> ~/.config/chromium-flags.conf"]
        : [],
      hint: c.linux ? 'Quit Chromium completely afterwards — flags are read once, at launch.' : '',
    });
  } else if (c.bluetooth) {
    const radio = await bluetoothAvailable();
    if (radio === false) {
      problems.push({
        id: 'no-radio',
        title: 'Bluetooth is switched off, or this machine has no adapter',
        body: 'The browser can speak Bluetooth; the machine is not offering a radio to ' +
              'speak it with. Usually the adapter is soft-blocked or the service is stopped.',
        commands: c.linux
          ? ['rfkill unblock bluetooth', 'sudo systemctl enable --now bluetooth', 'bluetoothctl show']
          : [],
        hint: 'Switch Bluetooth on in system settings, then reload this page.',
      });
    }
  }

  /* ---- voice ---- */
  const heard = await voicesSettled(app.voice);
  if (!heard) {
    const linuxChromium = c.linux && c.chromium;
    problems.push({
      id: 'no-voices',
      title: 'This browser reports no speech voices',
      body: linuxChromium
        ? 'On Linux a browser speaks through speech-dispatcher, and Chrome and Chromium ' +
          'keep that behind a launch flag that is off by default — so the packages can be ' +
          'installed and working while the browser still reports nothing. Both halves are ' +
          'needed: the packages, and the flag.'
        : 'Lap times still appear on screen; they just will not be spoken. ' +
          (c.iOS ? 'On iOS, check the device is not in silent mode and that a voice is ' +
                   'installed under Accessibility → Spoken Content.'
                 : 'Install a system text-to-speech voice, then reload.'),
      commands: linuxChromium
        ? [PKGS[0][1] + '        # ' + PKGS[0][0],
           PKGS[1][1] + '     # ' + PKGS[1][0],
           PKGS[2][1] + '  # ' + PKGS[2][0],
           '',
           "grep -qs -- '--enable-speech-dispatcher' ~/.config/chromium-flags.conf ||",
           "  echo '--enable-speech-dispatcher' >> ~/.config/chromium-flags.conf"]
        : [],
      hint: linuxChromium
        ? 'Run the line for your distribution, then quit Chromium completely and reopen it. ' +
          'scripts/whooptimer-doctor in the repo does all of this and checks it worked.'
        : '',
      doctor: linuxChromium,
    });
  }

  return { ok: !problems.length, problems, checkedAt: Date.now() };
}

export const DOCTOR_URL = DOCTOR;
