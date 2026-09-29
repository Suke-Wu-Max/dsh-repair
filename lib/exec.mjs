/**
 * 跨平台命令执行
 * ============================================================
 * 这是整个工具里"坑"最集中的一个文件。以下三条都是**实测踩出来的**，
 * 不是推测，改动前请先读完：
 *
 * 【坑 1】Windows 上 npm 有两个入口，其中一个是雷
 *   - `npm.cmd`  → 给 cmd.exe 用的批处理包装
 *   - `npm.ps1`  → 给 PowerShell 用的脚本包装
 *   如果用户的 PowerShell 执行策略是 Restricted（Windows 的默认值），
 *   调 `npm.ps1` 会**直接被系统拦掉**，报：
 *     "File ...npm.ps1 cannot be loaded because running scripts is disabled on this system"
 *   ⇒ 后果：明明装了 npm，工具却以为 npm 不可用，作出错误判断。
 *   ⇒ 对策：**一律显式走 `.cmd` 入口**，永远不碰 `.ps1`。
 *
 * 【坑 2】Windows 上不能直接 spawn 一个 .cmd 文件
 *   Node 会报 EINVAL / 或在新版本里出于安全（CVE-2024-27980）拒绝执行
 *   .cmd / .bat。必须经由 cmd.exe 转一手。
 *   ⇒ 对策：Windows 上用 `shell: true`，让 Node 自己拉起 cmd.exe。
 *
 * 【坑 3】shell: true 会带来参数拼接问题
 *   一旦参数里混进用户输入，就可能被 shell 当成命令注入。
 *   ⇒ 对策：本文件对外只暴露 `run()`，且调用方传进来的参数
 *     只允许来自本工具内部的常量，或经过校验的值（端口号 = 纯数字、
 *     registry 地址 = 白名单里的几个）。另外统一做一次引号包裹 + 转义。
 */

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** 是否 Windows */
export const IS_WIN = process.platform === 'win32';
/** 是否 macOS */
export const IS_MAC = process.platform === 'darwin';
/** 是否 Linux */
export const IS_LINUX = process.platform === 'linux';

/**
 * 把参数包成 shell 安全的形式。
 * 只做"最小必要"的处理：含空白或特殊字符时用双引号包住，并转义内部双引号。
 * @param {string} value 原始参数
 * @returns {string} 可安全放进命令行的字符串
 */
