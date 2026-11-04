import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// 端到端:用真 biome 跑插件的 rewrite,再格式化成项目同款缩进,比对输出。
// grit 没法单独调用,能测的最小单位就是「输入源码 → biome check --write → 输出源码」。
const PLUGIN = resolve(import.meta.dir, 'function-declaration.grit');
const BIOME = resolve(import.meta.dir, '../node_modules/.bin/biome');

// expected 省略 = 不该改动
interface Case {
  name: string;
  input: string;
  expected?: string;
}

const CONVERTED: Case[] = [
  {
    name: '表达式体补 return',
    input: 'const a = (x: number) => x + 1;',
    expected: 'function a(x: number) {\n  return x + 1;\n}',
  },
  {
    name: '块体原样搬',
    input: 'export const b = (x: string) => {\n  return x.length;\n};',
    expected: 'export function b(x: string) {\n  return x.length;\n}',
  },
  {
    name: 'async + 泛型 + 返回类型',
    input: 'const c = async <T,>(x: T): Promise<T> => x;',
    expected: 'async function c<T>(x: T): Promise<T> {\n  return x;\n}',
  },
  {
    name: '对象字面量体',
    input: 'const d = (x: number) => ({ a: x });',
    expected: 'function d(x: number) {\n  return { a: x };\n}',
  },
  {
    name: '括号体里的注释保留',
    input: 'const o = (x: number) => (/* 说明 */ { a: x });',
    expected: 'function o(x: number) {\n  return /* 说明 */ { a: x };\n}',
  },
  {
    name: '单参数无括号',
    input: 'const e = x => x;',
    expected: 'function e(x) {\n  return x;\n}',
  },
  {
    name: 'async 单参数无括号',
    input: 'const f = async x => x;',
    expected: 'async function f(x) {\n  return x;\n}',
  },
  {
    name: '参数名以 async 开头 ≠ async 函数',
    input: 'const g = asyncResult => asyncResult + 1;',
    expected: 'function g(asyncResult) {\n  return asyncResult + 1;\n}',
  },
  {
    name: '块体内注释保留',
    input: '/** 文档 */\nconst h = (x: number) => {\n  // 为什么\n  return x; // 尾注释\n};',
    expected: '/** 文档 */\nfunction h(x: number) {\n  // 为什么\n  return x; // 尾注释\n}',
  },
  {
    name: '参数里的注释保留',
    input: 'const i = (\n  x: number, // 说明 x\n) => x;',
    expected: 'function i(\n  x: number, // 说明 x\n) {\n  return x;\n}',
  },
  {
    name: '表达式体里的字符串含 // 不算注释',
    input: 'const j = () => "https://a.b";',
    expected: 'function j() {\n  return "https://a.b";\n}',
  },
];

const UNCHANGED: Case[] = [
  { name: '类型注解的变量(声明挂不上函数类型)', input: 'const a: (x: number) => number = (x) => x;' },
  { name: 'let', input: 'let b = () => 1;' },
  { name: '多个声明符(整句替换会丢 c2)', input: 'const c = () => 1,\n  c2 = 2;' },
  { name: '用 this', input: 'const d = () => this;' },
  { name: '用 arguments', input: 'const e = () => arguments.length;' },
  { name: '函数体内的局部箭头', input: 'function outer() {\n  const h = (z: number) => z;\n  return h(1);\n}' },
  { name: '顶层代码块里(块级函数声明作用域不同)', input: 'if (true) {\n  const i = () => 1;\n}' },
  { name: 'switch 分支里', input: 'switch (1) {\n  case 1:\n    const j = () => 1;\n}' },
  { name: '回调', input: '[1].map((n) => n);' },
  { name: 'class 成员', input: 'class K {\n  static s = () => 1;\n}' },
  { name: '包了一层调用', input: 'export const Memo = wrap(() => 1);' },
  { name: 'function 表达式', input: 'const k = function (y: number) {\n  return y;\n};' },
];

// 这几处的注释 rewrite 搬不过去:报错但不自动改,留给人手改
const MANUAL: Case[] = [
  { name: '= 与箭头之间的注释', input: 'const l = /* 说明 */ (x: number) => x;' },
  { name: '=> 与表达式体之间的注释', input: 'const m = (x: number) =>\n  // 为什么\n  x + 1;' },
  { name: '=> 之前的注释', input: 'const n = (x: number) /* 说明 */ => x;' },
];

let dir: string;
const output = new Map<string, string>();
const messages = new Map<string, string[]>();
const ALL = [...CONVERTED, ...UNCHANGED, ...MANUAL];

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'grit-fn-'));
  writeFileSync(
    join(dir, 'biome.json'),
    JSON.stringify({
      plugins: [PLUGIN],
      linter: { rules: { preset: 'none' } },
      formatter: { indentStyle: 'space' },
    }),
  );
  ALL.forEach((c, i) => {
    writeFileSync(join(dir, fileOf(i)), `${c.input}\n`);
  });

  // 先收诊断(改写前),再一次跑完全部 case 的 --write;未修复的诊断会让退出码非 0,不看退出码
  const lint = Bun.spawnSync([BIOME, 'lint', '--reporter=json', `--config-path=${dir}`, '.'], { cwd: dir });
  const { diagnostics } = JSON.parse(lint.stdout.toString()) as {
    diagnostics: { message: string; location: { path: string } }[];
  };
  Bun.spawnSync([BIOME, 'check', '--write', `--config-path=${dir}`, '.'], { cwd: dir });

  ALL.forEach((c, i) => {
    output.set(c.name, readFileSync(join(dir, fileOf(i)), 'utf8').trimEnd());
    messages.set(
      c.name,
      diagnostics.filter((d) => d.location.path.endsWith(fileOf(i))).map((d) => d.message),
    );
  });
});

function fileOf(i: number) {
  return `case${i}.ts`;
}

afterAll(() => rmSync(dir, { recursive: true, force: true }));

// 未改动的 case 也会被 biome 格式化,故 input 都按格式化后的样子写
describe('改写成 function 声明', () => {
  test.each(CONVERTED)('$name', (c) => {
    expect(output.get(c.name)).toBe(c.expected!);
    expect(messages.get(c.name)).toEqual([expect.stringContaining('可自动修复')]);
  });
});

describe('不该改动、也不报', () => {
  test.each(UNCHANGED)('$name', (c) => {
    expect(output.get(c.name)).toBe(c.input);
    expect(messages.get(c.name)).toEqual([]);
  });
});

// 防「匹配静默失败」冒充「识别出注释」:必须真的报了请手改
describe('有注释:只报不改', () => {
  test.each(MANUAL)('$name', (c) => {
    expect(output.get(c.name)).toBe(c.input);
    expect(messages.get(c.name)).toEqual([expect.stringContaining('请手改')]);
  });
});
