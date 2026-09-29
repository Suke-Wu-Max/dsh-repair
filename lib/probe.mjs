/**
 * 环境探测层（**全部只读**）
 * ============================================================
 * 🔴 这一层的铁律：**只读、不许改任何东西。**
 *
 *   为什么这么严：`--dry-run`（只检测不修复）这个模式之所以能让人放心用，
 *   靠的就是"探测阶段根本没有任何写操作"。只要这一层里混进一次 fs.writeFile，
 *   dry-run 就变成骗人的了。
 *   ⇒ 改动这个文件时，请先确认新加的东西**一个字节都没写**。
 *
 * 另一个原则：**一切靠现场探测，不许写死。**
 *   用户名、安装路径、端口、profile 名 —— 全部运行时问出来。
 *   本工具是要发给陌生人用的，任何一处写死都会在别人机器上炸。
 */

import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

import { run, which, IS_WIN } from './exec.mjs';
import { versionGte, exists, isDir, isFile, linkInfo, listDir, readJsonSafe, readTextSafe, humanSize } from './util.mjs';
import { isPortListening, probeDshHttp } from './net.mjs';
import { getCurrentRegistry } from './registry.mjs';

/** DSH 要求的 Node 最低版本。低于它，DSH 起不来是必然的，不是"有可能"。 */
export const REQUIRED_NODE = '22.19.0';

/** DSH 的包名（用于定位安装位置） */
const DSH_PACKAGE = '@deepseek-ai/dsh';

/**
 * 候选端口。
 * 排在前面的优先 —— 顺序是"见过的版本用得最多的"排前面。
 * 用户可以用 --port 覆盖，环境变量 DSH_WEB_URL 里的端口优先级更高。
 */
export const PORT_CANDIDATES = [3080, 9800, 7860, 8080, 8000, 3000, 5000, 5173];

/* ── 1. 操作系统 ──────────────────────────────────────────── */

/**
 * 探测操作系统。
 *
 * 为什么要把 Windows 的版本号翻译成人话：
 * `os.release()` 给的是 "10.0.26100" 这种内核版本号，用户看不懂。
 * 而"你是 Windows 11 还是 Windows 10"在排查时是**有用的信息**
 * （老版本 Windows 对符号链接/junction 的支持不一样）。
 *
 * @returns {{platform:string, platformName:string, arch:string, release:string, versionName:string, isWindows:boolean, isMac:boolean, isLinux:boolean}}
 */
export function probeOs() {
  const platform = process.platform;
  const release = os.release();

  const platformName = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' }[platform] || platform;

  let versionName = release;
  if (platform === 'win32') {
    const parts = release.split('.').map(Number);
    const build = parts[2] || 0;
    if (parts[0] === 10 && build >= 22000) versionName = `Windows 11（内核 ${release}）`;
    else if (parts[0] === 10) versionName = `Windows 10（内核 ${release}）`;
    else if (parts[0] === 6 && parts[1] === 3) versionName = `Windows 8.1（内核 ${release}）`;
    else if (parts[0] === 6 && parts[1] === 1) versionName = `Windows 7（内核 ${release}）`;
    else versionName = `Windows（内核 ${release}）`;
  } else if (platform === 'darwin') {
    versionName = `macOS（Darwin ${release}）`;
  } else if (platform === 'linux') {
    versionName = `Linux（内核 ${release}）`;
    // Linux 上发行版信息更有用，顺手读一下（读不到就算了）
    const osRelease = readTextSafe('/etc/os-release');
    if (osRelease) {
      const m = osRelease.match(/^PRETTY_NAME="?([^"\n]+)"?/m);
      if (m) versionName = `${m[1]}（内核 ${release}）`;
    }
  }

  return {
    platform,
    platformName,
    arch: process.arch,
    release,
    versionName,
    isWindows: platform === 'win32',
    isMac: platform === 'darwin',
    isLinux: platform === 'linux',
  };
}

