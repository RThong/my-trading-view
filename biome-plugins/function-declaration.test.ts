import { beforeAll, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { runPlugin } from './runPlugin';

const PLUGIN = resolve(import.meta.dir, 'function-declaration.grit');

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

const ALL = [...CONVERTED, ...UNCHANGED, ...MANUAL];
// 两次 biome 进程放进 beforeAll:跑失败时落在具体的测试钩子上报错,而不是整个文件 import 即崩、看不出是谁
let results: Map<string, ReturnType<typeof runPlugin>[number]>;
beforeAll(() => {
  results = new Map(
    runPlugin(
      PLUGIN,
      ALL.map((c) => c.input),
    ).map((r, i) => [ALL[i].name, r]),
  );
});

// 未改动的 case 也会被 biome 格式化,故 input 都按格式化后的样子写
describe('改写成 function 声明', () => {
  test.each(CONVERTED)('$name', (c) => {
    expect(results.get(c.name)?.output).toBe(c.expected!);
    expect(results.get(c.name)?.messages).toEqual([expect.stringContaining('可自动修复')]);
  });
});

describe('不该改动、也不报', () => {
  test.each(UNCHANGED)('$name', (c) => {
    expect(results.get(c.name)?.output).toBe(c.input);
    expect(results.get(c.name)?.messages).toEqual([]);
  });
});

// 防「匹配静默失败」冒充「识别出注释」:必须真的报了请手改
describe('有注释:只报不改', () => {
  test.each(MANUAL)('$name', (c) => {
    expect(results.get(c.name)?.output).toBe(c.input);
    expect(results.get(c.name)?.messages).toEqual([expect.stringContaining('请手改')]);
  });
});
