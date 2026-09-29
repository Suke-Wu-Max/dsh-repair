/**
 * 修复层（**唯一会动盘的地方**）
 * ============================================================
 * 🔴 这个文件承载了整个工具的安全承诺，改动前请读完这四条规矩：
 *
 * 【规矩一】改任何文件之前，先备份。没有例外。
 *   备份命名跟 DSH 自己一致（`xxx.bak-<时间戳>`），
 *   好处是用户看着眼熟，而且能跟 DSH 自己产生的备份混在一起按时间排序。
 *
 * 【规矩二】备份要幂等 —— 重复跑不能堆出一屋子备份。
 *   做法：备份前算内容指纹，已经存在**内容完全相同**的备份就跳过。
 *   这样用户连点十次工具，磁盘上还是那一份备份。
 *
 * 【规矩三】只做加法，不做减法。
 *   本工具**从不删除**用户的插件目录、配置内容、数据文件。
 *   禁用插件用的是"追加一条 disabled 补丁"（DSH 原生语义），
 *   原始内容一个字节都不动 —— 所以随时能原样还原。
 *
 * 【规矩四】先精确、后兜底。
 *   一个插件坏了，最好的结果是**把那个插件真正修好**（功能还在），
 *   其次才是"只禁用它"（别的插件不受影响），
 *   最后才是"全部禁用"的安全模式。
 *   三者代价差得很远，顺序不能反。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { run, which, startDetached, IS_WIN } from './exec.mjs';
import { timestampSuffix, exists, isDir, isFile, readJsonSafe, linkInfo } from './util.mjs';
import { isPortListening, probeDshHttp, findFreePort } from './net.mjs';
import { probeRegistries, setRegistry, getCurrentRegistry } from './registry.mjs';

/** 启动 DSH 后最多等多久（毫秒）—— 插件多的机器可能要 30 秒以上 */
const BOOT_TIMEOUT_MS = 90_000;

/**
 * 修复器。
 *
 * 为什么用 class 而不是一堆散函数：这一层有明确的**顺序**和**共享状态**
 * （备份目录、启动日志、干跑开关、已经改过哪些文件），
 * 用对象装起来比到处传参清楚得多，也更容易在报告里回溯"到底做了什么"。
 */
export class Repairer {
  /**
   * @param {object} ctx
   * @param {object} ctx.env    probeAll() 的探测结果
   * @param {import('./ui.mjs').UI} ctx.ui
   * @param {import('./log.mjs').Logger} ctx.log
   * @param {boolean} [ctx.dryRun] 只检测不修复
   * @param {boolean} [ctx.yes]    所有确认自动答是
   * @param {string} [ctx.home]    DSH 主目录
   * @param {number} [ctx.port]    用户指定端口
   * @param {string} [ctx.bootLog] 启动输出落地的文件路径
   */
  constructor(ctx) {
    this.env = ctx.env;
    this.ui = ctx.ui;
    this.log = ctx.log;
    this.dryRun = Boolean(ctx.dryRun);
    this.yes = Boolean(ctx.yes);
    this.home = ctx.home;
    this.port = ctx.port;

    /** 本次运行做过的动作 —— 报告里要一条条列出来 */
    this.actions = [];
    /** 本次运行产生的备份文件 */
    this.backups = [];
    /** 启动输出落地的文件 */
    this.bootLog = ctx.bootLog || path.join(process.cwd(), 'dsh-tudian-boot-output.txt');
    /** 已经启动的子进程 */
    this.launched = null;
    /** 切源时记下的原值，报告里要告诉用户怎么改回去 */
    this.registryBackup = null;
  }

  /**
   * 记一条动作（同时进终端、日志、报告）
   * @param {string} text
   * @param {'info'|'ok'|'warn'|'error'} [level]
   */
  record(text, level = 'info') {
    this.actions.push({ text, level, at: new Date().toISOString() });
    this.log.log(text, level === 'info' ? 'info' : level);
    // ui 的 ok/warn 自己会带符号，这里只给纯文本，避免双重符号
    if (this.ui) {
      if (level === 'ok') this.ui.ok(text);
      else if (level === 'warn') this.ui.warn(text);
      else if (level === 'error') this.ui.fail(text);
      else this.ui.info(text);
    }
  }

  /* ── 备份 / 恢复 ───────────────────────────────────────── */

