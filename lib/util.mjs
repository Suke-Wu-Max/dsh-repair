/**
 * 通用小工具
 * ============================================================
 * 只放"多个模块都要用、而且没什么副作用"的纯函数。
 * 🔴 不许在这里放任何会写盘、会执行命令的东西 —— 保持它 Pure。
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * 把版本号字符串解析成数字数组。
 * 'v22.19.0' / '22.19.0' / '22.19' → [22, 19, 0]
 *
 * ⚠️ 只处理纯数字版本号。遇到 '22.19.0-rc.1' 这种带预发布标记的，
 * 预发布部分会被丢掉（对"够不够新"这个判断来说足够了）。
 *
 * @param {string} text
 * @returns {number[]}
 */
export function parseVersion(text) {
  const cleaned = String(text || '').trim().replace(/^v/i, '');
  const main = cleaned.split(/[-+]/)[0];
  return main.split('.').map((part) => {
    const n = parseInt(part, 10);
    return Number.isFinite(n) ? n : 0;
  });
}

/**
 * 版本比较：current 是否 >= required
 *
 * 自己写而不用第三方 semver：本工具的一个硬要求就是"零依赖"——
 * 依赖越少，用户装的时候失败概率越低，这在"救火工具"上是决定性的。
 *
 * @param {string} current 当前版本
 * @param {string} required 要求的最低版本
 * @returns {boolean}
 */
export function versionGte(current, required) {
  const a = parseVersion(current);
  const b = parseVersion(required);
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i] || 0;
    const y = b[i] || 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return true; // 完全相等
}

/**
 * 生成备份用的时间戳后缀：20260930-142630
 * 跟 DSH 自己的备份命名风格保持一致（`xxx.bak-<时间戳>`），
 * 这样用户看到的名字是熟悉的，也方便跟 DSH 自己产生的备份混在一起排序。
 *
 * @returns {string}
 */
export function timestampSuffix() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

/**
 * 安全读 JSON —— 文件不存在、内容坏了都返回 null，不抛异常。
 * @param {string} file
 * @returns {any|null}
 */
export function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * 安全读文本 —— 读不到返回 null。
 * @param {string} file
 * @returns {string|null}
 */
export function readTextSafe(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/**
 * 文件是否存在（任何类型：文件 / 目录 / 链接都算）
 * @param {string} target
 * @returns {boolean}
 */
export function exists(target) {
  try {
    // 用 lstatSync 而不是 existsSync：
    // existsSync 对"断掉的符号链接/junction"会返回 **false**，
    // 而我们恰恰需要**发现**这种"链接还在、指向没了"的坏状态。
    fs.lstatSync(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * 判断是不是目录
 * @param {string} target
 * @returns {boolean}
 */
export function isDir(target) {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 判断是不是文件
 * @param {string} target
 * @returns {boolean}
 */
export function isFile(target) {
  try {
    return fs.statSync(target).isFile();
  } catch {
    return false;
  }
}

/**
 * 是一个"真链接"（symlink 或 Windows junction）吗
 *
 * ⚠️ 为什么单独判这个：DSH 的插件在 node_modules 里是靠
 * junction/symlink 指到 plugins/ 目录的。这个链接**断了**（目标没了）
 * 正是"插件加载失败"的经典成因之一，必须能单独识别出来。
 *
 * @param {string} target
 * @returns {{isLink:boolean, broken:boolean, linkTarget:string|null}}
 */
export function linkInfo(target) {
  try {
    const st = fs.lstatSync(target);
    if (!st.isSymbolicLink()) return { isLink: false, broken: false, linkTarget: null };

    let linkTarget = null;
    try {
      linkTarget = fs.readlinkSync(target);
    } catch {
      linkTarget = null;
    }

    // junction 的 readlink 有时拿不到真实路径，交给 realpath 兜底
    let broken = true;
    try {
      fs.statSync(target); // 顺着链接往里 stat，成功说明链接是通的
      broken = false;
    } catch {
      broken = true;
    }

    return { isLink: true, broken, linkTarget };
  } catch {
    return { isLink: false, broken: false, linkTarget: null };
  }
}

/**
 * 列目录（不存在就返回空数组，不抛异常）
 * @param {string} dir
 * @returns {string[]} 绝对路径列表
 */
export function listDir(dir) {
  try {
    return fs.readdirSync(dir).map((name) => path.join(dir, name));
  } catch {
    return [];
  }
}

/**
 * 把路径显示成"家目录用 ~ 代替"的短形式 —— 报告里更干净，也顺带
 * 避免把用户的真实用户名（包含中文/隐私）贴到公开的 issue 里。
 *
 * @param {string} target
 * @returns {string}
 */
export function shortenPath(target) {
  if (!target) return '';
  const home = process.env.HOME || process.env.USERPROFILE || '';
  if (home && target.startsWith(home)) {
    return '~' + target.slice(home.length);
  }
  return target;
}

/**
 * 人类可读的文件大小
 * @param {number} bytes
 * @returns {string}
 */
export function humanSize(bytes) {
  if (!Number.isFinite(bytes)) return '未知';
  const units = ['B', 'KB', 'MB', 'GB'];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/**
 * 生成"漂亮的树形缩进文本"（报告里列文件用）
 * @param {string} text
 * @param {number} indent
 * @returns {string}
 */
export function indent(text, indentSize = 2) {
  const pad = ' '.repeat(indentSize);
  return String(text)
    .split(/\r?\n/)
    .map((line) => pad + line)
    .join('\n');
}

/**
 * 把可能很长的字符串截断（报告中显示日志片段用）
 * @param {string} text
 * @param {number} [max]
 * @returns {string}
 */
export function truncate(text, max = 400) {
  const s = String(text || '');
  if (s.length <= max) return s;
  return s.slice(0, max) + `…（还有 ${s.length - max} 个字符，完整内容见日志文件）`;
}