function quote(value) {
  const s = String(value);
  if (s === '') return '""';
  if (!/[\s"'&|<>^()%!$`\\]/.test(s)) return s;
  if (IS_WIN) {
    // cmd.exe 里双引号靠双写转义；% 会被当变量展开，所以要变成 %%
    return `"${s.replace(/"/g, '""').replace(/%/g, '%%')}"`;
  }
  // POSIX：单引号里除了单引号本身都安全
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * 拼出一条完整命令行（仅在 shell: true 时使用）
 * @param {string} cmd 命令名
 * @param {string[]} args 参数
 * @returns {string}
 */
function buildCommandLine(cmd, args) {
  return [cmd, ...args].map(quote).join(' ');
}

/**
 * 同步执行一条命令（带超时保护）
 *
 * ⚠️ 为什么用"同步"：本工具的流程是「探测 → 诊断 → 修复 → 验证」，
 * 每一步都要拿到上一步的结果才能决定下一步，天生是串行的。
 * 用同步写法能让流程读起来就是一条直线，出错时栈也清楚。
 * 唯一例外是"启动 DSH 服务"——那必须异步（见 startDetached）。
 *
 * @param {string} cmd  命令名（如 'npm.cmd' / 'node'）
 * @param {string[]} args 参数数组
 * @param {object} [opts]
 * @param {string} [opts.cwd]      工作目录
 * @param {number} [opts.timeout]  超时毫秒数，默认 60 秒
 * @param {object} [opts.env]      额外环境变量
 * @returns {{ok:boolean, code:number|null, stdout:string, stderr:string, error:string|null, timedOut:boolean}}
 */
export function run(cmd, args = [], opts = {}) {
  const timeout = typeof opts.timeout === 'number' ? opts.timeout : 60_000;
  const useShell = IS_WIN; // 见【坑 2】：Windows 必须走 shell

  const res = spawnSync(useShell ? buildCommandLine(cmd, args) : cmd, useShell ? [] : args, {
    cwd: opts.cwd || process.cwd(),
    timeout,
    shell: useShell,
    windowsHide: true, // 不要弹出黑框（用户看到的"黑框一闪"就是这么来的）
    encoding: 'utf8',
    env: { ...process.env, ...(opts.env || {}) },
    maxBuffer: 16 * 1024 * 1024,
  });

  const timedOut = res.error && res.error.code === 'ETIMEDOUT';
  const code = typeof res.status === 'number' ? res.status : null;

  return {
    ok: !res.error && code === 0,
    code,
    stdout: (res.stdout || '').trim(),
    stderr: (res.stderr || '').trim(),
    error: res.error ? String(res.error.message || res.error) : null,
    timedOut: Boolean(timedOut),
  };
}

/**
 * 找一条命令到底在哪儿（**不执行它**，只查文件）
 *
 * 🔴 这里刻意**不调 `where` / `which` 命令**，而是自己遍历 PATH 找文件。
 *   原因是实测踩到的：
 *     · 调 `where` 得先拉起一个 shell（cmd.exe / sh），而这**本身就可能失败**
 *       —— 受限环境、权限策略、沙箱里 spawn 会被直接拒掉（实测 EPERM）。
 *       一旦它失败，我们就会得出"系统里没有 npm"这种**把用户引向错误方向**的结论。
 *     · 纯文件系统查找不受这些限制：不 spawn 任何进程，也就没有"跑不起来"这一说。
 *   附带的两个好处：
 *     ① 更快（不起进程）
 *     ② Windows 上按 PATHEXT 顺序找，`.CMD` 天然排在 `.PS1` 前面
 *        ⇒ 彻底避开了【坑 1】里"npm.ps1 被执行策略拦掉"的问题。
 *
 * @param {string} name 命令名，如 'node' / 'npm' / 'dsh'（也可以带扩展名）
 * @returns {{found:boolean, path:string|null}}
 */
export function which(name) {
  const dirs = (process.env.PATH || '').split(IS_WIN ? ';' : ':').filter(Boolean);

  // 已经带了扩展名就别再拼（调用方可能直接传 'npm.cmd'）
  const hasExt = /\.[A-Za-z0-9]+$/.test(name);

  let exts;
  if (hasExt) {
    exts = [''];
  } else if (IS_WIN) {
    // PATHEXT 决定 Windows 认哪些可执行后缀，默认值里 .CMD 排在 .PS1 之前
    exts = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  } else {
    exts = [''];
  }

  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      try {
        // 用 statSync 而不是 existsSync：要确认它是个**文件**。
        // （PATH 里如果有个同名目录，existsSync 会误判成"找到了"。）
        if (fs.statSync(candidate).isFile()) return { found: true, path: candidate };
      } catch {
        // 这条路没这个文件，继续找下一个
      }
    }
  }

  return { found: false, path: null };
}

/**
 * 启动一个"长驻进程"并立刻撒手（用于拉起 DSH 服务）
 *
 * 与 run() 的区别：这里**不等待**、不收集输出，而是把子进程的输出
 * 重定向到文件，然后马上返回。因为 DSH 是个前台的常驻服务，
 * 等它"结束"就等于永远卡住。
 *
 * @param {string} cmd 命令名
 * @param {string[]} args 参数
 * @param {object} opts
 * @param {string} opts.cwd 工作目录
 * @param {import('node:fs').WriteStream} opts.stdout 输出流（日志文件）
 * @param {import('node:fs').WriteStream} opts.stderr 错误流（日志文件）
 * @returns {import('node:child_process').ChildProcess}
 */
export function startDetached(cmd, args, opts) {
  const useShell = IS_WIN;
  const child = spawn(useShell ? buildCommandLine(cmd, args) : cmd, useShell ? [] : args, {
    cwd: opts.cwd,
    detached: true, // 独立进程组：本工具退出后它继续活着
    shell: useShell,
    windowsHide: true,
    stdio: ['ignore', opts.stdout || 'ignore', opts.stderr || 'ignore'],
    env: { ...process.env, ...(opts.env || {}) },
  });
  child.unref(); // 不让父进程等它
  return child;
}
