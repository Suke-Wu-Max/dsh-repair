/**
 * 诊断逻辑的独立测试
 * ============================================================
 * 这里测的是整个工具里**最容易出错、后果也最严重**的两块：
 *
 *   ① `lintPatchFile` —— 判"配置文件是不是坏了"
 *      ⚠️ 它的假阳性代价极大：会把**一份好配置**判成坏的，
 *         然后工具就会去拿备份覆盖它。所以测试的重心是**正常文件绝不能误报**，
 *         而不是"坏文件能不能查出来"。
 *
 *   ② `parseStartupOutput` —— 从 DSH 的启动输出里认出病因
 *      这是全套诊断里**证据最硬**的一环（DSH 亲口报的错），
 *      也是最值钱的一块，退化了就没人能替代它。
 *
 * 跑法：node _tools/test-diagnose.mjs
 */

import { lintPatchFile, parseStartupOutput, diagnose } from '../lib/diagnose.mjs';

let passed = 0;
let failed = 0;

/**
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

/* ══════════════════════════════════════════════════════════
 * 一、lintPatchFile：正常文件**绝不能**误报
 * ══════════════════════════════════════════════════════════ */
console.log('\n一、正常配置不该被误判（假阳性测试 —— 这是最要紧的一组）');

/** 每个用例：[说明, 内容] */
const goodFiles = [
  ['空文件（等于没有任何用户层覆盖，合法）', ''],
  ['只有空白', '   \n\n  \n'],
  ['只有注释', '# 这是注释\n# 又一行注释\n'],
  ['最小合法结构', "- insert:\n    - id: a\n      name: 'x'\n"],
  [
    '多插件 + 注释混排',
    [
      '# Your patch layer for this dsh profile',
      '- insert:',
      '    - id: dsh-zh',
      "      name: 'deepseek-harness-zh-cn'",
      '    # 工作台',
      '    - id: workbench',
      "      name: 'dsh-workbench'",
      '',
    ].join('\n'),
  ],
  ['中文内容', "- insert:\n    - id: 工作台\n      name: '我的插件'\n"],
  ['双引号字符串', '- insert:\n    - id: "a"\n      name: "b"\n'],
  ['注释里带不配对的引号', "- id: 'a'\n  name: 'b'   # 这里有个孤立的 ' 引号\n"],
  ['URL 里带井号（不能被当成注释）', "- id: 'a'\n  url: 'http://example.com/x/#y'\n"],
  ['注释里带井号', "- id: 'a'   # 见 http://x/#y 这个说明\n"],
  ['!!js 表达式', "- insert:\n    - id: a\n      name: !!js require('x')()\n"],
  ['冒号后跟内容（不是截断）', "- id: 'a'\n  config: {a: 1, b: 2}\n"],
  ['数组里嵌套对象', "- id: a\n  config:\n    deep:\n      deeper: 1\n"],
  ['末尾有空行', "- insert:\n    - id: a\n      name: 'x'\n\n\n"],
  ['行尾注释带引号', "- id: 'a' # 别管这个 '\n"],
];

for (const [label, content] of goodFiles) {
  const r = lintPatchFile(content);
  check(`不误报：${label}`, r.broken === false, `被判定为损坏，问题：${r.problems.join('；')}`);
}

/* ══════════════════════════════════════════════════════════
 * 二、lintPatchFile：真坏了的必须查出来
 * ══════════════════════════════════════════════════════════ */
console.log('\n二、真损坏的配置必须被查出来');

const badFiles = [
  ['Tab 缩进（YAML 明令禁止）', "- insert:\n\t- id: a\n"],
  ['顶层不是数组', "insert:\n  - id: a\n"],
  ['单引号没闭合', "- insert:\n    - id: a\n      name: 'oops\n"],
  ['双引号没闭合', '- insert:\n    - id: a\n      name: "oops\n'],
];

for (const [label, content] of badFiles) {
  const r = lintPatchFile(content);
  check(`能查出：${label}`, r.broken === true, `没查出来（problems=${JSON.stringify(r.problems)}）`);
}

/* ══════════════════════════════════════════════════════════
 * 三、parseStartupOutput：认启动输出里的病因
 * ══════════════════════════════════════════════════════════ */
console.log('\n三、从 DSH 启动输出里认出病因');

// 1. 最典型的那一个 —— 也是本工具诞生的原因
const m1 = parseStartupOutput(
  [
    'node:internal/modules/esm/resolve:275',
    "Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'dsh-say' imported from /home/u/.dsh/profiles/web/cordis.yml",
    '    at packageResolve (node:internal/modules/esm/resolve:873:9)',
  ].join('\n'),
);
check('认出 ERR_MODULE_NOT_FOUND', m1.kind === 'module_not_found', `实际 kind=${m1.kind}`);
check('提取出缺的包名 dsh-say', m1.missingPackages.includes('dsh-say'), JSON.stringify(m1.missingPackages));
check('保留了原始报错行', m1.matchedLines.length > 0);

