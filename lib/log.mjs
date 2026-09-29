/**
 * 日志
 * ============================================================
 * 规矩：
 *   1. 每个动作都要留痕 —— 用户回头反馈问题时，这份日志就是唯一证据。
 *   2. 日志文件默认落在**用户当前目录**，名字固定 `dsh-tudian-log.txt`，
 *      方便用户"就在我跑命令的那个文件夹里"直接找到并贴给我。
 *   3. 日志里绝不能出现凭据。本工具不读凭据，但如果将来要读，
 *      记得先过滤（见 redact()）。
 */

import fs from 'node:fs';
import path from 'node:path';

/** 日志文件名（固定，方便用户找） */
export const LOG_FILENAME = 'dsh-tudian-log.txt';

/**
 * 时间戳：2026-09-30 14:26:30.123
 * @returns {string}
 */
export function stamp() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`
  );
}

/**
 * 把疑似敏感的东西打码。
 * 本工具目前不接触凭据，这个函数是为了**将来**：万一有人往里加读取配置的代码，
 * 不至于把 API key 写进日志里发出去。
 * @param {string} text
 * @returns {string}
 */
export function redact(text) {
  return String(text)
    .replace(/(sk-[A-Za-z0-9_-]{8})[A-Za-z0-9_-]+/g, '$1***')
    .replace(/((?:api[_-]?key|token|password|secret)\s*[:=]\s*)\S+/gi, '$1***');
}

/** 日志器 */
export class Logger {
  /**
   * @param {object} [opts]
   * @param {string} [opts.file] 日志文件路径
   * @param {boolean} [opts.echo] 是否同时打到终端
   */
  constructor(opts = {}) {
    this.file = opts.file || path.join(process.cwd(), LOG_FILENAME);
    this.echo = Boolean(opts.echo);
    this.lines = [];
    this.enabled = true;
    this._opened = false;
    this._bomChecked = false;

    this._writeLine('='.repeat(72));
    this._writeLine(`dsh-tudian 运行日志 · 开始于 ${stamp()}`);
    this._writeLine(`命令行：${process.argv.join(' ')}`);
    this._writeLine(`工作目录：${process.cwd()}`);
    this._writeLine(`Node：${process.version} · 平台：${process.platform} ${process.arch}`);
    this._writeLine('='.repeat(72));
  }

  /**
   * 真正落盘。
   *
   * 两个细节都是为"让用户能看懂这份日志"服务的：
   *
   * ① 第一次写的时候才建文件 —— 避免"跑到一半发现没权限，结果建了个空文件"。
   *
   * ② 新建的文件**第一个字符写 BOM**（\uFEFF）。
   *    日志本身是 UTF-8，现代记事本能认出来；
   *    但 Windows 上不少工具（包括 PowerShell 的 Get-Content）
   *    默认按系统代码页读（中文机器是 GBK），中文就全成了乱码 ——
   *    而这份日志恰恰是用户反馈问题时要贴出来的东西，乱码等于白给。
   *    （实测踩过：Get-Content 读出来是 "杩愯鏃ュ織" 这种。）
   *    只在文件为空时补 BOM，已存在的文件不动，免得 BOM 插到文件中间。
   *
   * @param {string} line
   */
  _writeLine(line) {
    this.lines.push(line);
    if (!this.enabled) return;
    try {
      let prefix = '';
      if (!this._bomChecked) {
        this._bomChecked = true;
        let size = 0;
        try {
          size = fs.statSync(this.file).size;
        } catch {
          size = 0; // 文件还不存在 ⇒ 这份是我们新建的
        }
        if (size === 0) prefix = '\uFEFF';
      }
      fs.appendFileSync(this.file, prefix + line + '\n', 'utf8');
      this._opened = true;
    } catch {
      // 日志写不进去**绝不能**让主流程崩 —— 工具的本职是修 DSH，
      // 不是写日志。降级成"只在内存里留着 + 终端打一句"。
      this.enabled = false;
    }
  }

  /**
   * 写一条日志
   * @param {string} message
   * @param {'info'|'ok'|'warn'|'error'|'step'|'raw'} [level]
   */
  log(message, level = 'info') {
    const tag = { info: 'INFO ', ok: 'OK   ', warn: 'WARN ', error: 'ERROR', step: 'STEP ', raw: '     ' }[level] || 'INFO ';
    const text = redact(String(message));
    for (const line of text.split(/\r?\n/)) {
      this._writeLine(`[${stamp()}] ${tag} ${line}`);
    }
    if (this.echo) process.stdout.write(`[${tag.trim()}] ${text}\n`);
  }

  /** 记一段命令执行的输出（用于事后追责：到底跑了什么、回了什么） */
  logExec(cmd, args, result) {
    this.log(`$ ${cmd} ${args.join(' ')}`, 'raw');
    if (result.stdout) this.log(`stdout: ${result.stdout}`, 'raw');
    if (result.stderr) this.log(`stderr: ${result.stderr}`, 'raw');
    this.log(
      `exit=${result.code}${result.timedOut ? ' (超时)' : ''}${result.error ? ` error=${result.error}` : ''}`,
      'raw',
    );
  }

  /** 收尾：写结束标记，并返回日志文件路径（供报告里告诉用户） */
  close(summary) {
    this._writeLine('-'.repeat(72));
    if (summary) this._writeLine(`结果：${summary}`);
    this._writeLine(`结束于 ${stamp()}`);
    return this.enabled ? this.file : null;
  }
}