  /**
   * 算文件内容指纹（用来判断"这份备份是不是已经存在了"）
   * @param {string} file
   * @returns {string|null}
   */
  fingerprint(file) {
    try {
      const buf = fs.readFileSync(file);
      return crypto.createHash('sha256').update(buf).digest('hex');
    } catch {
      return null;
    }
  }

  /**
   * 备份一个文件。
   *
   * 幂等：如果已经有一份**内容完全相同**的备份，直接复用，不再新建。
   * （判断标准是内容指纹，不是文件名 —— 文件名会因为时间戳不同而不同。）
   *
   * @param {string} file 要备份的文件
   * @returns {{ok:boolean, backupFile:string|null, reused:boolean, error:string|null}}
   */
  backup(file) {
    if (!isFile(file)) {
      return { ok: false, backupFile: null, reused: false, error: '文件不存在，无需备份' };
    }

    const dir = path.dirname(file);
    const base = path.basename(file);
    const wantPrint = this.fingerprint(file);

    // 先看有没有内容相同的现成备份
    for (const entry of fs.readdirSync(dir)) {
      if (!entry.startsWith(base + '.bak')) continue;
      const candidate = path.join(dir, entry);
      if (!isFile(candidate)) continue;
      if (this.fingerprint(candidate) === wantPrint) {
        this.log.log(`备份复用：${candidate}（内容与当前文件一致）`, 'info');
        return { ok: true, backupFile: candidate, reused: true, error: null };
      }
    }

    // 🔴 防撞名 —— 这是测试真跑出来的一个会导致**丢备份**的 bug：
    //   时间戳的精度是秒，而"恢复前先备份当前状态"这种动作跟原备份
    //   极可能落在**同一秒**里，于是 copyFileSync 就把前一份**静默覆盖**了。
    //   表面上看"备份成功了"，实际上磁盘上少了一份 —— 而备份恰恰是
    //   整个安全承诺的地基，这里丢东西是不可接受的。
    //   ⇒ 目标已存在就加序号，**绝不覆盖已有的备份**。
    let target = `${file}.bak-${timestampSuffix()}`;
    let counter = 1;
    while (fs.existsSync(target) && counter < 1000) {
      target = `${file}.bak-${timestampSuffix()}-${counter}`;
      counter++;
    }

    try {
      fs.copyFileSync(file, target);
      this.backups.push(target);
      this.log.log(`已备份 ${file} → ${target}`, 'ok');
      return { ok: true, backupFile: target, reused: false, error: null };
    } catch (err) {
      // 备份失败**必须**让调用方停下来 —— 没备份就改文件是这套流程里最不可原谅的错
      return { ok: false, backupFile: null, reused: false, error: String(err.message || err) };
    }
  }