/* ── 2. Node.js ───────────────────────────────────────────── */

/**
 * 探测 Node.js。
 *
 * ⚠️ 注意一个容易搞混的点：**本工具自己要求的 Node 版本，和 DSH 要求的，不是一回事。**
 *   · 本工具：>= 18 就能跑（package.json 的 engines）
 *   · DSH   ：>= 22.19.0
 *   这个区别**很重要**：正因为工具本身能在 18 上跑，
 *   用户"Node 版本太低导致 DSH 起不来"时，工具**还能跑起来告诉他这件事**。
 *   如果工具自己也要求 22.19，那就变成"打不开的说明书"了。
 *
 * @returns {{version:string, major:number, path:string, meetsDsh:boolean, required:string, satisfiesTool:boolean}}
 */
export function probeNode() {
  const version = process.version;
  const major = parseInt(version.replace(/^v/, '').split('.')[0], 10) || 0;

  return {
    version,
    major,
    path: process.execPath,
    required: REQUIRED_NODE,
    meetsDsh: versionGte(version, REQUIRED_NODE),
    satisfiesTool: major >= 18,
  };
}

/* ── 3. npm ───────────────────────────────────────────────── */

/**
 * 探测 npm。
 *
 * ⚠️ 这里踩过坑（见 exec.mjs 的【坑 1】）：
 *   Windows 上有 npm.cmd 和 npm.ps1 两个入口，PowerShell 执行策略
 *   默认会拦掉 npm.ps1。所以本工具一律走 .cmd，探测时也一样。
 *
 * 🔴 另一个更要命的坑（实测踩到，直接导致误判）：
 *   **"npm 跑不起来" ≠ "npm 没装"。**
 *   实测在受限环境里跑，npm 会以 `EPERM`（Operation not permitted）失败，
 *   但那台机器上 npm 明明装得好好的。如果这时候报"npm 不可用"，
 *   就等于把用户往错的方向引 —— 他会去重装 Node，而问题根本不在那儿。
 *   ⇒ 所以判据拆成两个：exists（命令找得到吗）+ runnable（跑得起来吗），
 *     而且**只有 exists === false 才算"没装"**。
 *
 * @returns {{exists:boolean, runnable:boolean, available:boolean, version:string|null, path:string|null, error:string|null, registry:string|null, registryError:string|null}}
 */
export function probeNpm() {
  const found = which('npm');
  const versionRes = run('npm.cmd', ['--version'], { timeout: 30_000 });
  const registry = getCurrentRegistry();

  const runnable = versionRes.ok;

  return {
    exists: found.found,
    runnable,
    // 兼容旧字段：只要有 npm 可用就算 available（跑不起来也算"装了，只是有问题"）
    available: found.found || runnable,
    version: runnable ? versionRes.stdout.split(/\r?\n/).pop().trim() : null,
    path: found.path,
    error: runnable ? null : versionRes.error || versionRes.stderr || 'npm 执行失败（原因未知）',
    registry: registry.value,
    registryError: registry.error,
  };
}

/* ── 4. DSH 主目录 ────────────────────────────────────────── */

/**
 * 定位 DSH 主目录。
 *
 * 优先级：
 *   ① 命令行 --home（调用方处理，这里不关心）
 *   ② 环境变量 DSH_HOME  ← 这是最权威的，DSH 自己在会话里就会设它
 *   ③ ~/.dsh            ← 默认值
 *
 * @returns {{home:string, source:string, exists:boolean}}
 */
export function probeDshHome(overrideHome) {
  if (overrideHome) {
    return { home: overrideHome, source: '命令行 --home 指定', exists: isDir(overrideHome) };
  }

  const envHome = process.env.DSH_HOME;
  if (envHome) {
    return { home: envHome, source: '环境变量 DSH_HOME', exists: isDir(envHome) };
  }

  const fallback = path.join(os.homedir(), '.dsh');
  return { home: fallback, source: '默认位置 ~/.dsh', exists: isDir(fallback) };
}

