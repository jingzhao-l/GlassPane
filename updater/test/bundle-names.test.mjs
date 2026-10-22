/**
 * bundle-names.test.mjs — the updater's bundle table must name what the packaging script builds.
 *
 * WHY THIS EXISTS. `DEFAULT_BUNDLES` claims, in its own words, to list the bundles "with the
 * executables inside them", and it spelled the panel's executable `GlassPane Settings` while
 * `engine/scripts/make-app.sh` installs `glasspane-settings` (and `installer/cli.js`'s
 * `PANEL_EXE_NAME`, which is the name the installer greps for in `ps`, agrees with the script).
 * Nothing reads `.executable` today, so the wrong half of that claim could have lived here
 * forever — and the first check that ever asks "is the executable inside this bundle present?"
 * would look for a file that has never existed on any machine, and report a healthy install as
 * broken. A hand-copied second answer about the same artifact is the drift this repository keeps
 * writing up; this gate reads the name out of the script that assembles the bundle.
 *
 * REVERSE: rename the executable in one place only (apply.js's table, or make-app.sh's
 * `make_bundle` argument) → `the two sides name different executables` goes red.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { DEFAULT_BUNDLES } from '../lib/apply.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const MAKE_APP = 'engine/scripts/make-app.sh';

/**
 * Fold a POSIX shell continuation (`\` at end of line) so one `make_bundle` call is one line,
 * then read its positional arguments in order: the bundle directory, the display name, the
 * bundle identifier, the executable name, the binary it copies, and the LSUIElement flag.
 */
function makeBundleCalls(script) {
  const folded = script.replace(/\\\r?\n\s*/g, ' ');
  const calls = [];
  for (const match of folded.matchAll(/make_bundle((?:[^\n]|\r\n)+)/g)) {
    const args = [...match[1].matchAll(/"([^"]*)"/g)].map((group) => group[1]);
    if (args.length < 4) continue;
    calls.push({ bundle: path.basename(args[0]), executable: args[3] });
  }
  return calls;
}

test('the packaging script is readable and still assembles both bundles', () => {
  const script = fs.readFileSync(path.join(repoRoot, MAKE_APP), 'utf8');
  const calls = makeBundleCalls(script);
  assert.ok(calls.length >= 2,
    `${MAKE_APP} yielded ${calls.length} make_bundle call(s); a parser that finds no calls makes `
    + 'this gate vacuously green, which is the failure shape this repository already had with a '
    + 'lint script that self-ran on import');
  for (const bundle of ['GlassPane.app', 'GlassPane Daemon.app']) {
    assert.ok(calls.some((call) => call.bundle === bundle),
      `${MAKE_APP} no longer assembles ${bundle}; the updater\'s table and the build have parted ways`);
  }
});

test('the updater\'s table names the executables the script installs, per bundle', () => {
  const script = fs.readFileSync(path.join(repoRoot, MAKE_APP), 'utf8');
  const built = new Map(makeBundleCalls(script).map((call) => [call.bundle, call.executable]));
  for (const entry of DEFAULT_BUNDLES) {
    const installed = built.get(entry.name);
    assert.ok(installed !== undefined,
      `DEFAULT_BUNDLES lists ${entry.name}, which ${MAKE_APP} does not build — a bundle the updater `
      + 'swaps in and backs up but nothing produces');
    const named = path.basename(entry.executable);
    assert.equal(named, installed,
      `the two sides name different executables for ${entry.name}: ${MAKE_APP} installs `
      + `"${installed}" into Contents/MacOS/, the updater's table says "${named}"`);
  }
  for (const [bundle, installed] of built) {
    const listed = DEFAULT_BUNDLES.find((entry) => entry.name === bundle);
    assert.ok(listed !== undefined,
      `${MAKE_APP} builds ${bundle} (executable "${installed}") and the updater lists no such bundle `
      + '— the swap would leave that bundle out of the backup and the rollback');
  }
});

test('the executable path in the table is the bundle-relative path a swap would check', () => {
  for (const entry of DEFAULT_BUNDLES) {
    assert.ok(entry.name.endsWith('.app'), `${entry.name} is not a bundle directory name`);
    assert.deepEqual(entry.executable.split(path.sep), ['Contents', 'MacOS', path.basename(entry.executable)],
      `${entry.name}: the executable must be named as a path inside the bundle, not as a bare name`);
  }
});
