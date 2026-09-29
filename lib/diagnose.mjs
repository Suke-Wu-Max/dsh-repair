/**
 * 故障诊断层（**纯判断，不动手**）
 * ============================================================
 * 这一层只回答两个问题：
 *   ① 到底哪儿坏了？
 *   ② 我能不能自动修？不能的话，用户该手动做什么？
 *
 * 🔴 两条设计原则，都很重要：
 *
 * 【原则一】宁可漏报，不可误报。
 *   尤其对"配置文件损坏"这一条：**误判的代价是工具去动一份本来好好的配置**
 *   （哪怕有备份，也是白白吓用户一跳 + 引入新风险）。
 *   所以这里对 YAML 只做**保守的结构检查**，只在拿到**铁证**时才判损坏；
 *   拿不准就报"疑似"，让用户自己确认。
 *
 * 【原则二】诊断要给出**优先级**，不是列一堆问题让用户自己挑。
 *   Node 版本太低的时候，后面那些"插件没装、端口没起来"全是**后果**不是原因 ——
 *   这时候跑去修插件是纯粹的浪费时间，还可能把好配置改坏。
 *   ⇒ 所以 diagnose() 返回一个 primary（主因）+ 若干 secondary（次因）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { versionGte, readTextSafe, truncate } from './util.mjs';

/* ── 故障类型字典 ─────────────────────────────────────────── */

/**
 * 故障类型枚举。
 *
 * 前 6 个是需求里点名的，后 3 个是**实测补出来的**（遇到真实场景才发现少了会漏判）：
 *   · PROFILE_NOT_WRITABLE —— 实测发现 DSH 启动时必然要写 profile 目录里的
 *     `cordis.yml`（`prepareProfile` 那一步），目录不可写就直接 EPERM 退出。
 *     这跟"插件没装"是完全不同的病，但现象一模一样：**服务起不来**。
 *   · PLUGIN_LINK_BROKEN —— 插件目录在、node_modules 里的 junction 断了。
 *     比"压根没装"更隐蔽（`ls` 看着像有）。
 *   · UNKNOWN —— 探测都正常但服务就是不上来，老实承认不知道，给排查指引。
 */
export const FAULT = {
  NODE_TOO_OLD: 'NODE_TOO_OLD',
  NPM_MISSING: 'NPM_MISSING',
  NPM_NOT_RUNNABLE: 'NPM_NOT_RUNNABLE',
  DSH_NOT_INSTALLED: 'DSH_NOT_INSTALLED',
  NO_PROFILE: 'NO_PROFILE',
  PROFILE_NOT_WRITABLE: 'PROFILE_NOT_WRITABLE',
  CONFIG_PATCH_BROKEN: 'CONFIG_PATCH_BROKEN',
  PLUGIN_LOAD_FAILED: 'PLUGIN_LOAD_FAILED',
  PORT_CONFLICT: 'PORT_CONFLICT',
  SERVICE_NOT_RUNNING: 'SERVICE_NOT_RUNNING',
  SERVICE_OK: 'SERVICE_OK',
  UNKNOWN: 'UNKNOWN',
};

