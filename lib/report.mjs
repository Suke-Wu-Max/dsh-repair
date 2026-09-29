/**
 * 报告层
 * ============================================================
 * 报告要回答用户的五个问题（顺序就是用户此刻脑子里的顺序）：
 *   ① 我这台机器是什么情况？
 *   ② 到底哪儿坏了？
 *   ③ 你（工具）动了什么？
 *   ④ 现在好了没有？
 *   ⑤ 接下来我该干嘛？
 *
 * ⚠️ 两条硬要求：
 *
 * 【一】"你动了什么"必须**一条不漏**地列出来，包括备份文件的确切路径。
 *   用户会拿这份报告判断"要不要还原"，含糊其辞等于把风险推给用户。
 *
 * 【二】措辞不能自相矛盾。
 *   （实测踩过：探测到"服务运行正常"这种**好消息**时，
 *     报告里却挂着 "✗ 服务运行正常" 和一个红叉，
 *     下面还写"这种故障不能自动修复，需要你手动处理" ——
 *     正常也算"故障"？用户看到会直接懵。）
 *   ⇒ 所以整篇报告里，"好消息"和"坏消息"走的是两套措辞和符号，
 *     由 isGood 一个开关统一控制，不许东一句西一句。
 */

import path from 'node:path';
import { shortenPath } from './util.mjs';
import { FAULT } from './diagnose.mjs';

/**
 * 格式化时长
 * @param {number} ms
 * @returns {string}
 */
