#!/usr/bin/env node
/**
 * dsh-tudian · 命令行入口
 * ============================================================
 * 一条命令跑完：探测 → 诊断 → 修复 → 验证 → 报告。
 *
 * 关于参数解析：**刻意手写，没有用 node:util 的 parseArgs**。
 * 原因：parseArgs 是 Node 18.3 才有的，而本工具要能在更老的 Node 上
 * **至少跑起来并告诉用户"你的 Node 太老了"** ——
 * 如果一开始就 import 一个高版本才有的 API，用户看到的就是一句
 * 莫名其妙的 ERR_MODULE_NOT_FOUND/not a function，而不是人话。
 * （这就是所谓"打不开的说明书"问题，见 probe.mjs 里的同一段说明。）
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * 读自己的 package.json（拿版本号给 --version 用）
 * @returns {{name:string, version:string}}
 */
function readOwnPackage() {
  try {
    const file = path.join(__dirname, '..', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { name: pkg.name || 'dsh-tudian', version: pkg.version || '0.0.0' };
  } catch {
    return { name: 'dsh-tudian', version: '0.0.0' };
  }
}

const pkg = readOwnPackage();

/** 帮助文本 */
const HELP = `
dsh-tudian · DSH 启动失败修复工具  v${pkg.version}

  当 DeepSeek Harness 因为插件加载失败、配置损坏、端口被占、Node 版本过低
  等原因起不来时，跑这一条命令，它会自动查清楚并把能修的都修好。

用法
  npx dsh-tudian                     # 探测 + 诊断 + 自动修复
  npx dsh-tudian --dry-run           # 只看问题在哪，一个字节都不改（推荐先跑一次）
  npx dsh-tudian --yes               # 全程不询问，一路自动执行

参数
  --dry-run              只检测不修复。**只读**，不写任何文件
  --yes, -y              所有需要确认的地方自动答"是"
  --port <端口>          指定端口（不指定则自动探测 3080 / 9800 / 7860 等）
  --home <路径>          指定 DSH 主目录（默认读环境变量 DSH_HOME，再默认 ~/.dsh）
  --profile <名字>       指定要处理的 profile（默认优先 web）
  --verbose, -v          多打细节（原始命令、完整输出）
  --quiet, -q            只打结果，不打过程
  --no-color             关掉彩色输出（重定向到文件时本来就自动关）
  --log <路径>           指定日志文件位置（默认当前目录 dsh-tudian-log.txt）
  --persist-registry     允许改**全局** npm 源配置（默认不改，只在装包时临时用）
  --help, -h             显示这份帮助
  --version, -V          显示版本号

它到底会动什么（这是最该看的一段）
  只检测模式（--dry-run）：什么都不动。
  正常模式，按故障类型，最多动这几样：
    · 备份你改过的配置文件（命名 xxx.bak-<时间戳>，跟 DSH 自己的一致）
    · 修复配置文件损坏时，从历史备份恢复（恢复前连"当前状态"也会再备份一份）
    · 插件坏了：优先**把插件真正修好**（重建 node_modules 里的链接 / 重新安装）
    · 修不好才停用出问题的那个插件（用 DSH 原生的 disabled 补丁，原内容不动）
    · 最后手段才进入安全模式（全部用户插件停用），而且默认**不**执行，要你点头
    · 端口被占：换一个空闲端口启动

  它**从不删除**你的任何文件、插件目录或数据。

退出码
  0  成功 / 本来就正常 / 你主动取消了
  2  没能修好（报告里会给出具体的手动步骤）
  130 你按了 Ctrl+C
`;

/**
 * 解析命令行参数。
 *
 * 支持 `--port 3080` 和 `--port=3080` 两种写法（用户两种都爱用）。
 *
 * @param {string[]} argv
 * @returns {{options:object, action:'run'|'help'|'version', unknown:string[]}}
 */
function parseArgs(argv) {
  const options = {
    dryRun: false,
    yes: false,
    verbose: false,
    quiet: false,
    noColor: false,
    persistRegistry: false,
    port: undefined,
    home: undefined,
    profile: undefined,
    logFile: undefined,
  };

  const unknown = [];
  let action = 'run';

  for (let i = 0; i < argv.length; i++) {
    let token = argv[i];
    let inlineValue = null;

    // 拆 --key=value
    if (token.startsWith('--') && token.includes('=')) {
      const idx = token.indexOf('=');
      inlineValue = token.slice(idx + 1);
      token = token.slice(0, idx);
    }

    /** 取这个参数的值：优先用 = 后面的，否则吃掉下一个 token */
    const takeValue = () => {
      if (inlineValue !== null) return inlineValue;
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('-')) return null;
      i++;
      return next;
    };

    switch (token) {
      case '--dry-run':
      case '--dryrun':
        options.dryRun = true;
        break;
      case '--yes':
      case '-y':
        options.yes = true;
        break;
      case '--verbose':
      case '-v':
        options.verbose = true;
        break;
      case '--quiet':
      case '-q':
        options.quiet = true;
        break;
      case '--no-color':
        options.noColor = true;
        break;
      case '--persist-registry':
        options.persistRegistry = true;
        break;
      case '--port': {
        const v = takeValue();
        const n = Number(v);
        if (!Number.isInteger(n) || n < 1 || n > 65535) {
          unknown.push(`--port 的值不合法：${v === null ? '(空)' : v}（应该是 1-65535 的整数）`);
        } else {
          options.port = n;
        }
        break;
      }
      case '--home': {
        const v = takeValue();
        if (!v) unknown.push('--home 后面没有跟路径');
        else options.home = path.resolve(v);
        break;
      }
      case '--profile': {
        const v = takeValue();
        if (!v) unknown.push('--profile 后面没有跟名字');
        else options.profile = v;
        break;
      }
      case '--log': {
        const v = takeValue();
        if (!v) unknown.push('--log 后面没有跟路径');
        else options.logFile = path.resolve(v);
        break;
      }
      case '--help':
      case '-h':
        action = 'help';
        break;
      case '--version':
      case '-V':
        action = 'version';
        break;
      default:
        if (token.startsWith('-')) unknown.push(token);
        // 非选项参数（裸词）直接忽略 —— 有些包装脚本会顺手传进来
        break;
    }
  }

  return { options, action, unknown };
}