/* ── 5. profiles ──────────────────────────────────────────── */

/**
 * 列出所有 profile。
 *
 * 什么叫一个 profile：`$DSH_HOME/profiles/<名字>/` 里
 * 至少有 `package.json` 或 `cordis.patch.yml` 或 `cordis.yml` 之一。
 * （不看目录名白名单 —— 版本会变，用户也可能自建 profile。）
 *
 * @param {string} home
 * @returns {Array<{name:string, dir:string, hasPatch:boolean, patchFile:string, hasPackageJson:boolean, backups:Array<{file:string,size:number,mtimeMs:number}>}>}
 */
export function probeProfiles(home) {
  const profilesDir = path.join(home, 'profiles');
  if (!isDir(profilesDir)) return [];

  const result = [];
  for (const entry of listDir(profilesDir)) {
    if (!isDir(entry)) continue;

    const name = path.basename(entry);
    // profiles/node_modules 是依赖目录，不是 profile
    if (name === 'node_modules') continue;

    const patchFile = path.join(entry, 'cordis.patch.yml');
    const legacyYm = path.join(entry, 'cordis.yml');
    const pkgFile = path.join(entry, 'package.json');

    const hasPatch = isFile(patchFile);
    const hasPackageJson = isFile(pkgFile);

    if (!hasPatch && !hasPackageJson && !isFile(legacyYm)) continue;

    result.push({
      name,
      dir: entry,
      hasPatch,
      patchFile,
      hasPackageJson,
      backups: findBackups(patchFile),
    });
  }

  return result.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * 找一个配置文件的所有历史备份。
 *
 * ⚠️ 命名格式**不能写死**。实测同一台机器上就同时存在两种：
 *   cordis.patch.yml.bak-20260929142630
 *   cordis.patch.yml.bak-voice-20260928-224915
 * 所以用"前缀匹配 + .bak"来认，而不是用正则去套某个固定格式。
 *
 * @param {string} patchFile 配置文件路径
 * @returns {Array<{file:string,size:number,mtimeMs:number}>}
 */
export function findBackups(patchFile) {
  const dir = path.dirname(patchFile);
  const base = path.basename(patchFile);

  const found = [];
  for (const entry of listDir(dir)) {
    const name = path.basename(entry);
    if (name === base) continue;
    // 认 .bak / .bak-xxx / .backup / .old 这几种
    const isBackup =
      name.startsWith(base + '.bak') || name.startsWith(base + '.backup') || name.startsWith(base + '.old');
    if (!isBackup) continue;
    if (!isFile(entry)) continue;

    let size = 0;
    let mtimeMs = 0;
    try {
      const st = fs.statSync(entry);
      size = st.size;
      mtimeMs = st.mtimeMs;
    } catch {
      /* 读不到属性就算了，不影响"存在备份"这个事实 */
    }

    found.push({ file: entry, size, mtimeMs });
  }

  // 新的排前面
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/* ── 6. DSH 本体安装位置 ──────────────────────────────────── */

/**
 * 定位 DSH 本体（`@deepseek-ai/dsh`）装在哪。
 *
 * 🔴 为什么要"多路兜底"：实测同一台机器上，
 *   已经装好的 `dsh-doctor` / `dsh-recovery` 两个工具
 *   **都报 "could not locate the global dsh install"** ——
 *   它们只走了一条路（找全局 npm 目录），而本机的 DSH
 *   实际装在 `~/.dsh/profiles/node_modules/` 下，所以它们瞎了。
 *   ⇒ 教训：**定位安装位置这件事必须多路并进、逐个验证**，
 *     任何单一的探测方式都会在某些机器上落空。
 *
 * 四个来源（按可靠性从高到低）：
 *   ① $DSH_HOME/profiles/node_modules/@deepseek-ai/dsh   ← 本机实际位置
 *   ② 全局 npm root（npm root -g）
 *   ③ which dsh 的 shim 路径反推
 *   ④ npx 缓存 ~/.npm/_npx/&lt;hash&gt;/node_modules/@deepseek-ai/dsh
 *
 * @param {string} home
 * @returns {{found:boolean, path:string|null, version:string|null, source:string|null, candidates:Array<{path:string,exists:boolean,version:string|null,source:string}>}}
 */
export function probeDshInstall(home) {
  const candidates = [];

  /**
   * 往候选里加一条，并立刻验证它是不是真的（有没有 package.json、版本多少）
   * @param {string} dir
   * @param {string} source
   */
  const add = (dir, source) => {
    if (!dir) return;
    const normalized = path.normalize(dir);
    if (candidates.some((c) => c.path === normalized)) return; // 去重

    const pkgFile = path.join(normalized, 'package.json');
    const pkg = readJsonSafe(pkgFile);
    // 必须确实是 @deepseek-ai/dsh 才算 —— 光有目录不算，防止误认
    const isDsh = Boolean(pkg && pkg.name === DSH_PACKAGE);

    candidates.push({
      path: normalized,
      exists: isDir(normalized) && isDsh,
      version: isDsh && pkg.version ? pkg.version : null,
      source,
    });
  };

  // ① profile 自己的 node_modules（本机实测就是这一条命中）
  add(path.join(home, 'profiles', 'node_modules', ...DSH_PACKAGE.split('/')), 'DSH_HOME/profiles/node_modules');

  // ② 全局 npm root
  const npmRoot = run('npm.cmd', ['root', '-g'], { timeout: 30_000 });
  if (npmRoot.ok && npmRoot.stdout) {
    const root = npmRoot.stdout.split(/\r?\n/).pop().trim();
    add(path.join(root, ...DSH_PACKAGE.split('/')), 'npm root -g');
  }

  // ③ 从 dsh 命令的 shim 位置反推
  const dshCmd = which('dsh');
  if (dshCmd.found && dshCmd.path) {
    // shim 通常在 <prefix>/dsh.cmd，而包在 <prefix>/node_modules/@deepseek-ai/dsh
    const prefix = path.dirname(dshCmd.path);
    add(path.join(prefix, 'node_modules', ...DSH_PACKAGE.split('/')), 'dsh 命令 shim 路径');
    // 有些环境 shim 在 <prefix>/bin/
    add(path.join(path.dirname(prefix), 'node_modules', ...DSH_PACKAGE.split('/')), 'dsh 命令 shim 路径（上一级）');
  }

  // ④ npx 缓存（用户可能是 npx 装的，从没全局装过）
  for (const npxBase of [path.join(os.homedir(), '.npm', '_npx'), path.join(os.homedir(), 'AppData', 'Local', 'npm-cache', '_npx')]) {
    if (!isDir(npxBase)) continue;
    for (const hashDir of listDir(npxBase)) {
      add(path.join(hashDir, 'node_modules', ...DSH_PACKAGE.split('/')), 'npx 缓存');
    }
  }

  const hit = candidates.find((c) => c.exists);
  return {
    found: Boolean(hit),
    path: hit ? hit.path : null,
    version: hit ? hit.version : null,
    source: hit ? hit.source : null,
    candidates,
  };
}

/**
 * 探测 dsh 命令本身是否可用，并解析出它的入口脚本。
 * 用途：修复阶段要拿它来启动服务。
 *
 * @returns {{available:boolean, shim:string|null, entry:string|null}}
 */
export function probeDshCommand() {
  const found = which('dsh');
  if (!found.found) return { available: false, shim: null, entry: null };

  // 从 shim 目录推 lib/bin.js（npm 全局安装的标准布局）
  const prefix = path.dirname(found.path);
  const entry = path.join(prefix, 'node_modules', ...DSH_PACKAGE.split('/'), 'lib', 'bin.js');

  return {
    available: true,
    shim: found.path,
    entry: isFile(entry) ? entry : null,
  };
}

/* ── 7. 配置文件的健康状态 ────────────────────────────────── */

/**
 * 检查 profile 的插件登记情况 —— 直接看 cordis.patch.yml 里登记了哪些插件，
 * 以及它们在 node_modules 里**是不是真的装上了**。
 *
 * 🔴 这条检查针对的就是本次要修的那个经典故障：
 *   `cordis.patch.yml` 里登记了插件 X，但 node_modules 里没有 X 的链接
 *   ⇒ DSH 启动时 `ERR_MODULE_NOT_FOUND: Cannot find package 'X'` ⇒ 整个服务起不来。
 *   （实测本机 `plugins/dsh-say` 目录在、node_modules 里却没有它的链接，
 *     正是这个状态。）
 *
 * @param {{name:string, dir:string, patchFile:string, hasPatch:boolean}} profile
 * @returns {{entries:Array<{id:string|null, name:string|null, installed:boolean, linkBroken:boolean, resolvedFrom:string}>, parseWarning:string|null}}
 */
export function probePluginEntries(profile) {
  const entries = [];

  if (!profile.hasPatch || !isFile(profile.patchFile)) {
    return { entries, parseWarning: null };
  }

  const text = readTextSafe(profile.patchFile);
  if (text === null) {
    return { entries, parseWarning: '配置文件读不出来（权限问题？）' };
  }

  // ⚠️ 这里刻意**不做完整的 YAML 解析**。
  //   原因：完整解析 YAML 需要 js-yaml，而本工具坚持零依赖；
  //   自己手写一个 YAML 解析器又必然和 DSH 的真实解析器有偏差
  //   （尤其 `!!js` 标签），那种"我解析成功但其实坏了"的假阴性更危险。
  //   ⇒ 所以这里只做**保守的文本扫描**：扫出 `name: 'xxx'` 形态的登记项，
  //     用来做"装没装"的交叉检查；真正的语法诊断交给 dsh-fix doctor。
  const lines = text.split(/\r?\n/);
  let currentId = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#')) continue; // 注释行不算（被注释掉的插件=没启用）

    const idMatch = trimmed.match(/^-\s*id:\s*['"]?([^'"\s]+)['"]?/);
    if (idMatch) {
      currentId = idMatch[1];
      continue;
    }

    const nameMatch = trimmed.match(/^name:\s*['"]?([^'"\s]+)['"]?/);
    if (nameMatch) {
      const name = nameMatch[1];
      const check = checkPluginInstalled(profile.dir, name);
      entries.push({ id: currentId, name, ...check });
      currentId = null;
    }
  }

  return { entries, parseWarning: null };
}

/**
 * 检查一个插件包在 profile 里能不能被解析到。
 *
 * 模拟 Node 的模块解析：从 profile 目录出发，往上找 node_modules。
 * 只看"能不能找到 + 链接是不是断的"，不加载它（能加载也不代表插件本身没 bug）。
 *
 * @param {string} profileDir
 * @param {string} packageName
 * @returns {{installed:boolean, linkBroken:boolean, resolvedFrom:string}}
 */
function checkPluginInstalled(profileDir, packageName) {
  // 内置插件（@deepseek-ai/*）由 DSH 自己提供，不在 profile 里 —— 跳过不报错
  if (packageName.startsWith('@deepseek-ai/')) {
    return { installed: true, linkBroken: false, resolvedFrom: 'DSH 内置' };
  }

  const searchDirs = [
    profileDir,
    path.join(profileDir, '..'), // profiles/
    path.join(profileDir, '..', '..'), // $DSH_HOME/
  ];

  for (const base of searchDirs) {
    const target = path.join(base, 'node_modules', ...packageName.split('/'));
    if (!exists(target)) continue;

    const link = linkInfo(target);
    // 目录在、但链接断了（目标被删/被移走）—— 这也是坏的，而且更隐蔽
    if (link.isLink && link.broken) {
      return { installed: false, linkBroken: true, resolvedFrom: target };
    }
    return { installed: true, linkBroken: false, resolvedFrom: target };
  }

  return { installed: false, linkBroken: false, resolvedFrom: '' };
}

/* ── 8. 端口 ──────────────────────────────────────────────── */

/**
 * 探测端口：哪些在监听、哪个是 DSH、以及"该用哪个端口"。
 *
 * 优先级（这个顺序很讲究，别调）：
 *   ① 命令行 --port  ← 用户说了算
 *   ② 环境变量 DSH_WEB_URL 里的端口 ← 如果 DSH 正开着，这是**事实**
 *   ③ 候选列表里第一个在监听且确认是 DSH 的
 *   ④ 候选列表里第一个在监听但**不确定是不是 DSH** 的（要报出来）
 *   ⑤ 都没有 → 返回 null，交给"服务未启动"分支
 *
 * @param {object} opts
 * @param {number} [opts.port] 用户指定的端口
 * @param {string[]} [opts.extraCandidates] 额外候选（调用方可补充）
 * @returns {Promise<object>}
 */
export async function probePorts(opts = {}) {
  const candidates = [];

  const push = (p) => {
    const n = Number(p);
    if (Number.isInteger(n) && n > 0 && n < 65536 && !candidates.includes(n)) candidates.push(n);
  };

  // ① 用户指定
  if (opts.port) push(opts.port);

  // ② 环境变量里的端口
  const envUrl = process.env.DSH_WEB_URL;
  let envPort = null;
  if (envUrl) {
    try {
      const u = new URL(envUrl);
      if (u.port) envPort = Number(u.port);
      else envPort = u.protocol === 'https:' ? 443 : 80;
    } catch {
      /* URL 不合法就忽略，不因为一个环境变量把整个探测搞崩 */
    }
  }
  if (envPort) push(envPort);

  // ③ 候选列表
  for (const p of opts.extraCandidates || []) push(p);
  for (const p of PORT_CANDIDATES) push(p);

  // 并发探测 —— 用 net.connect，不用 netstat（原因见 net.mjs 顶部）
  const checks = await Promise.all(
    candidates.map(async (port) => {
      const { listening } = await isPortListening(port);
      if (!listening) return { port, listening: false, isDsh: false, status: null, evidence: '' };
      const http = await probeDshHttp(port);
      return { port, listening: true, isDsh: http.isDsh, status: http.status, evidence: http.evidence };
    }),
  );

  const listening = checks.filter((c) => c.listening);
  const dshRunning = listening.filter((c) => c.isDsh);

  // 决定"当前 DSH 在哪个端口"
  //
  // 🔴 只用**强证据**（isDsh）来判定，绝不用"端口能通"来凑数。
  //   实测教训：8000 端口上是个 C-Lodop 打印服务，能正常返回 HTTP 200，
  //   早先的宽松逻辑会把它认成 DSH，于是误报"服务运行正常"、什么都不修。
  let activePort = null;
  let activeSource = null;

  if (envPort && dshRunning.some((c) => c.port === envPort)) {
    activePort = envPort;
    activeSource = '环境变量 DSH_WEB_URL 指向的端口上确实跑着 DSH';
  } else if (dshRunning.length > 0) {
    activePort = dshRunning[0].port;
    activeSource = '探测到该端口上跑着 DSH（响应里有 DSH 标识）';
  }

  return {
    candidates,
    checks,
    listening,
    dshRunning,
    activePort,
    activeSource,
    /** 用户用 --port 明确指定的端口（没指定就是 null）—— 诊断时要拿它跟实际情况对照 */
    requestedPort: opts.port || null,
    /** 想启动服务时该用哪个端口：优先用户指定，否则第一个候选 */
    preferredPort: opts.port || activePort || candidates[0] || PORT_CANDIDATES[0],
    envUrl: envUrl || null,
  };
}

/* ── 9. 日志文件 ──────────────────────────────────────────── */

/**
 * 找 DSH 可能留下的日志文件。
 *
 * ⚠️ 实测：DSH 并**没有**一个固定的日志文件（我在这台机器上翻遍了
 * `~/.dsh` 也没找到）。它的启动错误是直接打到**终端的 stdout/stderr** 的。
 *
 * ⇒ 所以本工具的核心策略是：**自己把 DSH 启动一次，直接捕获它的输出**。
 *   这比"猜日志在哪"可靠得多（见 repair.mjs 的 startAndWatch）。
 *   这里只是顺带扫一眼常见位置，作为补充证据。
 *
 * @param {string} home
 * @returns {Array<{file:string,size:number,mtimeMs:number}>}
 */
export function probeLogs(home) {
  const spots = [path.join(home, 'logs'), home, path.join(home, 'storages')];
  const found = [];

  for (const dir of spots) {
    if (!isDir(dir)) continue;
    for (const entry of listDir(dir)) {
      const name = path.basename(entry);
      if (!/\.(log|txt)$/i.test(name)) continue;
      if (!isFile(entry)) continue;
      try {
        const st = fs.statSync(entry);
        // 只认最近改过的，旧日志没意义
        if (Date.now() - st.mtimeMs > 7 * 24 * 3600 * 1000) continue;
        found.push({ file: entry, size: st.size, mtimeMs: st.mtimeMs });
      } catch {
        /* 忽略 */
      }
    }
  }

  return found.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, 10);
}