function humanDuration(ms) {
  if (ms < 1000) return `${ms} 毫秒`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} 秒`;
  const m = Math.floor(s / 60);
  return `${m} 分 ${Math.round(s % 60)} 秒`;
}

/**
 * 打印完整报告。
 *
 * @param {import('./ui.mjs').UI} ui
 * @param {object} data
 * @param {object} data.env         探测结果
 * @param {object} data.diagnosis   诊断结果
 * @param {object[]} data.actions   执行过的动作
 * @param {string[]} data.backups   产生的备份
 * @param {object|null} data.verification 验证结果
 * @param {boolean} data.dryRun
 * @param {string|null} data.logFile
 * @param {number} data.durationMs
 * @param {object|null} [data.registryInfo]
 */
export function printReport(ui, data) {
  const { env, diagnosis, actions, backups, verification, dryRun } = data;

  /** 这次是不是"本来就没事"（措辞和符号全看它） */
  const isGood = diagnosis.primary.type === FAULT.SERVICE_OK;

  ui.write();
  ui.write(ui.paint('═'.repeat(64), 'gray'));
  ui.write(
    ui.paint(
      dryRun ? '  dsh-tudian 检测报告（干跑模式 · 没有改动任何配置）' : '  dsh-tudian 修复报告',
      'bold',
      'cyan',
    ),
  );
  ui.write(ui.paint('═'.repeat(64), 'gray'));

  /* ── 一、环境信息 ── */
  ui.section('一、环境信息');
  ui.kv([
    ['操作系统', env.os.versionName],
    ['体系结构', env.os.arch],
    ['Node.js', `${env.node.version}${env.node.meetsDsh ? '（满足 DSH 要求）' : ui.paint(`（⚠ 低于要求的 ${env.node.required}）`, 'yellow')}`],
    ['npm', describeNpm(env, ui)],
    ['npm 当前源', env.npm.registry || ui.paint('没读到', 'yellow')],
    ['DSH 主目录', `${shortenPath(env.home.home)}  ${ui.paint(`（来自：${env.home.source}）`, 'gray')}`],
    ['DSH 本体', env.install.found
      ? `${env.install.version || '版本未知'}  ${ui.paint(shortenPath(env.install.path), 'gray')}`
      : ui.paint('未找到', 'red')],
    ['profile', env.profile
      ? `${env.profile.name}${env.profile.hasPatch ? '' : ui.paint('（没有 cordis.patch.yml）', 'gray')}`
      : ui.paint('没有可用的 profile', 'red')],
    ['登记的插件', `${env.pluginEntries.entries.length} 个`],
    ['历史备份', env.profile ? `${env.profile.backups.length} 份` : '—'],
  ]);

  if (dryRun) {
    ui.write(ui.paint('  （干跑模式：以上信息全部来自只读探测）', 'gray'));
  }

  /* ── 二、端口 ── */
  ui.section('二、端口探测');
  if (env.ports.listening.length === 0) {
    ui.info(`候选端口都空闲：${env.ports.candidates.slice(0, 8).join(', ')}`);
  } else {
    for (const c of env.ports.listening) {
      if (c.isDsh) ui.ok(`端口 ${c.port}：DSH 正在运行（HTTP ${c.status}）`);
      else ui.warn(`端口 ${c.port}：有服务但不是 DSH（${c.evidence || '未识别'}）`);
    }
  }

  /* ── 三、结论 ── */
  ui.section(isGood ? '三、检查结论' : '三、发现的问题');
  const p = diagnosis.primary;

  if (isGood) {
    ui.write(`  ${ui.paint('✓ ' + p.info.title, 'bold', 'green')}`);
  } else {
    ui.write(`  ${ui.paint('✗ ' + p.info.title, 'bold', 'red')}`);
  }
  ui.write(`    ${p.info.detail}`);

  if (p.evidence.length > 0) {
    ui.write(ui.paint('    依据：', 'gray'));
    for (const line of p.evidence) {
      ui.write(ui.paint('      - ' + line, 'gray'));
    }
  }

  // 只有**真的有问题**时才谈"能不能自动修"
  if (!isGood) {
    ui.write(
      `    ${
        p.info.autoFixable
          ? ui.paint('本工具可以自动修复', 'green')
          : ui.paint('这种故障不能自动修复，需要你按下面的步骤手动处理', 'yellow')
      }`,
    );
  }

  if (diagnosis.secondary.length > 0) {
    ui.write();
    ui.write('  另外发现（不影响这次修复）：');
    for (const s of diagnosis.secondary) {
      ui.write(`    ${ui.paint('!', 'yellow')} ${s.info.title}`);
      for (const line of s.evidence.slice(0, 3)) {
        ui.write(ui.paint('        ' + line, 'gray'));
      }
    }
  }

  /* ── 四、执行的操作 ── */
  ui.section('四、执行的操作');
  if (actions.length === 0) {
    ui.info(dryRun ? '干跑模式：没有执行任何修改操作' : '没有执行任何修改操作');
  } else {
    actions.forEach((a, i) => {
      const mark = { ok: '✓', warn: '!', error: '✗', info: '·' }[a.level] || '·';
      const color = { ok: 'green', warn: 'yellow', error: 'red', info: 'gray' }[a.level] || 'gray';
      ui.write(`  ${String(i + 1).padStart(2)}. ${ui.paint(mark, color)} ${a.text}`);
    });
  }

  if (backups.length > 0) {
    ui.write();
    ui.write('  产生的备份（原始文件一个字都没动）：');
    for (const b of backups) {
      ui.write(ui.paint('    · ' + shortenPath(b), 'gray'));
    }
  }

  /* ── 五、结果 ── */
  ui.section('五、结果');
  if (dryRun) {
    ui.emphasize('  干跑模式结束：以上是"如果真跑，会做什么"。');
    ui.write('  想真的执行修复，去掉 --dry-run 重跑一次。');
    ui.write(ui.paint('  （干跑唯一写下的东西是下面这份日志文件；DSH 的配置和系统状态一点没动）', 'gray'));
  } else if (data.cancelled) {
    // ⚠️ "用户取消"和"修复失败"是**两件事**，不能共用一句"未能修复"。
    //   一个是"你自己叫停的，什么都没发生"，一个是"我试了但没成功" ——
    //   混在一起说，用户会以为自己踩了个坑。
    ui.write(`  ${ui.paint('· 已取消，什么都没改', 'bold', 'yellow')}`);
    ui.write('  你选择了不修复。DSH 的配置和系统状态一个字节都没动。');
  } else if (isGood) {
    const port = env.ports.activePort;
    ui.write(`  ${ui.paint('✓ 无需修复', 'bold', 'green')}`);
    ui.write('  DSH 服务本来就在正常运行，工具没有改动任何东西。');
    ui.blank();
    ui.kv([
      ['服务端口', port ? String(port) : '—'],
      ['访问地址', port ? `http://127.0.0.1:${port}` : '—'],
      ['判定依据', env.ports.activeSource || '—'],
    ]);
    if (port) {
      ui.write(ui.paint(`  打不开的话，把地址栏里的端口改成 ${port} 再试一次。`, 'gray'));
    }
  } else if (verification && verification.ok) {
    ui.write(`  ${ui.paint('✓ 修复成功', 'bold', 'green')}`);
    ui.kv([
      ['服务端口', String(verification.port)],
      ['访问地址', `http://127.0.0.1:${verification.port}`],
      ['HTTP 状态', String(verification.status ?? '—')],
      ['判定依据', verification.evidence],
    ]);
  } else if (verification && verification.listening) {
    ui.write(`  ${ui.paint('! 部分成功', 'bold', 'yellow')}`);
    ui.write(`  端口 ${verification.port} 上有服务在监听，但没能确认它就是 DSH。`);
    ui.write(`  判定依据：${verification.evidence}`);
    ui.write(`  请手动打开 http://127.0.0.1:${verification.port} 看一眼到底是不是。`);
  } else {
    ui.write(`  ${ui.paint('✗ 未能修复', 'bold', 'red')}`);
    if (verification && verification.evidence) ui.write(`  验证结果：${verification.evidence}`);
  }

  /* ── 六、后续建议 ── */
  const suggestion = buildSuggestion(data);
  if (suggestion.length > 0) {
    ui.section('六、后续建议');
    for (const line of suggestion) {
      ui.write('  ' + line);
    }
  }

  /* ── 收尾：日志 ── */
  ui.write();
  ui.write(ui.paint('─'.repeat(64), 'gray'));
  if (data.logFile) {
    ui.write(`完整日志：${data.logFile}`);
    ui.write(ui.paint('  遇到问题把这份日志发出来，里面有每一步的原始命令和输出。', 'gray'));
  } else {
    ui.write(ui.paint('（日志文件写入失败，只有本次终端输出）', 'yellow'));
  }
  ui.write(ui.paint(`用时：${humanDuration(data.durationMs)}`, 'gray'));
}

