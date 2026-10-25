// 依赖告警的形状闸（2026-10-24 每日轮）。
//
// GHSA-mrhx-c7xc-m3w5（`npm audit` 报 zod <4.6.6 high，`iterate-kernel` 经 zod 承一条）的触发前提是
// **一份无上界的数组 schema 收到一个大数组**。本版不升 zod 4（`iterate-kernel@0.1.9` 的 .d.ts 是
// zod 3 形状，升它是一次跨仓契约升级，不是为了这条告警），所以"本产品够不着这条告警"必须由判据
// 说话，而不是由我这一轮的读数说话：下面两条闸把"每个数组都有上界"钉成持续量，任何一条将来变红，
// 就是有人往对外面上加了一个无上界数组——那时这条告警在这个产品上重新成立，必须先加上界或换实现。
//
// 变异（本轮实跑过，见每日记录）：往 `mcp-shell/src/tools.ts` 里加一条 `z.array(z.string())`
// （无 `.max`）→ 第一条具名变红；把 `kernel/schemas/evidence-pack.schema.json` 某处的
// `maxItems` 删掉 → 第二条具名变红。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const SHELL_SRC = path.join(repoRoot, 'mcp-shell', 'src');
const KERNEL_SCHEMAS = path.join(repoRoot, 'kernel', 'schemas');

/** 分支键只收窄成员形状，不重复声明长度——基键上的 maxItems 才是那条数组的界。 */
const BRANCH_KEYS = new Set(['allOf', 'anyOf', 'oneOf', 'if', 'then', 'else']);

function listFiles(dir, filter) {
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && filter(entry.name))
    .map((entry) => path.join(dir, entry.name))
    .sort();
}

test('every array schema the shipped shell validates carries an upper bound (GHSA-mrhx-c7xc-m3w5 precondition)', () => {
  const offenders = [];
  for (const file of listFiles(SHELL_SRC, (name) => name.endsWith('.ts'))) {
    const text = fs.readFileSync(file, 'utf8');
    const lines = text.split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (!line.includes('z.array(')) continue;
      // 一条 schema 表达式可能折行写，所以从命中行往下读到这条语句结束（`;`）为止。
      let statement = line;
      let cursor = index;
      while (!statement.includes(';') && cursor + 1 < lines.length) {
        cursor += 1;
        statement += `\n${lines[cursor]}`;
      }
      if (!/\.max\s*\(/.test(statement)) {
        offenders.push(`${path.relative(repoRoot, file)}:${index + 1}: ${line.trim()}`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `zod <4.6.6 exhausts memory on a large array validated against an array schema **without** a length `
      + `constraint (GHSA-mrhx-c7xc-m3w5). These ${offenders.length} schema(s) in mcp-shell/src have no .max():\n  `
      + offenders.join('\n  ')
      + '\nGive each one an upper bound (or refuse the collection at this surface) before shipping.',
  );
});

test('every array in the pinned kernel corpus declares maxItems outside branch overrides', () => {
  assert.ok(fs.existsSync(KERNEL_SCHEMAS), `no kernel corpus at ${KERNEL_SCHEMAS}`);
  const offenders = [];
  const walk = (node, at, file) => {
    if (Array.isArray(node)) {
      node.forEach((child, i) => walk(child, `${at}[${i}]`, file));
      return;
    }
    if (node === null || typeof node !== 'object') return;
    const isArraySchema = node.type === 'array' || node.items !== undefined || node.minItems !== undefined;
    if (isArraySchema && typeof node.maxItems !== 'number') {
      offenders.push(`${file} at ${at || '$'} — array without maxItems`);
    }
    for (const [key, value] of Object.entries(node)) {
      if (BRANCH_KEYS.has(key)) {
        // 进分支看一眼成员形状，但不拿它当"这条数组的界"。
        (Array.isArray(value) ? value : [value]).forEach((branch) => {
          if (branch && typeof branch === 'object') {
            for (const [branchKey, branchValue] of Object.entries(branch)) {
              if (branchKey === 'items' || branchKey === 'properties' || branchKey === 'contains') {
                walk(branchValue, `${at}/${key}(${branchKey})`, file);
              }
            }
          }
        });
        continue;
      }
      walk(value, at ? `${at}/${key}` : key, file);
    }
  };
  for (const file of listFiles(KERNEL_SCHEMAS, (name) => name.endsWith('.json'))) {
    walk(JSON.parse(fs.readFileSync(file, 'utf8')), '', path.relative(repoRoot, file));
  }
  assert.deepEqual(
    offenders,
    [],
    'a corpus array without maxItems is an unconstrained collection for every consumer that validates '
      + 'against the JSON Schema instead of the kernel: ' + offenders.join('; '),
  );
});
