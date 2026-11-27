// Checks the CCITT code tables in src/engine/g4.ts against libtiff's t4.h, an independent
// transcription of ITU-T T.4 tables 2 and 3. Dev only.
//
//   node scripts/check-g4-tables.mjs [path/to/t4.h]   (downloads libtiff's t4.h if no path)

import { readFileSync } from 'node:fs';
import * as g4 from '../src/engine/g4.ts';

const T4_URL = 'https://gitlab.com/libtiff/libtiff/-/raw/master/libtiff/t4.h';
const source = process.argv[2] ? readFileSync(process.argv[2], 'utf8') : await (await fetch(T4_URL)).text();

/** Entries of a libtiff table: { length, code, run }, skipping special codes such as EOL. */
function libtiffTable(name) {
  const body = source.split(`${name}[] = {`)[1].split('};')[0];
  return [...body.matchAll(/\{\s*(\d+),\s*(0x[0-9a-fA-F]+|\d+),\s*(-?\d+)\s*\}/g)]
    .map(([, length, code, run]) => ({ bits: Number(code).toString(2).padStart(Number(length), '0'), run: Number(run) }))
    .filter(({ run }) => run >= 0);
}

/** Our codes for one colour, keyed by run length. */
function ourTable(terminating, makeup) {
  const table = new Map();
  terminating.forEach((bits, run) => table.set(run, bits));
  makeup.forEach((bits, i) => table.set((i + 1) * 64, bits));
  g4.EXTENDED_MAKEUP.forEach((bits, i) => table.set(1792 + i * 64, bits));
  return table;
}

let failures = 0;
for (const [colour, name, ours] of [
  ['white', 'TIFFFaxWhiteCodes', ourTable(g4.WHITE_TERMINATING, g4.WHITE_MAKEUP)],
  ['black', 'TIFFFaxBlackCodes', ourTable(g4.BLACK_TERMINATING, g4.BLACK_MAKEUP)],
]) {
  const theirs = libtiffTable(name);
  const checked = new Set();
  for (const { bits, run } of theirs) {
    checked.add(run);
    if (ours.get(run) !== bits) {
      failures++;
      console.log(`${colour} run ${run}: ours ${ours.get(run)}, libtiff ${bits}`);
    }
  }
  const unchecked = [...ours.keys()].filter((run) => !checked.has(run));
  if (unchecked.length) {
    failures++;
    console.log(`${colour}: runs not in libtiff's table: ${unchecked.join(', ')}`);
  }
  console.log(`${colour}: compared ${theirs.length} codes`);
}
console.log(failures ? `${failures} mismatch(es)` : 'All codes match libtiff.');
process.exit(failures ? 1 : 0);