/**
 * 描述 npm 的状态。
 *
 * ⚠️ 这里必须区分三种状态，不能混成一句"不可用"：
 *   · 装了且能用          → 显示版本号
 *   · 装了但跑不起来      → 说清楚"存在但跑不起来"，而不是误导用户去重装
 *   · 压根没装            → 才是真的"没找到"
 *
 * @param {object} env
 * @param {import('./ui.mjs').UI} ui
 * @returns {string}
 */
function describeNpm(env, ui) {
  if (env.npm.runnable && env.npm.version) return env.npm.version;
  if (env.npm.exists) {
    return ui.paint('存在，但执行失败', 'yellow') + ui.paint(`（${shortenNpmError(env.npm.error)}）`, 'gray');
  }
  return ui.paint('没找到', 'red');
}

/**
 * 把 npm 的报错压成一句人话（原始的太长，塞进表格里会难看）
 * @param {string|null} error
 * @returns {string}
 */
function shortenNpmError(error) {
  if (!error) return '原因未知';
  if (/EPERM/i.test(error)) return '权限不足 EPERM';
  if (/EACCES/i.test(error)) return '权限不足 EACCES';
  if (/ExecutionPolicy|running scripts is disabled/i.test(error)) return 'PowerShell 执行策略拦截';
  if (/ENOENT/i.test(error)) return '找不到文件';
  return String(error).slice(0, 60);
}

/**
 * 根据这次的结果生成"接下来该干嘛"。
 *
 * 这段文字是**给用户的最后一句话**，所以必须是**可执行的**，
 * 不能是"请检查配置"这种正确的废话。
 *
 * @param {object} data
 * @returns {string[]}
 */
