/**
 * A gate must have someone who runs it, and a hand-off must name a receiver that exists.
 *
 * Two defects, both in this repo's own recorded defect family (2026-10-26: "闸把发现降级成
 * '交给该 root 自己的闸'时，必须先证明收件人存在且会跑，否则那是一条有纸面记录的无闸"):
 *
 *  1. `scripts/check-doc-links.mjs --self-test` exists and passes (8 cases, 5 mutations caught,
 *     3 legal shapes kept silent) but CI only ever ran the bare check. So any of doc-links' six
 *     rule classes — dead links, dead anchors, bilingual parity, the recomputable-claim check,
 *     table shape, the world-writable install landing — could be degraded to always-green and
 *     every gate would still print "clean". The battery was decoration.
 *  2. `scripts/check-workflows.mjs` printed `△ … reported to that root's own gate, not enforced
 *     from here` for the producer→first-match-consumer (141) rule and the publishing-`concurrency`
 *     rule. Measured 2026-10-30 against the file it was handing off to
 *     (`harness/glasspane-harness/script/check-workflows.mjs`, four declared rules: action pins,
 *     `timeout-minutes`, shell gates, the npm pin, plus the chained one-line case): **neither**
 *     rule lives there. Those two findings were therefore printed by nobody-blocking and
 *     "received" by nobody-reading. The sentence now says exactly that — and this file reddens if
 *     it starts promising a receiver again, in either direction: the shell-gate advisory, whose
 *     receiver DOES exist, keeps its wording.
 *
 * Everything here is spawned as a real child process against the real repo, not a re-read of the
 * source, because the claim under test is "this command answers this way on a machine".
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function run(args, cwd = REPO) {
  const res = spawnSync(process.execPath, args, { cwd, encoding: "utf8" });
  return { rc: res.status, out: `${res.stdout ?? ""}${res.stderr ?? ""}` };
}

test("CI runs the doc-links battery before the bare check — a passing self-test has a reader", () => {
  const ci = fs.readFileSync(path.join(REPO, ".github", "workflows", "ci.yml"), "utf8");
  const step = /- name: Check links, anchors and bilingual pairing[\s\S]*?\n\n/.exec(ci);
  assert.ok(step, "the docs step is no longer recognisable in ci.yml — re-read this control, do not delete it");
  const body = step[0];
  assert.match(body, /set -euo pipefail/, "a multi-statement run body without its own gate reports only the last command");
  assert.match(body, /node scripts\/check-doc-links\.mjs --self-test\n\s+node scripts\/check-doc-links\.mjs\n/,
    `the battery must run FIRST and the bare check after it, in one gated body: ${body}`);
});

test("the doc-links battery really answers: rc 0 and one printed line per declared case", () => {
  const { rc, out } = run(["scripts/check-doc-links.mjs", "--self-test"]);
  assert.equal(rc, 0, `--self-test failed:\n${out}`);
  const summary = /check-doc-links --self-test: (\d+) case\(s\) each verified to fail — (\d+) mutation\(s\) that had to be caught, (\d+) legal shape\(s\) that had to stay silent/.exec(out.trim());
  assert.ok(summary, `the contract line this file pins is gone from the output:\n${out}`);
  const declared = Number(summary[1]);
  const mutations = Number(summary[2]);
  const legal = Number(summary[3]);
  const printed = out.split("\n").filter((line) => line.includes("ok self-test:")).length;
  assert.equal(printed, declared, `the summary says ${declared} cases, ${printed} printed their verdicts — a case quietly dropped from the table cannot be counted`);
  assert.equal(mutations + legal, declared, "the two halves must add up to the whole table");
  assert.ok(mutations >= 1 && legal >= 1, `a battery with no mutation half or no counter-case half proves nothing: ${mutations}/${legal}`);
});

test("the workflow gate's no-receiver advisories say so, and do not promise a reader", () => {
  const { rc, out } = run(["scripts/check-workflows.mjs"]);
  assert.equal(rc, 0, `check-workflows failed:\n${out}`);
  const advisories = out.split("\n").filter((line) => line.trim().startsWith("△"));
  assert.ok(advisories.length > 0, "the subtree advisories disappeared — re-read this control rather than deleting it");
  const unguarded = advisories.filter((line) => /first-match-consumer|without a queue of their own/.test(line));
  assert.ok(unguarded.length > 0, `the 141 / concurrency hand-offs are not in the output — this control now reads nothing:\n${out}`);
  for (const line of unguarded) {
    assert.match(line, /blocked by nobody/,
      `一条移交声称"交给那棵树自己的闸"，而那棵树没有这两条判据（实测 harness/glasspane-harness/script/check-workflows.mjs 的四条规则）。这句话必须继续说实话：${line}`);
    assert.ok(!/reported to that root's own gate/.test(line),
      `the false receiver claim is back: ${line}`);
  }
  // And the one hand-off that DOES have a receiver keeps naming it — otherwise this test would
  // pass by deleting every advisory, which is the failure mode it is guarding against.
  const received = advisories.filter((line) => /declare no shell gate of their own/.test(line));
  assert.ok(received.length > 0 && received.every((line) => /that root's own gate/.test(line)),
    "the shell-gate advisory's receiver exists in that root's rule 3, so it must still name it");
});

test("the workflow gate's self-test counts every declared case, including the chained one-liner", () => {
  const { rc, out } = run(["scripts/check-workflows.mjs", "--self-test"]);
  assert.equal(rc, 0, `--self-test failed:\n${out}`);
  const summary = /check-workflows --self-test: (\d+) case\(s\) each verified to fail — (\d+) mutation\(s\) that had to be caught, (\d+) legal shape/.exec(out);
  assert.ok(summary, `contract line missing:\n${out}`);
  const printed = out.split("\n").filter((line) => line.includes("ok self-test:")).length;
  assert.equal(printed, Number(summary[1]), "the printed verdicts must equal the declared case count");
  assert.equal(Number(summary[2]) + Number(summary[3]), Number(summary[1]), "the two halves must add up to the whole table");
  assert.match(out, /chains statements[^\n]*is caught/,
    "the chained-one-liner rule (ported 2026-10-30) must be among the cases proven able to red");
});