// 2. 双引号形态的包名也要认
const m2 = parseStartupOutput('Error: Cannot find package "some-plugin"');
check('双引号包名也能提取', m2.missingPackages.includes('some-plugin'), JSON.stringify(m2.missingPackages));

// 3. 配置解析失败
const m3 = parseStartupOutput('dsh: failed to parse patches: bad indentation of a mapping entry');
check('认出配置解析失败', m3.kind === 'patch_parse_error', `实际 kind=${m3.kind}`);

// 4. 插件加载失败（泛化形态）
const m4 = parseStartupOutput('plugin(s) failed to load: dsh-workbench');
check('认出插件加载失败', m4.kind === 'plugin_load_failed', `实际 kind=${m4.kind}`);

// 5. 装包时的坏档
const m5 = parseStartupOutput('npm error code TAR_BAD_ARCHIVE\nnpm error tarball data seems corrupted');
check('认出 TAR_BAD_ARCHIVE', m5.kind === 'registry_error', `实际 kind=${m5.kind}`);

// 6. 端口被占
const m6 = parseStartupOutput('Error: listen EADDRINUSE: address already in use 127.0.0.1:3080');
check('认出端口占用', m6.kind === 'port_in_use', `实际 kind=${m6.kind}`);

// 7. 权限问题
const m7 = parseStartupOutput(
  "Error: EPERM: operation not permitted, open '/home/u/.dsh/profiles/web/cordis.yml'",
);
check('认出权限问题', m7.kind === 'permission_error', `实际 kind=${m7.kind}`);

// 8. 正常输出不该误报
const m8 = parseStartupOutput('dsh web listening on http://127.0.0.1:3080\nready');
check('正常输出不误报（kind=none）', m8.kind === 'none', `实际 kind=${m8.kind}`);
check('正常输出没有凭空造出包名', m8.missingPackages.length === 0);

// 9. 空输入不该炸
const m9 = parseStartupOutput('');
check('空输入不抛异常', m9.kind === 'none' && m9.missingPackages.length === 0);

/* ══════════════════════════════════════════════════════════
 * 四、diagnose() 的故障分支判定（纯逻辑，不依赖真实环境）
 * ══════════════════════════════════════════════════════════ */
console.log('\n四、故障分支判定（纯逻辑）');
console.log('   为什么要有这一组：有些分支在真机上根本走不到 ——');
console.log('   比如"端口冲突"要求"没有任何 DSH 在跑"，而开发这台机器上 DSH 正开着，');
console.log('   总不能为了让测试跑通就把用户的服务停掉。');

/**
 * 造一份"看起来一切正常"的探测结果，用例只覆盖自己关心的那几个字段。
 * @param {object} [patch]
 * @returns {object}
 */
function makeEnv(patch = {}) {
  const base = {
    os: { platform: 'win32', platformName: 'Windows', arch: 'x64', release: '10.0', versionName: 'Windows 11', isWindows: true, isMac: false, isLinux: false },
    node: { version: 'v22.19.0', major: 22, path: '/node', required: '22.19.0', meetsDsh: true, satisfiesTool: true },
    npm: { exists: true, runnable: true, available: true, version: '10.0.0', path: '/npm', error: null, registry: 'https://registry.npmjs.org/', registryError: null },
    home: { home: '/u/.dsh', source: '默认位置', exists: true },
    // ⚠️ dir 用 process.cwd()（真实存在且可写）：目录权限检查是真的去问文件系统的，
    //    这里如果填一个不存在的假路径，就会命中"目录有问题"的分支、
    //    把真正要测的东西掩盖掉。（第一版就是这么写的，当场被测试自己抓出来了。）
    profiles: [{ name: 'web', dir: process.cwd(), hasPatch: true, patchFile: '/u/.dsh/profiles/web/cordis.patch.yml', hasPackageJson: true, backups: [] }],
    install: { found: true, path: '/dsh', version: '0.1.5', source: 'test', candidates: [] },
    command: { available: true, shim: '/dsh', entry: '/dsh/lib/bin.js' },
    ports: { candidates: [3080], checks: [], listening: [], dshRunning: [], activePort: null, activeSource: null, requestedPort: null, preferredPort: 3080, envUrl: null },
    pluginEntries: { entries: [], parseWarning: null },
    logs: [],
    probedAt: '',
  };

  const merged = { ...base, ...patch };
  // 这几个是嵌套对象，必须按字段合并 —— 否则用例里写 {node:{meetsDsh:false}}
  // 会把整个 node 对象换掉，反而丢了 required 之类的字段。
  for (const key of ['os', 'node', 'npm', 'home', 'install', 'command', 'ports', 'pluginEntries']) {
    merged[key] = { ...base[key], ...(patch[key] || {}) };
  }
  // profile 允许显式传 null（用来测"没有 profile"）
  if (!('profile' in patch)) merged.profile = base.profiles[0];
  return merged;
}

/** 造一个"插件登记了但没装"的条目 */
const missingEntry = { id: 'a', name: 'ghost-plugin', installed: false, linkBroken: false, resolvedFrom: '' };