function buildSuggestion(data) {
  const { diagnosis, verification, dryRun, env, registryInfo } = data;
  const lines = [];
  const type = diagnosis.primary.type;

  /* 干跑：告诉他怎么进入下一步 */
  if (dryRun) {
    lines.push('1. 先看清上面"发现的问题"，确认说的就是你遇到的那件事；');
    lines.push('2. 然后去掉 --dry-run 重跑，工具才会真正动手；');
    lines.push('3. 不确定的话，多跑几次干跑也没关系 —— 它不会改你任何配置。');
    return lines;
  }

  /* 用户自己叫停的：别给一堆"修复指引"，那是牛头不对马嘴 */
  if (data.cancelled) {
    lines.push('工具没有改动任何东西，你的 DSH 还是原样。');
    lines.push('');
    lines.push('想让它动手：重跑一次，问到时按 y；');
    lines.push('  或者加 --yes 让它一路自动执行（建议先看过干跑报告再这么做）。');
    return lines;
  }

  /* 本来就正常：告诉他怎么用，以及刚才那个"打不开"可能是什么 */
  if (type === FAULT.SERVICE_OK) {
    lines.push('✓ 不用修，直接用就行。');
    lines.push('');
    if (env.ports.activePort) {
      lines.push(`如果浏览器打不开，试试直接访问：http://127.0.0.1:${env.ports.activePort}`);
      lines.push('  页面还开着旧的，按 Ctrl+F5 强制刷新一次。');
    }
    lines.push('如果你遇到的其实是**别的问题**（比如某个插件不工作），');
    lines.push('  那不是"起不来"，本工具管的是启动失败 —— 可以把具体情况说清楚再排查。');
    return lines;
  }

  const failed = !verification || !verification.ok;

  /* 修好了 */
  if (!failed) {
    lines.push('✓ 现在可以正常用了。如果浏览器还开着旧页面，按 Ctrl+F5 强制刷新一次。');
    if (data.backups.length > 0) {
      lines.push('');
      lines.push('关于备份：这次改动过的文件都留了备份（见上方"产生的备份"）。');
      lines.push('  确认一切正常后也建议**先别删** —— 万一以后想还原，');
      lines.push('  把备份文件复制回去（去掉时间戳后缀）就是原样。');
    }
    if (registryInfo && registryInfo.switched) {
      lines.push('');
      lines.push(`关于软件源：本次只在安装时临时用了 ${registryInfo.url}，你的 npm 全局配置没有被改动。`);
    }
    return lines;
  }

  /* 没修好：给按故障类型的手动指引 */
  lines.push(...diagnosis.primary.info.manual.map((m) => (m.startsWith(' ') ? m : '• ' + m)));

  if (type === FAULT.PLUGIN_LOAD_FAILED) {
    lines.push('');
    lines.push('兜底三招（dsh-fix 是另一个独立的 DSH 修复工具，本工具在需要时会自动调用它）：');
    lines.push('  npx dsh-fix safe       # 先把所有用户插件停用，让 DSH 至少能起来');
    lines.push('  npx dsh-fix bisect     # 再两分法逐个排除，找出到底哪个插件有问题');
    lines.push('  npx dsh-fix clear      # 排查完，一键撤销所有停用（全部还原）');
  }

  if (type === FAULT.UNKNOWN) {
    lines.push('');
    lines.push('手动跑一次这个命令，把**完整输出**看全：');
    lines.push(`  dsh --profile ${env.profile ? env.profile.name : 'web'}`);
    lines.push('  （本工具只能看到它自己启动的那一次，你的终端里可能有更多线索）');
  }

  lines.push('');
  lines.push('还不行的话，把这份日志发出来求助：');
  lines.push(`  ${data.logFile || '(日志文件)'}`);
  return lines;
}

/**
 * 生成一段"精简摘要"（一行），给非交互场景 / CI 用
 * @param {object} data
 * @returns {string}
 */
export function shortSummary(data) {
  const { diagnosis, verification, dryRun } = data;
  const state = dryRun
    ? '干跑'
    : diagnosis.primary.type === FAULT.SERVICE_OK
      ? '本来就正常'
      : verification && verification.ok
        ? '已修复'
        : '未修复';
  return `[${state}] ${diagnosis.primary.info.title}`;
}

export { path };
