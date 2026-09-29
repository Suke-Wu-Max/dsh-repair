/**
 * 终端输出 + 用户交互
 * ============================================================
 * 设计原则（对着"使用者本人"的偏好来的）：
 *   1. **全中文**，每一步都说清"我在干什么"，不让用户猜。
 *   2. **等待必须有可见进度** —— 每一步开头就打印 `[3/7] 正在探测端口…`，
 *      而不是干等十几秒什么都不显示。
 *   3. **不啰嗦** —— 正常流程一行一步；细节（命令、原始输出）只在
 *      `--verbose` 时展开，或者直接进日志文件。
 *   4. **危险操作先问** —— 改配置文件、装包之前必须让用户点头，
 *      除非显式给了 `--yes`。
 *
 * 关于颜色：Windows 10 以后的终端都支持 ANSI 转义，但为了兼容
 * 老终端和"重定向到文件"的场景，这里做了三重降级判断。
 */

import readline from 'node:readline';

/* ── 颜色 ─────────────────────────────────────────────────── */

const CODES = {
  reset: '\u001b[0m',
  bold: '\u001b[1m',
  dim: '\u001b[2m',
  red: '\u001b[31m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  blue: '\u001b[34m',
  magenta: '\u001b[35m',
  cyan: '\u001b[36m',
  gray: '\u001b[90m',
};

/**
 * 判断该不该上色。三者任一成立就关闭：
 *   ① 调用方显式给了 --no-color
 *   ② 环境变量设了 NO_COLOR（业界通行约定）
 *   ③ 输出不是终端（比如被重定向到文件、或被别的程序读走）
 * @param {boolean} [forceOff]
 * @returns {boolean}
 */
function shouldUseColor(forceOff) {
  if (forceOff) return false;
  if (process.env.NO_COLOR) return false;
  if (process.env.TERM === 'dumb') return false;
  return Boolean(process.stdout.isTTY);
}

/* ── UI 主体 ──────────────────────────────────────────────── */

export class UI {
  /**
   * @param {object} [opts]
   * @param {boolean} [opts.noColor] 关掉颜色
   * @param {boolean} [opts.verbose] 展开细节
   * @param {boolean} [opts.yes]     所有确认自动答"是"
   * @param {boolean} [opts.quiet]   只打结果，不打过程
   */
  constructor(opts = {}) {
    this.color = shouldUseColor(opts.noColor);
    this.verbose = Boolean(opts.verbose);
    this.yes = Boolean(opts.yes);
    this.quiet = Boolean(opts.quiet);
    this._rl = null;
  }

  /**
   * 上色
   * @param {string} text
   * @param {...keyof typeof CODES} names
   * @returns {string}
   */
  paint(text, ...names) {
    if (!this.color) return String(text);
    return names.map((n) => CODES[n] || '').join('') + text + CODES.reset;
  }

  /** 直接输出一行（不经颜色处理） */
  write(text = '') {
    process.stdout.write(text + '\n');
  }

  /** 空行 */
  blank() {
    if (!this.quiet) this.write();
  }

  /**
   * 顶部标题
   * @param {string} title
   * @param {string} [subtitle]
   */
  banner(title, subtitle) {
    const line = '═'.repeat(60);
    this.write(this.paint(line, 'gray'));
    this.write(this.paint('  ' + title, 'bold', 'cyan'));
    if (subtitle) this.write(this.paint('  ' + subtitle, 'gray'));
    this.write(this.paint(line, 'gray'));
  }

  /**
   * 分节标题
   * @param {string} text
   */
  section(text) {
    this.blank();
    this.write(this.paint('▌ ' + text, 'bold', 'blue'));
  }

  /**
   * 步骤行 —— 这是"看得见的进度"的主要载体
   * @param {number} index 第几步（从 1 开始）
   * @param {number} total 共几步
   * @param {string} text  正在做什么
   */
  step(index, total, text) {
    if (this.quiet) return;
    this.write(`${this.paint(`[${index}/${total}]`, 'cyan')} ${text}`);
  }

  /** 成功一行 ✓ */
  ok(text) {
    this.write(`${this.paint('✓', 'green')} ${text}`);
  }

  /** 失败一行 ✗ */
  fail(text) {
    this.write(`${this.paint('✗', 'red')} ${text}`);
  }

  /** 警告一行 ! */
  warn(text) {
    this.write(`${this.paint('!', 'yellow')} ${text}`);
  }

  /** 提示一行 · */
  info(text) {
    this.write(`${this.paint('·', 'gray')} ${text}`);
  }

  /** 缩进细节（默认只在 --verbose 时显示） */
  detail(text, force = false) {
    if (!this.verbose && !force) return;
    for (const line of String(text).split(/\r?\n/)) {
      this.write(this.paint('    ' + line, 'gray'));
    }
  }

  /** 强调一行 */
  emphasize(text) {
    this.write(this.paint(text, 'bold', 'yellow'));
  }

  /**
   * 两列表格（左对齐名字、右边值）
   * @param {Array<[string, string]>} rows
   */
  kv(rows) {
    const width = rows.reduce((max, [k]) => Math.max(max, this._displayWidth(k)), 0);
    for (const [k, v] of rows) {
      const pad = ' '.repeat(Math.max(0, width - this._displayWidth(k)));
      this.write(`  ${this.paint(k, 'gray')}${pad}  ${v}`);
    }
  }

  /**
   * 算显示宽度（中文一个字占两格，直接 length 会对不齐）
   * @param {string} text
   * @returns {number}
   */
  _displayWidth(text) {
    let width = 0;
    for (const ch of String(text)) {
      const code = ch.codePointAt(0);
      // 中日韩文字、全角标点算两格
      width += code >= 0x1100 && (
        code <= 0x115f ||
        (code >= 0x2e80 && code <= 0xa4cf) ||
        (code >= 0xac00 && code <= 0xd7a3) ||
        (code >= 0xf900 && code <= 0xfaff) ||
        (code >= 0xfe30 && code <= 0xfe6f) ||
        (code >= 0xff00 && code <= 0xff60) ||
        (code >= 0xffe0 && code <= 0xffe6)
      ) ? 2 : 1;
    }
    return width;
  }

  /**
   * 关键操作前的确认。
   *
   * 三种情况的处理（很重要，别改）：
   *   · 给了 --yes            → 直接返回 true，不问
   *   · 有终端可以交互        → 真的问，等用户敲 y/n
   *   · 没有终端（管道/CI）   → **返回 false**（安全默认：不擅自改东西），
   *                             并提示用户加 --yes
   *
   * @param {string} question 问什么
   * @param {object} [opts]
   * @param {boolean} [opts.defaultYes] 用户直接回车时的默认（默认 false）
   * @returns {Promise<boolean>}
   */
  async confirm(question, opts = {}) {
    if (this.yes) {
      this.write(`${this.paint('?', 'magenta')} ${question} ${this.paint('(已用 --yes 自动确认)', 'gray')}`);
      return true;
    }

    // 没有交互终端：不能瞎猜用户的意思
    if (!process.stdin.isTTY) {
      this.warn(`${question} —— 当前不是交互终端，已跳过（如需自动执行请加 --yes）`);
      return false;
    }

    const hint = opts.defaultYes ? '[Y/n]' : '[y/N]';
    this._rl = this._rl || readline.createInterface({ input: process.stdin, output: process.stdout });

    const answer = await new Promise((resolve) => {
      this._rl.question(`${this.paint('?', 'magenta')} ${question} ${hint} `, resolve);
    });

    const text = String(answer || '').trim().toLowerCase();
    if (text === '') return Boolean(opts.defaultYes);
    return text === 'y' || text === 'yes' || text === '是';
  }

  /** 收掉 readline，别让进程挂着不退出 */
  close() {
    if (this._rl) {
      this._rl.close();
      this._rl = null;
    }
  }
}

/**
 * 造一个 UI（快捷方式）
 * @param {object} [opts]
 * @returns {UI}
 */
export function createUI(opts = {}) {
  return new UI(opts);
}
