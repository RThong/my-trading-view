import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { runPlugin } from './runPlugin';

const PLUGIN = resolve(import.meta.dir, 'no-loop.grit');

const REPORTED = [
  { name: '下标 for', input: 'for (let i = 0; i < 3; i++) {\n  f(i);\n}' },
  { name: 'for...of', input: 'for (const x of xs) {\n  f(x);\n}' },
  { name: 'for...in', input: 'for (const k in o) {\n  f(k);\n}' },
  { name: 'while(换成 while 绕不过去)', input: 'while (ok()) {\n  f();\n}' },
  { name: 'do...while', input: 'do {\n  f();\n} while (ok());' },
  { name: '带 break 照样报(改 find / some)', input: 'for (const x of xs) {\n  if (x) break;\n}' },
  { name: '嵌套循环只报最外层一次', input: 'for (const x of xs) {\n  while (ok(x)) {\n    f();\n  }\n}' },
];

const ALLOWED = [
  {
    name: '循环体里 await(顺序请求)',
    input: 'async function g() {\n  for (const u of us) {\n    await get(u);\n  }\n}',
  },
  { name: 'for await', input: 'async function g() {\n  for await (const r of rs) {\n    f(r);\n  }\n}' },
  {
    name: 'while 里 await(分页)',
    input: 'async function g() {\n  while (next) {\n    next = await page(next);\n  }\n}',
  },
  { name: '数组方法', input: 'xs.map((x) => x * 2).filter(Boolean);' },
  { name: '有理由的忽略注释', input: '// biome-ignore lint/plugin: 状态机,需多变量累积\nwhile (ok()) {\n  f();\n}' },
  {
    name: '忽略注释管住整段嵌套',
    input: '// biome-ignore lint/plugin: 双指针\nfor (const x of xs) {\n  while (ok(x)) j++;\n}',
  },
];

const ALL = [...REPORTED, ...ALLOWED];
const results = new Map(
  runPlugin(
    PLUGIN,
    ALL.map((c) => c.input),
  ).map((r, i) => [ALL[i].name, r]),
);

describe('报错', () => {
  test.each(REPORTED)('$name', (c) => {
    expect(results.get(c.name)?.messages).toEqual([expect.stringContaining('业务代码不用循环')]);
  });
});

describe('放行', () => {
  test.each(ALLOWED)('$name', (c) => {
    expect(results.get(c.name)?.messages).toEqual([]);
  });
});