/** 每种故障的中文人话说明 + 能不能自动修 + 修不了时的手动指引 */
export const FAULT_INFO = {
  [FAULT.NODE_TOO_OLD]: {
    title: 'Node.js 版本过低',
    detail: 'DSH 要求 Node.js ≥ 22.19.0，当前版本达不到。这不是"可能有问题"，是必然起不来。',
    autoFixable: false,
    manual: [
      '去 https://nodejs.org/ 下载 LTS 版（要 22.19.0 或更新的）并安装',
      '装完**必须新开一个终端**（旧终端里 PATH 还是老的），再运行 node -v 确认版本变了',
      '如果用 nvm / fnm 管理版本：nvm install 22 && nvm use 22',
    ],
  },
  [FAULT.NPM_MISSING]: {
    title: 'npm 没装',
    detail: '系统里找不到 npm 命令。npm 是随 Node.js 一起装的，所以这通常说明 Node.js 没装好。',
    autoFixable: false,
    manual: [
      '确认 Node.js 装好了（npm 是随 Node 一起装的）',
      'Windows 上如果报"无法加载脚本 npm.ps1"，那是 PowerShell 执行策略拦的，本工具已经绕开了；',
      '  但你手动敲 npm 时也可能撞上 —— 改用 npm.cmd，或者执行：',
      '  Set-ExecutionPolicy -Scope CurrentUser RemoteSigned',
      '重装 Node.js 也能修复 npm 丢失',
    ],
  },
  [FAULT.NPM_NOT_RUNNABLE]: {
    title: 'npm 跑不起来',
    detail:
      'npm 命令是存在的，但一执行就失败 —— 常见原因是权限不足、PowerShell 执行策略、' +
      '或被安全软件拦下。⚠️ 这跟"没装 npm"是两码事：本工具能绕开它继续修。',
    autoFixable: false,
    manual: [
      '它不影响"恢复配置备份、重建插件链接、启动服务"这些修复动作，只有需要联网装包时才受影响',
      '如果确实要装插件，请在另一个终端里手动执行：npm install -g <包名>',
      'Windows 报"无法加载脚本 npm.ps1"⇒ Set-ExecutionPolicy -Scope CurrentUser RemoteSigned',
      '如果是权限不足 ⇒ 用管理员/超级用户重试，或检查 npm 安装目录的权限',
    ],
  },
  [FAULT.DSH_NOT_INSTALLED]: {
    title: '找不到 DSH 本体',
    detail: '在当前机器上没能定位到 @deepseek-ai/dsh 的安装位置。',
    autoFixable: false,
    manual: [
      '如果 DSH 是全局装的：npm i -g @deepseek-ai/dsh',
      '如果是从源码/npx 跑的，用 --home <你的 DSH 目录> 明确告诉本工具它在哪',
      '确认环境变量 DSH_HOME 指向正确（当前值见上方环境信息）',
    ],
  },
  [FAULT.NO_PROFILE]: {
    title: '找不到任何 profile',
    detail: 'DSH 的 profiles 目录下没有可用的 profile，没有 profile 就没有可启动的东西。',
    autoFixable: false,
    manual: [
      'DSH 至少要有一个 profile 才能启动',
      '从自带模板新建一个：dsh --profile rescue --from-default-profile web',
      '或者用 --home 指定正确的 DSH 主目录',
    ],
  },
  [FAULT.PROFILE_NOT_WRITABLE]: {
    title: 'profile 目录没有写权限',
    detail:
      'DSH 每次启动都会往 profile 目录里写 cordis.yml（准备 profile 的那一步）。' +
      '目录不可写，启动会直接以 EPERM 退出 —— 现象和"插件坏了"一模一样，但病因完全不同。',
    autoFixable: false,
    manual: [
      '检查这个目录的权限，确认当前用户能写',
      'Windows：右键目录 → 属性 → 安全 → 给当前用户"修改"权限',
      'macOS / Linux：chown -R $(whoami) <目录> 或 chmod -R u+w <目录>',
      '如果目录在一个只读盘/网络盘上，换到本地盘',
    ],
  },
  [FAULT.CONFIG_PATCH_BROKEN]: {
    title: '配置文件损坏',
    detail: 'cordis.patch.yml 内容不合法，DSH 启动时会拒绝解析（failed to parse patches）。',
    autoFixable: true,
    manual: [
      '本工具可以从历史备份恢复',
      '恢复后请检查你最近手动改过的那几行',
      '注意 YAML 不能用 Tab 缩进，必须用空格',
    ],
  },
  [FAULT.PLUGIN_LOAD_FAILED]: {
    title: '插件加载失败',
    detail:
      'profiles 的配置文件里登记了某个插件，但它在 node_modules 里解析不到 —— ' +
      'DSH 启动时会报 ERR_MODULE_NOT_FOUND 并整个进程退出。',
    autoFixable: true,
    manual: [
      '本工具会优先尝试"把插件真正装回去"（重建链接 / 重新安装）',
      '修不好时会精确禁用出问题的那一个插件，其余插件不受影响',
      '最后手段才是安全模式（禁用全部用户插件）',
    ],
  },
  [FAULT.PORT_CONFLICT]: {
    title: '端口被占用',
    detail: '目标端口上有服务在监听，但它不是 DSH —— 说明被别的程序占了。',
    autoFixable: true,
    manual: [
      '本工具会找一个空闲端口，并用那个端口启动',
      '也可以自己指定：dsh-tudian --port 3900',
      '想找出占用者：Windows 用 netstat -ano | findstr :3080，macOS/Linux 用 lsof -i :3080',
    ],
  },
  [FAULT.SERVICE_NOT_RUNNING]: {
    title: '服务未启动',
    detail: '端口上没有服务在监听，而配置看起来是正常的 —— 那就是单纯没起来。',
    autoFixable: true,
    manual: ['本工具会直接帮你启动它', '也可以手动启动：dsh web'],
  },
  [FAULT.SERVICE_OK]: {
    title: '服务运行正常',
    detail: '探测到 DSH 正在运行且能正常响应。',
    autoFixable: false,
    manual: [],
  },
  [FAULT.UNKNOWN]: {
    title: '未能确定病因',
    detail: '各项检查都没发现明显问题，但服务确实没有起来。',
    autoFixable: false,
    manual: [
      '手动跑一次启动命令，把完整报错看全：dsh web',
      '把报错内容贴到本工具的日志文件旁边一起发出来',
      '常见情形：端口被防火墙拦、磁盘满、依赖装了但版本冲突',
    ],
  },
};