/** 造一个"打算用的端口被非 DSH 占着"的探测结果 */
const busyPort = {
  listening: [{ port: 3080, listening: true, isDsh: false, status: 200, evidence: 'HTTP 200' }],
  checks: [{ port: 3080, listening: true, isDsh: false, status: 200, evidence: 'HTTP 200' }],
  dshRunning: [],
  preferredPort: 3080,
};

/** 造一个"DSH 正跑着"的探测结果 */
const runningPort = {
  listening: [{ port: 3080, listening: true, isDsh: true, status: 401, evidence: 'DSH 标识' }],
  checks: [{ port: 3080, listening: true, isDsh: true, status: 401, evidence: 'DSH 标识' }],
  dshRunning: [{ port: 3080, listening: true, isDsh: true, status: 401 }],
  activePort: 3080,
  activeSource: '测试构造',
  preferredPort: 3080,
};

const cases = [
  ['Node 版本太低', makeEnv({ node: { version: 'v18.20.0', meetsDsh: false } }), 'NODE_TOO_OLD'],
  ['npm 压根不存在', makeEnv({ npm: { exists: false, runnable: false } }), 'NPM_MISSING'],
  ['找不到 DSH 本体', makeEnv({ install: { found: false } }), 'DSH_NOT_INSTALLED'],
  ['没有可用 profile', makeEnv({ profile: null, profiles: [] }), 'NO_PROFILE'],
  ['插件登记了但没装', makeEnv({ pluginEntries: { entries: [missingEntry], parseWarning: null } }), 'PLUGIN_LOAD_FAILED'],
  ['打算用的端口被别的程序占', makeEnv({ ports: busyPort }), 'PORT_CONFLICT'],
  ['端口全空、配置正常', makeEnv(), 'SERVICE_NOT_RUNNING'],
  ['DSH 正跑着', makeEnv({ ports: runningPort }), 'SERVICE_OK'],
];

for (const [label, env, expected] of cases) {
  const d = diagnose(env);
  check(`判定：${label} → ${expected}`, d.primary.type === expected, `实际是 ${d.primary.type}`);
}

/* ── 几个"绝不能搞错"的边界 ── */

// npm 跑不起来**不能**掐断整个流程：恢复备份/建链接/启服务都不需要 npm
const npmBroken = diagnose(makeEnv({ npm: { exists: true, runnable: false, error: 'EPERM' } }));
check(
  'npm 跑不起来时仍然继续诊断（没被误报成"npm 没装"）',
  npmBroken.primary.type !== 'NPM_MISSING',
  `实际判成了 ${npmBroken.primary.type}`,
);
check(
  'npm 跑不起来被记为次要问题',
  npmBroken.secondary.some((s) => s.type === 'NPM_NOT_RUNNABLE'),
  `次要问题：${npmBroken.secondary.map((s) => s.type).join(',') || '（空）'}`,
);

// 优先级：Node 太老的时候，不该跑去报"插件没装"（那只是后果）
const priority = diagnose(
  makeEnv({
    node: { version: 'v16.0.0', meetsDsh: false },
    pluginEntries: { entries: [missingEntry], parseWarning: null },
  }),
);
check('优先级：Node 太老时先报 Node，不报插件', priority.primary.type === 'NODE_TOO_OLD', `实际 ${priority.primary.type}`);

// 启动输出点名缺包 → 即使静态检查没看出来，也要采纳这个更硬的证据
const fromStartup = diagnose(makeEnv(), {
  startupOutput: "Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'ghost-plugin' imported from x",
});
check(
  '启动输出点名缺包 → 判为插件问题',
  fromStartup.primary.type === 'PLUGIN_LOAD_FAILED',
  `实际 ${fromStartup.primary.type}`,
);
check(
  '并且把 DSH 点名的那个包带进结论',
  JSON.stringify(fromStartup.primary.missingPlugins || []).includes('ghost-plugin'),
  JSON.stringify(fromStartup.primary.missingPlugins || []),
);

// 静态全正常 + 启动失败 + 错误认不出确切病因 → 老实说"不确定"，别硬猜
const unknown = diagnose(makeEnv(), { startupOutput: 'Error: connect ETIMEDOUT 1.2.3.4:443' });
check('认不出病因时判为 UNKNOWN（不硬猜）', unknown.primary.type === 'UNKNOWN', `实际 ${unknown.primary.type}`);

// 用户 --port 指定了 A，但 DSH 跑在 B —— 这件事必须写进依据里，不能瞒着
const mismatch = diagnose(makeEnv({ ports: { ...runningPort, requestedPort: 8000 } }));
check(
  '指定的端口与实际不符时，必须明确说出来',
  mismatch.primary.evidence.some((e) => e.includes('8000') && e.includes('3080')),
  JSON.stringify(mismatch.primary.evidence),
);

/* ══════════════════════════════════════════════════════════ */
console.log(`\n${'─'.repeat(50)}`);
console.log(`通过 ${passed} 项，失败 ${failed} 项`);
process.exit(failed === 0 ? 0 : 1);
