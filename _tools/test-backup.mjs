/**
 * 备份/恢复逻辑的独立测试
 * ============================================================
 * 为什么单独写这个：备份是整套安全承诺的**地基** ——
 * "改文件前先备份"这句话只有在备份真的能用、且重复跑不会堆一屋子文件时才成立。
 * 但这条逻辑很难在真实 DSH 上验证（不能拿用户的真配置做实验），
 * 所以这里用一个自己的临时目录来验证。
 *
 * 🔴 这个脚本只碰 <项目>/_tools/_tmp/ 里的东西，**不碰任何真实 DSH 文件**。
 *
 * 跑法：node _tools/test-backup.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Repairer } from '../lib/repair.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = path.join(here, '_tmp');

let passed = 0;
let failed = 0;

/**
 * 断言
 * @param {string} name
 * @param {boolean} condition
 * @param {string} [detail]
 */
function check(name, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}${detail ? `  ← ${detail}` : ''}`);
  }
}

/* ── 准备一个干净的沙盒目录 ── */
fs.rmSync(tmp, { recursive: true, force: true });
fs.mkdirSync(tmp, { recursive: true });

const sample = path.join(tmp, 'cordis.patch.yml');

/** 造一个最小可用的 ctx（ui 给 null，Repairer 里已经处理了这种情况） */
function makeRepairer() {
  return new Repairer({
    env: {
      profile: { dir: tmp, patchFile: sample, backups: [] },
      ports: { candidates: [3080], preferredPort: 3080 },
      npm: {},
      install: {},
    },
    ui: null,
    log: { log() {}, logExec() {} },
    home: tmp,
    bootLog: path.join(tmp, 'boot.txt'),
  });
}

console.log('\n备份 / 恢复 逻辑测试');
console.log('沙盒目录：' + tmp + '\n');

/* ── 用例 1：第一次备份 ── */
console.log('用例 1 · 第一次备份');
fs.writeFileSync(sample, '- insert:\n    - id: a\n      name: "x"\n', 'utf8');

const r1 = makeRepairer();
const first = r1.backup(sample);

check('备份成功', first.ok, first.error || '');
check('产生了备份文件', Boolean(first.backupFile) && fs.existsSync(first.backupFile || ''), first.backupFile || '');
check('备份文件名带 .bak- 前缀', path.basename(first.backupFile || '').startsWith('cordis.patch.yml.bak-'));
check('内容与原文件一致', fs.readFileSync(first.backupFile, 'utf8') === fs.readFileSync(sample, 'utf8'));

/* ── 用例 2：幂等 —— 内容没变，不该再产生一份 ── */
console.log('\n用例 2 · 幂等性（内容没变时重复备份）');
const r2 = makeRepairer();
const second = r2.backup(sample);

check('第二次返回成功', second.ok);
check('复用了已有备份（reused=true）', second.reused === true, `实际 reused=${second.reused}`);
check('没有新建备份文件', second.backupFile === first.backupFile, `新=${second.backupFile}`);

const backupsAfterTwo = fs.readdirSync(tmp).filter((f) => f.startsWith('cordis.patch.yml.bak'));
check('磁盘上只有 1 份备份', backupsAfterTwo.length === 1, `实际 ${backupsAfterTwo.length} 份：${backupsAfterTwo.join(', ')}`);

/* ── 用例 3：内容变了 → 应该产生新备份 ── */
console.log('\n用例 3 · 内容变化后必须另存一份');
fs.writeFileSync(sample, '- insert:\n    - id: b\n      name: "y"\n', 'utf8');

const r3 = makeRepairer();
const third = r3.backup(sample);

check('内容变了会新建备份', third.backupFile !== first.backupFile, `仍然是 ${third.backupFile}`);
const backupsAfterThree = fs.readdirSync(tmp).filter((f) => f.startsWith('cordis.patch.yml.bak'));
check('磁盘上变成 2 份备份', backupsAfterThree.length === 2, `实际 ${backupsAfterThree.length} 份`);

/* ── 用例 4：恢复 ── */
console.log('\n用例 4 · 从备份恢复');
const originalContent = fs.readFileSync(first.backupFile, 'utf8');
// 记下"恢复前"的状态 —— 下面要验证这个状态事后仍然找得回来
const contentBeforeRestore = fs.readFileSync(sample, 'utf8');

const r4 = makeRepairer();
const restored = r4.restore(sample, first.backupFile);

check('恢复操作成功', restored.ok, restored.error || '');
check('文件内容已还原', fs.readFileSync(sample, 'utf8') === originalContent);

// ⚠️ 这里要验的是**结果**，不是"一定新增了一个文件"：
//   如果"恢复前那个状态"已经有一份内容相同的备份，复用它是**正确**的（幂等设计）。
//   真正不能破的不变量是：**恢复前那个状态依然找得回来** —— 不然就回不去了。
const allBackups = fs.readdirSync(tmp).filter((f) => f.startsWith('cordis.patch.yml.bak'));
const canRollback = allBackups.some(
  (f) => fs.readFileSync(path.join(tmp, f), 'utf8') === contentBeforeRestore,
);
check('恢复前的状态仍然找得回来（能回退）', canRollback, `现有备份：${allBackups.join(', ')}`);

/* ── 用例 5：干跑绝不写盘 ── */
console.log('\n用例 5 · 干跑模式绝不写盘');
const before = fs.readdirSync(tmp).sort().join('|');
const contentBefore = fs.readFileSync(sample, 'utf8');

const dryRepairer = new Repairer({
  env: { profile: { dir: tmp, patchFile: sample, backups: [] }, ports: {}, npm: {}, install: {} },
  ui: null,
  log: { log() {}, logExec() {} },
  home: tmp,
  dryRun: true,
  bootLog: path.join(tmp, 'boot.txt'),
});

const dryResult = dryRepairer.restore(sample, first.backupFile);
const after = fs.readdirSync(tmp).sort().join('|');

check('干跑返回"成功"（表示计划可行）', dryResult.ok);
check('干跑没有新增任何文件', before === after, `前=${before} 后=${after}`);
check('干跑没有改动文件内容', fs.readFileSync(sample, 'utf8') === contentBefore);

/* ── 用例 6：备份一个不存在的文件 → 必须失败，不能假装成功 ── */
console.log('\n用例 6 · 备份不存在的文件应当明确失败');
const r6 = makeRepairer();
const missing = r6.backup(path.join(tmp, '根本不存在的文件.yml'));
check('返回 ok=false', missing.ok === false);
check('给出了原因', Boolean(missing.error));

/* ── 收尾 ── */
console.log(`\n${'─'.repeat(50)}`);
console.log(`通过 ${passed} 项，失败 ${failed} 项`);

// 清理沙盒（这是本测试自己造的东西，删掉不留垃圾）
fs.rmSync(tmp, { recursive: true, force: true });

process.exit(failed === 0 ? 0 : 1);
