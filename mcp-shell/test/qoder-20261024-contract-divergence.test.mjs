// 三方契约的"一处宽松、两处严格"清单（2026-10-24 每日轮）。
//
// 审出来的事实：`kernel/schemas/evidence-pack.schema.json` 的 `signals.assertion.expected`
// 是 `anyOf[string, boolean]` 且**没有** maxLength，而 daemon 收 `expectedMaxLength = 512`
// （`engine/Sources/GlassPaneEngine/ParamValidation.swift:11`）、壳对外广告的也是 512
// （`mcp-shell/src/tools.ts` 的 gp_assert_element inputSchema）。一份契约、两个判决。
//
// 语料是 `iterate-kernel` 的发布物：本仓不许手改 `kernel/schemas/**`，收紧它要走内核发版 +
// harness 那条 pin 链（`harness/` 本轮归另一条每日线）。所以本层能做且必须做的是**把差值变成
// 持续量**：下面这条闸把"语料松、执行层严"的字段集合钉成一份具名清单——多一条就红（新的
// "一份契约两个判决"），少一条也红（内核收紧了，台账必须跟着改），谁都不许靠人记忆。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const read = (relative) => fs.readFileSync(path.join(repoRoot, relative), 'utf8');

/** 语料里允许字符串、却没有 maxLength 的属性名。 */
function unboundedStringFields(schemaText) {
  const schema = JSON.parse(schemaText);
  const found = new Set();
  const walk = (node) => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node === null || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node)) {
      if ((key === 'properties' || key === 'additionalProperties') && value !== null && typeof value === 'object') {
        for (const [name, spec] of Object.entries(value)) {
          if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) continue;
          const arms = Array.isArray(spec.anyOf) ? spec.anyOf : [spec];
          const allowsString = spec.type === 'string'
            || arms.some((arm) => arm && typeof arm === 'object' && arm.type === 'string');
          const capped = typeof spec.maxLength === 'number'
            || arms.some((arm) => arm && typeof arm === 'object' && typeof arm.maxLength === 'number');
          if (allowsString && !capped) found.add(name);
        }
      }
      walk(value);
    }
  };
  walk(schema);
  return found;
}

/** 壳对外广告了 maxLength 的入参字段（广告形状是读者的合同，不是实现细节）。 */
function shellAdvertisedCaps(sourceText) {
  const caps = new Map();
  const pattern = /(\w+):\s*\{\s*oneOf:\s*\[\{\s*type:\s*"string",\s*maxLength:\s*(\d+)\s*\}/g;
  let match;
  while ((match = pattern.exec(sourceText)) !== null) {
    caps.set(match[1], Number(match[2]));
  }
  return caps;
}

// 台账上只有一条：`expected` 是 `gp_assert_element` 的**入参**，两个执行层都判 512，语料放行任意长。
// `actual` 不算——它不是入参，没有任何一侧广告过它，把它一起写进清单等于宣称有一个调用方会被
// 同一份契约的两端给出不同答案，而这里没人能提交它（本轮实测纠正审查泳道的笼统说法）。
const KNOWN_DIVERGENCE = ['expected'];

test('the corpus-vs-executor divergence set is exactly the named list', () => {
  const corpusUnbounded = unboundedStringFields(read('kernel/schemas/evidence-pack.schema.json'));
  const advertised = shellAdvertisedCaps(read('mcp-shell/src/tools.ts'));
  const diverging = [...corpusUnbounded].filter((name) => advertised.has(name)).sort();

  assert.deepEqual(
    diverging,
    KNOWN_DIVERGENCE,
    `被钉语料允许、而 daemon 与壳都判上限的入参集合变了：实得 ${JSON.stringify(diverging)}，`
      + `台账记的是 ${JSON.stringify(KNOWN_DIVERGENCE)}。多出来的一条是新的"一份契约两个判决"——`
      + '要么收紧语料（内核发布物，本仓不许手改），要么在执行层放行；少了一条说明内核已收紧，'
      + '那就把这份清单与本轮记录一起改过来，别让台账停在旧世界。',
  );
});

test('the daemon and the shell publish the same cap for every field on that list', () => {
  const paramValidation = read('engine/Sources/GlassPaneEngine/ParamValidation.swift');
  const daemonCap = paramValidation.match(/static let expectedMaxLength = (\d+)/);
  assert.ok(daemonCap, '读不到 daemon 的 expectedMaxLength——这条闸就没测任何东西');
  const advertised = shellAdvertisedCaps(read('mcp-shell/src/tools.ts'));
  for (const name of KNOWN_DIVERGENCE) {
    assert.ok(advertised.has(name), `壳没有为 '${name}' 广告 maxLength：这一侧的上限没人发布过`);
    assert.equal(advertised.get(name), Number(daemonCap[1]),
      `'${name}' 的上限两侧不同：daemon ${daemonCap[1]}，壳广告 ${advertised.get(name)}`);
  }
});

test('a field the shell never advertised is not counted as an input contract', () => {
  const advertised = shellAdvertisedCaps(read('mcp-shell/src/tools.ts'));
  assert.equal(advertised.has('actual'), false, 'actual 一旦成为入参，上面那份清单必须重算');
});

test('the divergence this ledger records is measured on today\'s corpus, not asserted from memory', () => {
  // 上面几条读的是**当下**的字节；这一条再钉一层：台账说 `expected` 在语料里无上限，今天的语料
  // 就得真是无上限。内核哪天收紧，这一条与第一条各自变红——两种红都要求改这份记录，而不是让它
  // 替一个已经不存在的世界说话。
  const corpusUnbounded = unboundedStringFields(read('kernel/schemas/evidence-pack.schema.json'));
  for (const name of KNOWN_DIVERGENCE) {
    assert.ok(corpusUnbounded.has(name),
      `台账记着 '${name}' 在语料里无上限，而今天的语料不这么答——这份记录过期了，删掉它那一行`);
  }
  assert.ok(fs.existsSync(path.join(repoRoot, 'kernel', 'schemas', 'evidence-pack.schema.json')),
    '对照闸读的必须是真语料文件，不是内置副本');
});