/* ── 启动输出解析 ─────────────────────────────────────────── */

/**
 * 从一行启动输出里认出"这是什么病"。
 *
 * 这个函数是整个工具**最有价值的一块** ——
 * 因为它读的是 DSH **亲口报的错**，而不是我们的猜测。
 * 只要能把启动输出抓到，诊断的准确率就远高于任何静态检查。
 *
 * @param {string} text 启动输出（stdout + stderr 拼起来）
 * @returns {{kind:string, missingPackages:string[], matchedLines:string[]}}
 */
export function parseStartupOutput(text) {
  const source = String(text || '');
  const lines = source.split(/\r?\n/);

  const missingPackages = [];
  const matchedLines = [];
  let kind = 'none';

  /** 按优先级依次识别（越靠前越具体） */
  const rules = [
    {
      // 最典型：登记了插件但包不在
      kind: 'module_not_found',
      test: (l) => /ERR_MODULE_NOT_FOUND/i.test(l) || /Cannot find package/i.test(l),
      extract: (l) => {
        const m = l.match(/Cannot find package\s+['"]([^'"]+)['"]/i);
        return m ? m[1] : null;
      },
    },
    {
      kind: 'plugin_load_failed',
      test: (l) => /plugin\(s\) failed to load/i.test(l) || /failed to load plugin/i.test(l),
    },
    {
      // 配置文件解析不了
      kind: 'patch_parse_error',
      test: (l) => /failed to parse patches/i.test(l) || /YAMLException/i.test(l) || /bad indentation/i.test(l),
    },
    {
      // 软件源/网络问题（装包时）
      kind: 'registry_error',
      test: (l) => /TAR_BAD_ARCHIVE/i.test(l) || /EINTEGRITY/i.test(l) || /ERR_SOCKET_TIMEOUT/i.test(l),
    },
    {
      kind: 'network_error',
      test: (l) => /ETIMEDOUT|ENOTFOUND|ECONNREFUSED|EAI_AGAIN|network/i.test(l),
    },
    {
      // 权限问题
      kind: 'permission_error',
      test: (l) => /EPERM|EACCES/i.test(l),
    },
    {
      // 端口被占
      kind: 'port_in_use',
      test: (l) => /EADDRINUSE|address already in use/i.test(l),
    },
  ];

  for (const rule of rules) {
    for (const line of lines) {
      if (!rule.test(line)) continue;
      if (kind === 'none') kind = rule.kind;
      matchedLines.push(line.trim());
      if (rule.extract) {
        const pkg = rule.extract(line);
        if (pkg && !missingPackages.includes(pkg)) missingPackages.push(pkg);
      }
    }
  }

  return {
    kind,
    missingPackages,
    // 去重 + 限量，报告里只展示几条关键行
    matchedLines: [...new Set(matchedLines)].slice(0, 5),
  };
}

