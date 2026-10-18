// Independent check of a (possibly Droid-patched) workspace. Runs INSIDE the workspace copy, so it
// imports that copy's safety router and corpus. The Droid never grades its own work: autofix.ts
// trusts only this script, the typecheck and the test suite.
//
//   tsx droid/verify.ts <gaps.json>   -> prints one JSON line: { fixed, stillWrong, corpusFailures }

import fs from "node:fs";
import { routeInbound } from "../src/agent/safety.js";
import { SAFETY_CORPUS, type SafetyExpect } from "../src/agent/safety-corpus.js";

interface Gap {
  text: string;
  expect: SafetyExpect;
}

const route = (text: string): SafetyExpect => {
  const k = routeInbound(text).kind;
  return k === "withdrawal_warning" ? "none" : k;
};

const gaps = JSON.parse(fs.readFileSync(process.argv[2], "utf8")) as Gap[];
const fixed = gaps.filter((g) => route(g.text) === g.expect).map((g) => g.text);
const stillWrong = gaps.filter((g) => route(g.text) !== g.expect).map((g) => ({ text: g.text, expect: g.expect, got: route(g.text) }));
const corpusFailures = SAFETY_CORPUS.filter((e) => route(e.text) !== e.expect).map((e) => ({ text: e.text, expect: e.expect, got: route(e.text) }));
const corpusHasGaps = gaps.every((g) => SAFETY_CORPUS.some((e) => e.text === g.text && e.expect === g.expect));

console.log(JSON.stringify({ fixed, stillWrong, corpusFailures, corpusHasGaps, corpusSize: SAFETY_CORPUS.length }));