/* ── 10. 汇总 ─────────────────────────────────────────────── */

/**
 * 把所有探测串起来跑一遍。
 *
 * @param {object} opts
 * @param {string} [opts.home]      用户指定的 DSH 主目录
 * @param {string} [opts.profile]   用户指定的 profile 名
 * @param {number} [opts.port]      用户指定的端口
 * @param {(step:string, index:number, total:number)=>void} [opts.onProgress]
 * @returns {Promise<object>} 一份完整的"环境体检报告"数据
 */
export async function probeAll(opts = {}) {
  const total = 7;
  let index = 0;
  const tick = (text) => {
    index++;
    if (opts.onProgress) opts.onProgress(text, index, total);
  };

  tick('操作系统');
  const osInfo = probeOs();

  tick('Node.js');
  const node = probeNode();

  tick('npm 与软件源');
  const npm = probeNpm();

  tick('DSH 主目录与 profiles');
  const homeInfo = probeDshHome(opts.home);
  const profiles = probeProfiles(homeInfo.home);

  // 选一个 profile：用户指定的优先，否则优先 web（DSH 的标准 profile），
  // 再否则取找到的第一个。**不写死 'web'**，因为别人机器上可能叫别的名字。
  let profile = null;
  if (opts.profile) {
    profile = profiles.find((p) => p.name === opts.profile) || null;
  } else {
    profile = profiles.find((p) => p.name === 'web') || profiles.find((p) => p.hasPatch) || profiles[0] || null;
  }

  tick('DSH 本体安装位置');
  const install = probeDshInstall(homeInfo.home);
  const command = probeDshCommand();

  tick('端口与运行状态');
  const ports = await probePorts({
    port: opts.port,
    extraCandidates: opts.extraCandidates,
  });

  tick('配置文件与备份');
  const pluginEntries = profile ? probePluginEntries(profile) : { entries: [], parseWarning: null };
  const logs = probeLogs(homeInfo.home);

  return {
    os: osInfo,
    node,
    npm,
    home: homeInfo,
    profiles,
    profile,
    install,
    command,
    ports,
    pluginEntries,
    logs,
    /** 探测时刻（报告里要写清楚"这是什么时候看到的"） */
    probedAt: new Date().toISOString(),
  };
}