/* ── 配置文件结构检查（保守） ─────────────────────────────── */

/**
 * 对 cordis.patch.yml 做**保守的**结构检查。
 *
 * 🔴 这里刻意不写完整的 YAML 解析器，理由：
 *   ① 完整解析要引 js-yaml，破坏"零依赖"；
 *   ② 自己手写的解析器必然和 DSH 用的真实解析器（js-yaml + `!!js` 标签）有偏差，
 *      那种"我解析通过了、DSH 却说不行"的假阴性比不做检查更坏 ——
 *      它会让用户以为配置没问题，从而往错误的方向排查。
 *   ⇒ 所以这里只报**铁证级**的问题：Tab 缩进、顶层不是数组、引号不配对。
 *     真正的语法诊断交给 dsh-fix doctor（它有跟 DSH 完全一致的解析器）。
 *
 * @param {string} text 配置文件内容
 * @returns {{broken:boolean, problems:string[]}}
 */
export function lintPatchFile(text) {
  const problems = [];

  if (text === null || text === undefined) {
    return { broken: false, problems: ['（配置内容读不到，跳过结构检查）'] };
  }

  const content = String(text);
  if (content.trim() === '') {
    // 空文件是合法的（等于没有任何用户层覆盖）
    return { broken: false, problems: [] };
  }

  const lines = content.split(/\r?\n/);

  // ① Tab 缩进 —— YAML 规范明确禁止，DSH 会直接解析失败
  const tabLine = lines.findIndex((l) => /^\s*\t/.test(l) || /^[^#]*:\s*\t/.test(l));
  if (tabLine >= 0) {
    problems.push(`第 ${tabLine + 1} 行用了 Tab 缩进；YAML 只允许空格缩进`);
  }

  // ② 顶层必须是数组（DSH 的 patch 层是一个 top-level YAML 数组）
  const firstMeaningful = lines.find((l) => l.trim() !== '' && !l.trim().startsWith('#'));
  if (firstMeaningful !== undefined && !firstMeaningful.trim().startsWith('-')) {
    problems.push(`文件第一行有效内容不是 "- " 开头，但 DSH 的 patch 层要求顶层是数组`);
  }

  // ③ 引号不配对（只在同一行内检查，避免跨行误判）
  lines.forEach((line, i) => {
    // 先剥掉注释 —— 但**不能**简单粗暴地用 `#.*$` 去切：
    // 引号里的 `#` 不是注释（比如 url: 'http://x/#y'），粗暴切会把引号切掉一半，
    // 于是"引号没闭合"就会**误报**，进而把一份好配置判成坏的。
    // （这就是"宁可漏报不可误报"在代码里的样子。）
    let body = '';
    let inSingle = false;
    let inDouble = false;
    for (let k = 0; k < line.length; k++) {
      const ch = line[k];
      if (ch === "'" && !inDouble) inSingle = !inSingle;
      else if (ch === '"' && !inSingle) inDouble = !inDouble;
      // YAML 规范：`#` 只有在行首或前面是空白时才算注释开始
      else if (ch === '#' && !inSingle && !inDouble && (k === 0 || /\s/.test(line[k - 1]))) break;
      body += ch;
    }

    const singles = (body.match(/'/g) || []).length;
    const doubles = (body.match(/"/g) || []).length;
    if (singles % 2 !== 0) problems.push(`第 ${i + 1} 行的单引号没有闭合`);
    if (doubles % 2 !== 0) problems.push(`第 ${i + 1} 行的双引号没有闭合`);
  });

  // ④ 最后一行的结构：如果一个 "key:" 后面什么都没有就结束了，多半是被截断了
  const lastMeaningful = [...lines].reverse().find((l) => l.trim() !== '' && !l.trim().startsWith('#'));
  if (lastMeaningful && /^[\s-]*[A-Za-z_][\w.-]*:\s*$/.test(lastMeaningful)) {
    problems.push(`文件最后一行是 "${lastMeaningful.trim()}"，冒号后面没有内容 —— 像是写入被中断了`);
  }

  // 只在拿到**铁证**（引号不配对 / Tab 缩进 / 顶层结构错）时才判"损坏"；
  // 第 ④ 条是"疑似"，单独提示但不足以判定损坏（避免误报去动好配置）。
  const hardEvidence = problems.some(
    (p) => p.includes('Tab 缩进') || p.includes('顶层是数组') || p.includes('没有闭合'),
  );

  return { broken: hardEvidence, problems };
}

/* ── 写权限粗判 ───────────────────────────────────────────── */

/**
 * 粗判目录能不能写。
 *
 * ⚠️ 这只是**粗判**：POSIX 权限位只能说明"位是这么写的"，
 * Windows 的 ACL 更复杂（access 说可写、实际写入仍可能被拒）。
 * ⇒ 所以这里的结果只作参考，**真正的写权限验证要等到修复阶段
 *   真去写一个临时文件**才知道（那属于"动手"，不属于"只读探测"）。
 *
 * 🔴 必须区分"目录不存在"和"目录没权限" —— 这是两种完全不同的病，
 *   报混了就会把用户引去改一个根本不存在的目录的权限。
 *   （这是测试真跑出来的：假路径被判成了"没有写权限"。）
 *   ⇒ ENOENT 返回 null（"不知道"，不触发权限故障），
 *     只有 EACCES / EPERM 才返回 false。
 *
 * @param {string} dir
 * @returns {{writable:boolean|null, note:string}}
 */
export function checkWritable(dir) {
  if (!dir) return { writable: null, note: '目录未知' };

  try {
    fs.accessSync(dir, fs.constants.W_OK);
    return { writable: true, note: '权限位显示可写（仅供参考）' };
  } catch (err) {
    const code = err && err.code ? err.code : '';
    if (code === 'ENOENT') {
      // 目录压根不在 —— 这不是权限问题，别往那个方向引
      return { writable: null, note: '目录不存在（不是权限问题）' };
    }
    return { writable: false, note: `权限检查未通过：${code || (err && err.message) || '未知原因'}` };
  }
}

/* ── 主诊断 ───────────────────────────────────────────────── */

/**
 * 根据探测结果判定故障。
 *
 * @param {object} env probeAll() 的返回值
 * @param {object} [opts]
 * @param {string} [opts.startupOutput] 如果调用方已经抓到过启动输出，传进来（证据最硬）
 * @returns {{
 *   primary: {type:string, info:object, evidence:string[]},
 *   secondary: Array<{type:string, info:object, evidence:string[]}>,
 *   startup:{kind:string, missingPackages:string[], matchedLines:string[]}|null,
 *   summary:string
 * }}
 */
export function diagnose(env, opts = {}) {
  const secondary = [];
  const startup = opts.startupOutput ? parseStartupOutput(opts.startupOutput) : null;

  /**
   * 造一条诊断记录
   * @param {string} type
   * @param {string[]} evidence
   */
  const make = (type, evidence) => ({ type, info: FAULT_INFO[type], evidence });

  /* ── 前置条件：不满足的话，后面全是后果，不用再查 ── */

  // ① Node 版本
  if (!env.node.meetsDsh) {
    return finalize(
      make(FAULT.NODE_TOO_OLD, [
        `当前 Node.js 版本：${env.node.version}`,
        `DSH 要求：>= ${env.node.required}`,
        '注意：本工具本身能在 Node 18 上跑，就是为了在这种情况下还能告诉你这句话',
      ]),
      secondary,
      startup,
    );
  }

  // ② npm
  //    ⚠️ 这里必须把两种情况**分开**（实测踩过，而且踩得很典型）：
  //      · 命令**根本不存在** → 硬伤，只能让用户去装 Node.js，直接返回
  //      · 命令存在但**跑不起来**（权限 / 执行策略 / 沙箱拦截）→ 这只是
  //        "联网装包"这条路走不通，但恢复备份、重建插件链接、启动服务
  //        **一个都不需要 npm**，照样能修好！
  //        ⇒ 记成次要问题继续往下走，✗ 绝不能一上来就把整条流程掐死。
  //    （实测：受限环境里 npm 会以 EPERM 失败，但那台机器 npm 装得好好的。
  //      当时如果判定成"npm 不可用"并终止，就等于对着一个假问题给用户开药方。）
  if (!env.npm.exists) {
    return finalize(
      make(FAULT.NPM_MISSING, [
        '系统里找不到 npm 命令',
        'npm 是随 Node.js 一起安装的，所以通常说明 Node.js 没装好',
      ]),
      secondary,
      startup,
    );
  }

  if (!env.npm.runnable) {
    secondary.push(
      make(FAULT.NPM_NOT_RUNNABLE, [
        `npm 命令确实存在：${env.npm.path || '（路径未知）'}`,
        `但一执行就失败：${env.npm.error || '原因未知'}`,
        '这不影响恢复配置备份、重建插件链接、启动服务 —— 只有需要联网装包的那一步会受影响',
      ]),
    );
  }

  // ③ DSH 本体
  if (!env.install.found) {
    return finalize(
      make(FAULT.DSH_NOT_INSTALLED, [
        `尝试过的位置都落空了，共查了 ${env.install.candidates.length} 处`,
        ...env.install.candidates.slice(0, 4).map((c) => `  · ${c.source}：${c.path}`),
      ]),
      secondary,
      startup,
    );
  }

  // ④ profile
  if (!env.profile) {
    return finalize(
      make(FAULT.NO_PROFILE, [`profiles 目录下一共找到 ${env.profiles.length} 个候选项，没有一个可用`]),
      secondary,
      startup,
    );
  }

  /* ── 逐步收紧 ── */

  // ⑤ profile 目录写权限（DSH 启动时必须能写 cordis.yml）
  const writable = checkWritable(env.profile.dir);
  if (writable.writable === false) {
    return finalize(
      make(FAULT.PROFILE_NOT_WRITABLE, [
        `profile 目录：${env.profile.dir}`,
        writable.note,
        '实测：DSH 启动时会往这个目录写 cordis.yml，不写就会被拒绝',
      ]),
      secondary,
      startup,
    );
  }

  // ⑥ 配置文件损坏
  const patchText = env.profile.hasPatch ? readTextSafe(env.profile.patchFile) : null;
  const lint = lintPatchFile(patchText);
  if (lint.broken) {
    const evidence = [...lint.problems];
    if (env.profile.backups.length > 0) {
      evidence.push(`发现 ${env.profile.backups.length} 份历史备份，最新一份：${path.basename(env.profile.backups[0].file)}`);
    } else {
      evidence.push('⚠️ 没有找到任何历史备份');
    }
    return finalize(make(FAULT.CONFIG_PATCH_BROKEN, evidence), secondary, startup);
  }

  // ⑦ 插件加载失败
  //    证据有两路，任一成立即可：
  //      a. 静态：配置里登记的插件在 node_modules 里解析不到
  //      b. 动态：启动输出里明确说了 Cannot find package 'X'
  const missingPlugins = env.pluginEntries.entries.filter((e) => !e.installed);

  if (startup && startup.missingPackages.length > 0) {
    // 动态证据最硬 —— 如果它点名的包不在静态结果里，也照样采纳
    const named = startup.missingPackages.filter(
      (pkg) => !missingPlugins.some((p) => p.name === pkg),
    );
    const evidence = [
      `DSH 启动输出里明确报出：Cannot find package '${startup.missingPackages.join("', '")}'`,
      ...startup.matchedLines.map((l) => `  ${truncate(l, 160)}`),
    ];
    if (named.length > 0) evidence.push(`（这几个包在配置里没有登记项，可能是被别的插件依赖的）`);

    return finalize(make(FAULT.PLUGIN_LOAD_FAILED, evidence), secondary, startup, {
      missingPlugins: missingPlugins.length > 0 ? missingPlugins : startup.missingPackages.map((p) => ({ name: p, installed: false, linkBroken: false, resolvedFrom: '' })),
    });
  }

  if (missingPlugins.length > 0) {
    const evidence = missingPlugins.map((p) =>
      p.linkBroken
        ? `插件 "${p.name}"（id: ${p.id || '未标注'}）在 node_modules 里**链接已断**：${p.resolvedFrom}`
        : `插件 "${p.name}"（id: ${p.id || '未标注'}）**没有安装**：在 profile 的 node_modules 里找不到`,
    );
    return finalize(make(FAULT.PLUGIN_LOAD_FAILED, evidence), secondary, startup, { missingPlugins });
  }

  // 到这里，插件和配置都没问题。剩下的分歧点是"端口"。
  const { activePort, listening, dshRunning } = env.ports;

  if (activePort !== null && dshRunning.length > 0) {
    // 服务在跑 → 正常
    const evidence = [
      `端口 ${activePort} 上有服务，HTTP ${env.ports.checks.find((c) => c.port === activePort)?.status ?? '—'}`,
      `判定依据：${env.ports.activeSource}`,
    ];

    // ⚠️ 用户明确指定了端口，但 DSH 实际跑在**别的**端口上 —— 这件事**必须说出来**。
    //   不说的话会严重误导：实测 `--port 8000` 时工具报"一切正常"，
    //   但 8000 上其实是别的程序，DSH 在 3080 ——
    //   用户以为自己指定的那个端口没事，而事实跟他的意图完全对不上。
    const requested = env.ports.requestedPort;
    if (requested && requested !== activePort) {
      evidence.push(
        `⚠️ 你指定的是端口 ${requested}，但 DSH 实际跑在 ${activePort} 上。` +
          `想让 DSH 换到 ${requested}，得先停掉当前这个实例再重新启动。`,
      );
    }

    return finalize(make(FAULT.SERVICE_OK, evidence), secondary, startup);
  }

  // 🔴 只在"我们**打算用的那个**端口"被非 DSH 占用时，才算端口冲突。
  //
  //   为什么不能看"有没有任何端口被占"：用户机器上跑着别的本地服务太正常了
  //   —— 打印控件、数据库、别的开发服务器……把它们一律报成"端口冲突"，
  //   既是纯粹的噪音，又会把用户带偏。
  //   （实测：这台机器 8000 端口上是 C-Lodop 打印服务，跟 DSH 一点关系都没有。）
  const targetPort = env.ports.preferredPort;
  const targetCheck = env.ports.checks.find((c) => c.port === targetPort);

  if (targetCheck && targetCheck.listening && !targetCheck.isDsh) {
    const others = listening.filter((c) => c.port !== targetPort);
    return finalize(
      make(FAULT.PORT_CONFLICT, [
        `打算用的端口 ${targetPort} 上有别的程序在监听（${targetCheck.evidence || 'HTTP 无响应'}）`,
        '它不是 DSH —— DSH 自己占不上这个端口，就会启动失败',
        ...(others.length > 0
          ? [`（另外 ${others.length} 个候选端口也被占用，但那些跟本次无关，不影响修复）`]
          : []),
      ]),
      secondary,
      startup,
    );
  }

  // 端口全空 + 配置正常 + 插件正常 ⇒ 单纯没启动
  if (startup && startup.kind !== 'none') {
    // 但我们抓到过启动报错，那说明启动**尝试过并失败了**，
    // 而且失败原因不是上面任何一种 —— 老实说不确定，别硬猜。
    return finalize(
      make(FAULT.UNKNOWN, [
        `静态检查都正常，但启动尝试失败，输出里出现：${startup.matchedLines[0] || startup.kind}`,
        `识别出的错误类型：${startup.kind}`,
      ]),
      secondary,
      startup,
    );
  }

  return finalize(
    make(FAULT.SERVICE_NOT_RUNNING, [
      `候选端口（${env.ports.candidates.slice(0, 6).join(', ')}…）上都没有服务在监听`,
      '配置文件存在且结构检查通过',
      `登记的 ${env.pluginEntries.entries.length} 个插件都能解析到`,
    ]),
    secondary,
    startup,
  );
}

/**
 * 统一出口：把 primary / secondary 包成一致的形状。
 * @param {object} primary
 * @param {object[]} secondary
 * @param {object|null} startup
 * @param {object} [extra] 额外上下文（比如具体是哪些插件坏了，修复时要用来定位）
 * @returns {object}
 */
function finalize(primary, secondary, startup, extra = {}) {
  const parts = [primary.info.title];
  if (secondary.length > 0) parts.push(`另有 ${secondary.length} 项次要问题`);

  return {
    primary: { ...primary, ...extra },
    secondary,
    startup,
    summary: parts.join(' · '),
  };
}

export { versionGte };