  /**
   * 从备份恢复一个文件（恢复前会先把"当前状态"也备份一次，
   * 免得恢复动作本身变成一次不可逆的破坏）
   *
   * @param {string} file 目标文件
   * @param {string} backupFile 用哪份备份
   * @returns {{ok:boolean, error:string|null}}
   */
  restore(file, backupFile) {
    if (this.dryRun) {
      this.record(`[干跑] 会从备份恢复：${path.basename(backupFile)} → ${path.basename(file)}`);
      return { ok: true, error: null };
    }

    if (!isFile(backupFile)) return { ok: false, error: `备份文件不存在：${backupFile}` };

    // 恢复前先备份当前状态 —— 万一恢复到一半发现选错备份了，还能回来
    if (isFile(file)) {
      const pre = this.backup(file);
      if (!pre.ok) return { ok: false, error: `恢复前的安全备份失败，已中止：${pre.error}` };
    }

    try {
      fs.copyFileSync(backupFile, file);
      this.record(`已从备份恢复：${path.basename(backupFile)} → ${path.basename(file)}`, 'ok');
      return { ok: true, error: null };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  }

  /* ── 启动服务 ─────────────────────────────────────────── */

  /**
   * 拼出启动 DSH 的命令。
   *
   * 用 `dsh --profile <名字>` 而不是 `dsh web`：
   * `web` 只是默认 profile 的别名，用户的 profile 可能叫别的名字。
   *
   * 关于 --port：`--profile` 是 launcher 自己的参数，而 `--port` 不是，
   * 所以它会被转发给 web app 本身（DSH 的 help 里写明"launcher 参数之后的
   * 内容会传到 app"）。但老版本 DSH 的 app 可能不认这个参数，
   * 所以调用方必须准备好"带了它起不来就脱掉重试"。
   *
   * @param {string|null} profileName
   * @param {number|null} port
   * @returns {{cmd:string, args:string[]}}
   */
  buildStartCommand(profileName, port) {
    const args = [];
    if (profileName) args.push('--profile', profileName);
    if (port) args.push('--port', String(port));
    return { cmd: IS_WIN ? 'dsh.cmd' : 'dsh', args };
  }

  /**
   * 启动 DSH 并等它起来。
   *
   * ⚠️ 为什么输出要**重定向到文件**而不是收到管道里：
   *   这个服务是常驻的，本工具退出后它还得接着活。
   *   如果输出挂在管道上，本工具一退出管道就断，
   *   子进程下一次写日志就会吃到 EPIPE 而崩掉 ——
   *   那就变成"修好了，但用户一关窗口它就死"。
   *   ⇒ 落到文件里，父子进程彻底解耦。
   *
   * @param {object} opts
   * @param {number} [opts.port] 用哪个端口启动
   * @param {string} [opts.profileName]
   * @param {number} [opts.timeoutMs]
   * @param {boolean} [opts.detach] 是否让它独立于本进程（默认 true）
   * @returns {Promise<{ok:boolean, port:number|null, output:string, exitedEarly:boolean, error:string|null}>}
   */
  async startAndVerify(opts = {}) {
    const profileName = opts.profileName || (this.env.profile ? this.env.profile.name : null);
    const targetPort = opts.port || this.port || this.env.ports.preferredPort;
    const timeoutMs = opts.timeoutMs || BOOT_TIMEOUT_MS;

    const { cmd, args } = this.buildStartCommand(profileName, targetPort);

    if (this.dryRun) {
      this.record(`[干跑] 会执行：${cmd} ${args.join(' ')}`);
      return { ok: false, port: null, output: '', exitedEarly: false, error: null, dryRun: true };
    }

    // 每次都清掉旧的启动输出，免得读到上一次的残留错误
    try {
      fs.writeFileSync(this.bootLog, `# dsh-tudian 捕获的启动输出 · ${new Date().toISOString()}\n# 命令：${cmd} ${args.join(' ')}\n\n`, 'utf8');
    } catch (err) {
      return { ok: false, port: null, output: '', exitedEarly: false, error: `无法写启动日志文件：${err.message}` };
    }

    this.log.log(`启动服务：${cmd} ${args.join(' ')}`, 'step');

    let outFd;
    let child;
    try {
      outFd = fs.openSync(this.bootLog, 'a');
      child = startDetached(cmd, args, {
        cwd: this.home || process.cwd(),
        stdout: outFd,
        stderr: outFd,
        // 🔴 必须把 DSH_HOME 显式传下去。
        //   否则会出现"探测的是 A、启动的是 B"这种错位：
        //   本工具按 --home / DSH_HOME 找到 profile 并诊断，
        //   但被启动的 DSH 会用**它自己默认的**家目录 —— 两边对不上。
        //   DSH 就是靠这个环境变量决定去哪儿找 profiles 的。
        //   （用 --home 指向非默认位置的用户，没有这一行会直接启动错对象。）
        env: this.home ? { DSH_HOME: this.home } : {},
      });
      this.launched = child;
    } catch (err) {
      return { ok: false, port: null, output: '', exitedEarly: true, error: `启动失败：${err.message}` };
    } finally {
      if (outFd !== undefined) {
        // 父进程这一侧的 fd 可以关掉：子进程已经拿到了自己的副本
        try {
          fs.closeSync(outFd);
        } catch {
          /* 忽略 */
        }
      }
    }

    let exitedEarly = false;
    child.on('exit', () => {
      exitedEarly = true;
    });

    // 轮询端口 —— 这是判断"起来了没"的唯一可靠信号
    const deadline = Date.now() + timeoutMs;
    let upPort = null;

    while (Date.now() < deadline) {
      // 每轮都重新算候选：DSH 有可能不用我们给的端口（比如参数被忽略）
      const tryPorts = [targetPort, ...this.env.ports.candidates.slice(0, 5)].filter(Boolean);
      for (const p of [...new Set(tryPorts)]) {
        const { listening } = await isPortListening(p);
        if (listening) {
          upPort = p;
          break;
        }
      }
      if (upPort) break;

      // 进程如果已经退了，再等下去没意义 —— 立刻收工去读报错
      if (exitedEarly) break;

      await sleep(1200);
    }

    const output = this.readBootLog();

    if (upPort) {
      this.record(`服务已启动，端口 ${upPort}`, 'ok');
      return { ok: true, port: upPort, output, exitedEarly: false, error: null };
    }

    if (exitedEarly) {
      this.log.log('启动进程提前退出，下面是它最后的输出：', 'warn');
      this.log.log(output, 'raw');
      return { ok: false, port: null, output, exitedEarly: true, error: '启动进程已退出' };
    }

    return { ok: false, port: null, output, exitedEarly: false, error: `等待 ${Math.round(timeoutMs / 1000)} 秒后端口仍未就绪` };
  }

  /**
   * 读启动输出（只留尾部，避免报告里塞进几万行）
   * @param {number} [maxChars]
   * @returns {string}
   */
  readBootLog(maxChars = 20000) {
    try {
      const text = fs.readFileSync(this.bootLog, 'utf8');
      return text.length > maxChars ? text.slice(-maxChars) : text;
    } catch {
      return '';
    }
  }

  /* ── 插件：精确修复（首选路径） ───────────────────────── */

  /**
   * 找一个插件的"源码目录"。
   *
   * DSH 的插件有两种来源：
   *   ① 本地目录插件：放在 `<profile>/plugins/<名字>/`，靠 node_modules 里的链接接进来
   *   ② npm 包插件：直接从 npm 装进 node_modules
   * 本函数找的是第 ① 种（也是最容易"手一抖忘了建链接"的那种）。
   *
   * @param {string} packageName
   * @returns {string|null} 插件源码目录
   */
  findPluginSource(packageName) {
    if (!this.env.profile) return null;

    const base = path.basename(packageName);
    const spots = [
      path.join(this.env.profile.dir, 'plugins', base),
      path.join(this.env.profile.dir, 'plugins', packageName),
      path.join(this.home || '', 'plugins', base),
    ];

    for (const spot of spots) {
      if (isDir(spot) && isFile(path.join(spot, 'package.json'))) return spot;
    }
    return null;
  }

  /**
   * 重建插件在 node_modules 里的链接。
   *
   * 🔴 这是**最有价值的修复动作** —— 因为它把插件真正修好了（功能保留），
   *   而不是把插件禁掉。实测本机就是这个状态：
   *   `plugins/dsh-say/` 目录好好地在那儿，只是 node_modules 里少了一条链接。
   *
   * 幂等：链接已经存在且指向正确，就直接跳过。
   *
   * @param {string} packageName 包名
   * @param {string} sourceDir 插件源码目录
   * @returns {{ok:boolean, linkPath:string|null, skipped:boolean, error:string|null}}
   */
  linkPlugin(packageName, sourceDir) {
    const nodeModules = path.join(this.env.profile.dir, 'node_modules');
    const linkPath = path.join(nodeModules, ...packageName.split('/'));

    if (this.dryRun) {
      this.record(`[干跑] 会建立链接：${linkPath} → ${sourceDir}`);
      return { ok: true, linkPath, skipped: false, error: null };
    }

    // 已经存在的情况要分开处理：链接是好的就跳过；断了或者是真目录才需要动手
    const info = linkInfo(linkPath);
    if (exists(linkPath)) {
      if (info.isLink && !info.broken) {
        this.record(`插件的链接已存在且完好，跳过：${packageName}`, 'info');
        return { ok: true, linkPath, skipped: true, error: null };
      }
      if (!info.isLink) {
        // 这里是个真目录（不是链接）——**绝不删**，那是用户的数据
        return {
          ok: false,
          linkPath,
          skipped: false,
          error: `${linkPath} 已经存在且不是链接（是真实目录），本工具不会删除它。请手动确认后处理。`,
        };
      }
      // 链接断了：可以安全地重指（先移除坏链接本身，它不是一个真实文件）
      try {
        fs.unlinkSync(linkPath);
        this.log.log(`移除了失效的链接：${linkPath}`, 'warn');
      } catch (err) {
        return { ok: false, linkPath, skipped: false, error: `无法移除失效链接：${err.message}` };
      }
    }

    try {
      fs.mkdirSync(path.dirname(linkPath), { recursive: true });
      // Windows 上一定要用 'junction'：
      //   'dir' 类型的目录符号链接需要管理员权限或开发者模式，
      //   而 junction 不需要，且对 Node 的模块解析完全等价。
      fs.symlinkSync(sourceDir, linkPath, IS_WIN ? 'junction' : 'dir');
      this.record(`已重建插件链接：${packageName} → ${sourceDir}`, 'ok');
      return { ok: true, linkPath, skipped: false, error: null };
    } catch (err) {
      return { ok: false, linkPath, skipped: false, error: `建立链接失败：${err.message}` };
    }
  }

  /* ── dsh-fix 集成 ─────────────────────────────────────── */

  /**
   * 确保 dsh-fix 可用。
   *
   * 先看有没有现成的（很多用户已经装过），没有才装 ——
   * 装的时候用**温和档**（单条命令带 --registry），不动用户的全局源配置。
   *
   * @param {string|null} registry 用哪个源装
   * @returns {Promise<{ok:boolean, how:string|null, error:string|null}>}
   */
  async ensureDshFix(registry) {
    // 已经能用？
    const existing = run('dsh-fix.cmd', ['version'], { timeout: 30_000 });
    if (existing.ok) {
      this.record(`dsh-fix 已就绪：${existing.stdout.split(/\r?\n/)[0]}`, 'ok');
      return { ok: true, how: 'already', error: null };
    }

    if (this.dryRun) {
      this.record('[干跑] 会安装 dsh-fix（npm i -g dsh-fix）');
      return { ok: true, how: 'dry-run', error: null };
    }

    const args = ['install', '-g', 'dsh-fix'];
    if (registry) args.push('--registry', registry);

    this.record(`正在安装 dsh-fix（会用源：${registry || '当前默认源'}）…`);
    const install = run('npm.cmd', args, { timeout: 300_000 });
    this.log.logExec('npm', args, install);

    if (install.ok) {
      const check = run('dsh-fix.cmd', ['version'], { timeout: 30_000 });
      if (check.ok) {
        this.record(`dsh-fix 安装成功：${check.stdout.split(/\r?\n/)[0]}`, 'ok');
        return { ok: true, how: 'global-install', error: null };
      }
    }

    // 全局装不上（常见原因：没有全局写权限）→ 退一步用 npx
    this.record('全局安装失败，改用 npx 方式调用（不需要写权限）', 'warn');
    const npxTest = run('npx.cmd', ['-y', 'dsh-fix', 'version'], { timeout: 300_000 });
    if (npxTest.ok) {
      return { ok: true, how: 'npx', error: null };
    }

    this.record(`dsh-fix 安装失败：${install.stderr || install.error || '未知原因'}`, 'error');
    return { ok: false, how: null, error: install.stderr || install.error || '安装失败' };
  }

  /**
   * 调 dsh-fix 做一件事。
   *
   * @param {string[]} args 例如 ['doctor'] / ['safe'] / ['disable', 'say']
   * @param {object} [opts]
   * @param {string} [opts.how] ensureDshFix 返回的 how，决定用命令还是 npx
   * @param {number} [opts.timeout]
   * @returns {{ok:boolean, stdout:string, stderr:string, used:string}}
   */
  runDshFix(args, opts = {}) {
    const useNpx = opts.how === 'npx';
    const cmd = useNpx ? 'npx.cmd' : 'dsh-fix.cmd';
    const realArgs = useNpx ? ['-y', 'dsh-fix', ...args] : args;

    if (this.dryRun && args[0] !== 'doctor' && args[0] !== 'list') {
      this.record(`[干跑] 会执行：${cmd} ${realArgs.join(' ')}`);
      return { ok: true, stdout: '', stderr: '', used: 'dry-run' };
    }

    const res = run(cmd, realArgs, { timeout: opts.timeout || 120_000 });
    this.log.logExec(cmd, realArgs, res);

    this.log.log(`dsh-fix ${args.join(' ')} 输出：\n${res.stdout || '(空)'}`, 'raw');
    if (res.stderr) this.log.log(`dsh-fix 错误输出：${res.stderr}`, 'raw');

    return { ok: res.ok, stdout: res.stdout, stderr: res.stderr, used: useNpx ? 'npx' : 'global' };
  }

  /* ── 软件源 ───────────────────────────────────────────── */

  /**
   * 挑一个当前最能用的软件源。
   *
   * @returns {Promise<{best:object|null, all:object[]}>}
   */
  async pickBestRegistry() {
    const reg = getCurrentRegistry();
    this.registryBackup = reg.value;

    this.log.log(`当前 npm 源：${reg.value || '（没读到）'}${reg.error ? ` · 读取问题：${reg.error}` : ''}`, 'info');

    const all = await probeRegistries({
      timeout: 6000,
      onProbe: (row) => {
        const status = row.ok ? `${row.ms}ms` : `不可用（${row.error}）`;
        this.log.log(`测源 ${row.name}：${status}`, 'raw');
      },
    });

    const best = all.find((r) => r.ok) || null;
    return { best, all };
  }

  /**
   * 切换软件源。
   *
   * 🔴 默认**不改用户配置**（温和档：只在本次装包时带 --registry）。
   *   只有在用户明确要求 --persist-registry 时才写全局配置，
   *   而且写之前把原值记下来，报告里告诉用户怎么改回去。
   *
   * @param {string} url
   * @returns {{ok:boolean, mode:string, error:string|null}}
   */
  persistRegistry(url) {
    if (this.dryRun) {
      this.record(`[干跑] 会把 npm 源改为：${url}（原值：${this.registryBackup || '未知'}）`);
      return { ok: true, mode: 'dry-run', error: null };
    }

    const res = setRegistry(url);
    if (res.ok) {
      this.record(`已把 npm 源切换为 ${url}（原值：${this.registryBackup || '未知'}）`, 'ok');
      this.record(`想改回去：npm config set registry ${this.registryBackup || 'https://registry.npmjs.org/'}`, 'info');
      return { ok: true, mode: 'persist', error: null };
    }

    this.record(`切换 npm 源失败：${res.error}`, 'warn');
    return { ok: false, mode: 'persist', error: res.error };
  }

  /**
   * 清 npm 缓存 —— 用的**温柔档**。
   *
   * ⚠️ 需求里写的是"清缓存"，但这里刻意不用 `npm cache clean --force`：
   *   那个命令会把用户**所有**下载缓存删掉，属于"删用户数据"。
   *   本工具的规矩是"不删除用户数据"，所以默认走 `npm cache verify`
   *   —— 它只校验完整性并清掉损坏/临时条目，正好能治 TAR_BAD_ARCHIVE
   *   这类"缓存里的包坏了"的病，而且没有任何破坏性。
   *
   * @returns {{ok:boolean, command:string, output:string}}
   */
  cleanCache() {
    const args = ['cache', 'verify'];

    if (this.dryRun) {
      this.record(`[干跑] 会执行：npm ${args.join(' ')}（温柔档：只校验并清理损坏条目）`);
      return { ok: true, command: `npm ${args.join(' ')}`, output: '' };
    }

    const res = run('npm.cmd', args, { timeout: 180_000 });
    this.log.logExec('npm', args, res);

    if (res.ok) {
      this.record('npm 缓存已校验（损坏的条目会被顺带清掉）', 'ok');
    } else {
      this.record(`缓存校验没成功（不影响继续）：${res.stderr || res.error || ''}`, 'warn');
    }

    return { ok: res.ok, command: `npm ${args.join(' ')}`, output: res.stdout || res.stderr || '' };
  }

  /* ── 端口 ─────────────────────────────────────────────── */

  /**
   * 端口被别的程序占了 —— 找一个空闲的顶上。
   *
   * @param {number} startFrom 从哪个端口开始找
   * @returns {Promise<number|null>}
   */
  async chooseAlternativePort(startFrom) {
    const free = await findFreePort(startFrom + 1, 80);
    if (free) {
      this.record(`端口 ${startFrom} 被占用，改用空闲端口 ${free}`, 'ok');
    } else {
      this.record(`从 ${startFrom + 1} 往上找了 80 个端口，全都是占用状态`, 'error');
    }
    return free;
  }

  /* ── 验证 ─────────────────────────────────────────────── */

  /**
   * 验证服务是不是真的好了。
   *
   * 两层验证，缺一不可：
   *   ① 端口在监听（有东西在跑）
   *   ② HTTP 能通且认出是 DSH（跑的是**对的**东西）
   * 只看①会误判"别的程序占了端口"为成功。
   *
   * @param {number} port
   * @returns {Promise<{ok:boolean, listening:boolean, http:boolean, status:number|null, evidence:string}>}
   */
  async verify(port) {
    const { listening } = await isPortListening(port);
    if (!listening) {
      return { ok: false, listening: false, http: false, status: null, evidence: '端口上没有任何服务在监听' };
    }

    const http = await probeDshHttp(port);
    return {
      ok: http.isDsh,
      listening: true,
      http: Boolean(http.status),
      status: http.status,
      evidence: http.evidence,
    };
  }
}

/**
 * 一个小 sleep —— 等待端口就绪时的轮询间隔
 * @param {number} ms
 * @returns {Promise<void>}
 */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export { which, readJsonSafe };
