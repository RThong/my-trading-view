// 插件测试的公共跑法:grit 没法单独调用,能测的最小单位就是「输入源码 → 真 biome → 输出源码 + 诊断」。
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const BIOME = resolve(import.meta.dir, '../node_modules/.bin/biome');

export interface PluginResult {
  /** check --write(插件 rewrite + 格式化)后的源码,去掉末尾换行 */
  output: string;
  /** 改写前 lint 报出的诊断文案 */
  messages: string[];
}

/** 只挂这一个插件、关掉内置规则跑一遍;结果与 inputs 一一对应。 */
export function runPlugin(plugin: string, inputs: string[]): PluginResult[] {
  const dir = mkdtempSync(join(tmpdir(), 'grit-'));
  const fileOf = (i: number) => `case${i}.ts`;

  try {
    writeFileSync(
      join(dir, 'biome.json'),
      JSON.stringify({
        plugins: [plugin],
        linter: { rules: { preset: 'none' } },
        formatter: { indentStyle: 'space' },
      }),
    );
    inputs.forEach((input, i) => {
      writeFileSync(join(dir, fileOf(i)), `${input}\n`);
    });

    // 先收诊断(改写前),再一次跑完全部 case 的 --write;未修复的诊断会让退出码非 0,不看退出码
    const lint = Bun.spawnSync([BIOME, 'lint', '--reporter=json', `--config-path=${dir}`, '.'], { cwd: dir });
    const { diagnostics } = JSON.parse(lint.stdout.toString()) as {
      diagnostics: { message: string; location: { path: string } }[];
    };
    Bun.spawnSync([BIOME, 'check', '--write', `--config-path=${dir}`, '.'], { cwd: dir });

    return inputs.map((_, i) => ({
      output: readFileSync(join(dir, fileOf(i)), 'utf8').trimEnd(),
      messages: diagnostics.filter((d) => d.location.path.endsWith(fileOf(i))).map((d) => d.message),
    }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