/**
 * 主函数
 */
async function main() {
  const { options, action, unknown } = parseArgs(process.argv.slice(2));

  if (action === 'help') {
    process.stdout.write(HELP + '\n');
    return 0;
  }

  if (action === 'version') {
    process.stdout.write(`${pkg.name} ${pkg.version}  (Node ${process.version})\n`);
    return 0;
  }

  // 认不出来的参数要说一声，但别拦着不让跑（用户可能用的是老版本的参数名）
  if (unknown.length > 0) {
    process.stderr.write(`⚠️  没能识别的参数：${unknown.join(' ')}\n`);
    process.stderr.write(`   用 dsh-tudian --help 看看有哪些参数。\n\n`);
  }

  // Node 版本护栏：本工具自己 >= 18 就行（见文件顶部的说明）
  const major = parseInt(process.version.replace(/^v/, '').split('.')[0], 10) || 0;
  if (major < 18) {
    process.stderr.write(
      `\n✗ 本工具需要 Node.js 18 或更高版本，当前是 ${process.version}。\n` +
        `  请先升级 Node.js：https://nodejs.org/\n` +
        `  （顺带一提：DSH 本身要求 >= 22.19.0，所以你多半也得升到那个版本才行。）\n\n`,
    );
    return 2;
  }

  // 真正干活 —— 动态 import 一下，这样上面那些版本护栏能先生效
  const { runFlow } = await import('../lib/flow.mjs');

  try {
    const result = await runFlow(options);
    return result.exitCode;
  } catch (err) {
    // 顶层兜底：任何没预料到的异常都不能以"一堆英文栈"结束，
    // 用户看不懂栈，他需要知道的是"下一步干什么"。
    process.stderr.write('\n');
    process.stderr.write('✗ 工具内部出错了（这不是你的操作问题，是工具的 bug）。\n');
    process.stderr.write(`  错误：${err && err.message ? err.message : String(err)}\n`);
    if (options.verbose && err && err.stack) {
      process.stderr.write(String(err.stack) + '\n');
    }
    process.stderr.write('\n');
    process.stderr.write('  请把上面这段连同日志文件一起发出来，好定位问题。\n');
    process.stderr.write('  日志文件默认在：' + (options.logFile || path.join(process.cwd(), 'dsh-tudian-log.txt')) + '\n\n');
    return 3;
  }
}

// 跑起来，并把退出码如实交给 shell（这样别人才能在脚本里判断成败）
main().then(
  (code) => {
    process.exit(code);
  },
  (err) => {
    process.stderr.write(`致命错误：${err && err.message ? err.message : String(err)}\n`);
    process.exit(3);
  },
);
