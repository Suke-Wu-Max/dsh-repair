/**
 * 主编排流程
 * ============================================================
 * 这个文件把「探测 → 诊断 → 修复 → 验证 → 报告」串成一条直线。
 *
 * 设计上刻意做成一件事：**先静态查，再用真实启动验证；一旦拿到新证据就重新诊断。**
 * 因为静态检查（看配置、看 node_modules）永远只是"推测 DSH 会说哪里错"，
 * 而 DSH 自己启动时吐出来的那行报错才是**铁证**。
 * 所以流程里有一个"启动失败 → 拿输出重新诊断 → 换一条修复路径"的回路。
 *
 * ⚠️ 关于"什么时候会写盘"：只有下面这几处会改东西，
 *   而且每一处都先过 `if (dryRun) return`：
 *     · repairer.restore()      恢复配置备份
 *     · repairer.linkPlugin()   重建插件链接
 *     · repairer.cleanCache()   校验 npm 缓存
 *     · repairer.persistRegistry() 改全局 npm 源（默认不调用）
 *     · repairer.startAndVerify()  启动 DSH（DSH 自己会写 profile 目录）
 *     · repairer.runDshFix()    调 dsh-fix 改配置
 *   ⇒ 想确认 dry-run 是不是真的安全，grep 这几个函数就够了。
 */

import path from 'node:path';

import { createUI } from './ui.mjs';
import { Logger } from './log.mjs';
import { probeAll } from './probe.mjs';
import { diagnose, FAULT } from './diagnose.mjs';
import { Repairer } from './repair.mjs';
import { printReport } from './report.mjs';
import { run } from './exec.mjs';
import { shortenPath, truncate, exists, linkInfo } from './util.mjs';

/**
 * 跑完整流程。
 *
 * @param {object} options
 * @param {string} [options.home]       DSH 主目录
 * @param {string} [options.profile]    profile 名
 * @param {number} [options.port]       端口
 * @param {boolean} [options.dryRun]    只检测不修复
 * @param {boolean} [options.yes]       所有确认自动答是
 * @param {boolean} [options.verbose]   展开细节
 * @param {boolean} [options.noColor]   关颜色
 * @param {boolean} [options.quiet]     只打结果
 * @param {string}  [options.logFile]   日志文件路径
 * @param {boolean} [options.persistRegistry] 是否允许改全局 npm 源（默认否）
 * @returns {Promise<{ok:boolean, diagnosis:object, verification:object|null, exitCode:number}>}
 */
export async function runFlow(options = {}) {
  const started = Date.now();
  const ui = createUI({
    noColor: options.noColor,
    verbose: options.verbose,
    yes: options.yes,
    quiet: options.quiet,
  });
  const log = new Logger({ file: options.logFile });

  /** 保证 Ctrl+C 时 readline 被收掉，不留一个挂住的进程 */
  const onSigint = () => {
    ui.close();
    process.exit(130);
  };
  process.once('SIGINT', onSigint);

  try {
    /* ── 开场 ── */
    ui.banner(
      'dsh-tudian · DSH 启动失败修复工具',
      options.dryRun ? '当前是干跑模式：只读检查，不改动 DSH 的任何配置' : '探测 → 诊断 → 修复 → 验证',
    );
    ui.blank();
    ui.info(`日志：${log.file}`);

    /* ── 第一步：探测 ── */
    ui.section('正在探测环境…');
    const env = await probeAll({
      home: options.home,
      profile: options.profile,
      port: options.port,
      onProgress: (text, index, total) => ui.step(index, total, `探测 ${text}…`),
    });
    log.log(`探测完成：${JSON.stringify({ os: env.os.platformName, node: env.node.version, home: env.home.home, profile: env.profile ? env.profile.name : null, install: env.install.path })}`, 'info');
    ui.ok('环境探测完成');

    /* ── 第二步：初步诊断（基于静态信息） ── */
    ui.section('正在诊断…');
    let diagnosis = diagnose(env);
    log.log(`初步诊断：${diagnosis.primary.type} · ${diagnosis.summary}`, 'info');
    ui.write(`  初判：${ui.paint(diagnosis.primary.info.title, 'bold')}`);

    /* ── 干跑模式：到此为止 ── */
    if (options.dryRun) {
      const logFile = log.close('干跑结束（未做任何修改）');
      ui.close();
      printReport(ui, {
        env, diagnosis, actions: [], backups: [], verification: null,
        dryRun: true, logFile, durationMs: Date.now() - started,
      });
      return { ok: true, diagnosis, verification: null, exitCode: 0 };
    }

    /* ── 服务本来就正常：不用修 ── */
    if (diagnosis.primary.type === FAULT.SERVICE_OK) {
      const logFile = log.close('服务运行正常，无需修复');
      ui.close();
      printReport(ui, {
        env, diagnosis, actions: [], backups: [], verification: null,
        dryRun: false, logFile, durationMs: Date.now() - started,
      });
      return { ok: true, diagnosis, verification: null, exitCode: 0 };
    }

    /* ── 不能自动修的：直接给指引，别乱动人家机器 ── */
    if (!diagnosis.primary.info.autoFixable) {
      ui.blank();
      ui.warn('这个故障没法自动修，需要你手动处理。下面是报告和具体步骤。');
      const logFile = log.close(`需要手动处理：${diagnosis.primary.type}`);
      ui.close();
      printReport(ui, {
        env, diagnosis, actions: [], backups: [], verification: null,
        dryRun: false, logFile, durationMs: Date.now() - started,
      });
      return { ok: false, diagnosis, verification: null, exitCode: 2 };
    }

    /* ── 第三步：确认 ── */
    const repairer = new Repairer({
      env, ui, log,
      dryRun: false,
      yes: options.yes,
      home: env.home.home,
      port: options.port,
      bootLog: options.bootLog,
    });

    ui.blank();
    const proceed = await ui.confirm(
      `检测到「${diagnosis.primary.info.title}」，是否现在修复？`,
      { defaultYes: true },
    );
    if (!proceed) {
      ui.blank();
      ui.warn('你选择了不修复。本次没有改动任何东西。');
      const logFile = log.close('用户取消修复');
      ui.close();
      printReport(ui, {
        env, diagnosis, actions: [], backups: [], verification: null,
        dryRun: false, cancelled: true, logFile, durationMs: Date.now() - started,
      });
      return { ok: false, diagnosis, verification: null, exitCode: 0 };
    }

    /* ── 第四步：按故障类型分派 ── */
    let verification = null;

    ui.section('开始修复…');
    log.log(`开始修复：${diagnosis.primary.type}`, 'step');

    switch (diagnosis.primary.type) {
      case FAULT.CONFIG_PATCH_BROKEN:
        verification = await repairConfigBroken(env, diagnosis, repairer, ui);
        break;

      case FAULT.PLUGIN_LOAD_FAILED:
        verification = await repairPluginFailure(env, diagnosis, repairer, ui, options);
        break;

      case FAULT.PORT_CONFLICT:
        verification = await repairPortConflict(env, repairer, ui, options);
        break;

      case FAULT.SERVICE_NOT_RUNNING:
        verification = await repairServiceDown(env, diagnosis, repairer, ui, options);
        break;

      default:
        ui.warn(`没有针对「${diagnosis.primary.type}」的自动修复流程，改为尝试直接启动一次看真实报错。`);
        verification = await repairServiceDown(env, diagnosis, repairer, ui, options);
        break;
    }

    /* ── 第五步：收尾 ── */
    const ok = Boolean(verification && verification.ok);
    const logFile = log.close(ok ? '修复成功' : '修复未成功');
    ui.close();

    printReport(ui, {
      env,
      diagnosis,
      actions: repairer.actions,
      backups: repairer.backups,
      verification,
      dryRun: false,
      logFile,
      durationMs: Date.now() - started,
      registryInfo: repairer.registryInfo || null,
    });

    return { ok, diagnosis, verification, exitCode: ok ? 0 : 2 };
  } finally {
    process.removeListener('SIGINT', onSigint);
    ui.close();
  }
}

/* ══════════════════════════════════════════════════════════
 * 四条修复路径
 * ══════════════════════════════════════════════════════════ */

/**
 * 路径 A：配置文件损坏 → 从备份恢复
 *
 * 这是四条路里**最危险**的一条（会用旧内容覆盖用户的文件），
 * 所以它有三重保险：
 *   ① 只在确实没有可用备份时才放弃
 *   ② 先让用户看清"用哪份备份、什么时候的、多大"，再单独确认一次
 *   ③ 恢复前把"当前状态"也备份一份（在 repairer.restore 里做）
 *
 * @returns {Promise<object|null>} 验证结果
 */
async function repairConfigBroken(env, diagnosis, repairer, ui) {
  const backups = env.profile.backups;

  if (backups.length === 0) {
    repairer.record('配置文件损坏，但**一份历史备份都没有**，无法自动恢复', 'error');
    ui.blank();
    ui.fail('没有备份可用，自动恢复这条路走不通。');
    ui.write('  手动排查建议：');
    ui.write('    1. 打开这个文件，检查最近手改的那几行：');
    ui.write(`       ${env.profile.patchFile}`);
    ui.write('    2. 最常见的两个坑：用了 Tab 缩进（YAML 只认空格）、引号没闭合');
    ui.write('    3. 实在改不回来，可以暂时把整个文件清空（DSH 会回到没有任何用户插件的状态）');
    return null;
  }

  const newest = backups[0];
  const when = new Date(newest.mtimeMs).toLocaleString('zh-CN');

  ui.blank();
  ui.write('  找到这些历史备份（新的在前）：');
  for (const b of backups.slice(0, 5)) {
    ui.write(`    · ${path.basename(b.file)}   ${when_of(b)}`);
  }

  const yes = await ui.confirm(
    `用最新那份备份覆盖当前配置文件？（备份时间：${when}）`,
    { defaultYes: true },
  );
  if (!yes) {
    repairer.record('用户取消从备份恢复');
    return null;
  }

  const res = repairer.restore(env.profile.patchFile, newest.file);
  if (!res.ok) {
    repairer.record(`恢复失败：${res.error}`, 'error');
    return null;
  }

  ui.blank();
  ui.step(1, 2, '正在启动服务验证…');
  const boot = await repairer.startAndVerify({ port: env.ports.preferredPort });

  if (!boot.ok) {
    // 启动还是不行 —— 拿真实输出重新诊断一下，走另一条路
    const deeper = diagnose(env, { startupOutput: boot.output });
    if (deeper.primary.type === FAULT.PLUGIN_LOAD_FAILED) {
      repairer.record('恢复备份后启动仍失败，真实报错指向插件问题，转去修插件', 'warn');
      return await repairPluginFailure(env, deeper, repairer, ui, {});
    }
    repairer.record(`恢复备份后仍未起来：${boot.error || '端口没就绪'}`, 'error');
    return null;
  }

  ui.step(2, 2, '验证端口…');
  const v = await repairer.verify(boot.port);
  v.port = boot.port;
  return v;
}

/**
 * 路径 B：插件加载失败 → 精确修复优先，安全模式兜底
 *
 * 🔴 顺序是刻意排的（代价从低到高）：
 *   ① 重建链接      —— 插件功能**完整保留**，代价最低
 *   ② 重新安装      —— 插件功能保留，但要联网
 *   ③ 精确禁用那一个 —— 只损失这一个插件
 *   ④ 安全模式全禁   —— 所有用户插件都停用（用户配置最惨，但保证能起来）
 *   ✗ 绝不能一上来就做 ④ —— 那是拿用户的一整套插件去赌一个问题插件。
 *
 * @returns {Promise<object|null>} 验证结果
 */
async function repairPluginFailure(env, diagnosis, repairer, ui, options) {
  const broken = (diagnosis.primary.missingPlugins || []).filter((p) => !p.installed);

  if (broken.length === 0) {
    repairer.record('诊断说是插件问题，但没能定位到具体是哪个插件', 'warn');
    return await escalateToSafeMode(env, repairer, ui, options);
  }

  ui.blank();
  ui.write(`  出问题的插件共 ${broken.length} 个：`);
  for (const p of broken) {
    ui.write(`    ${ui.paint('✗', 'red')} ${p.name}${p.linkBroken ? ui.paint('（链接断了）', 'yellow') : ui.paint('（没安装）', 'gray')}`);
  }

  /* ── 第一步：先备份配置文件 ── */
  ui.blank();
  ui.step(1, 5, '备份配置文件…');
  const backup = repairer.backup(env.profile.patchFile);
  if (!backup.ok) {
    repairer.record(`备份失败，已中止一切修改：${backup.error}`, 'error');
    return null;
  }
  if (backup.reused) repairer.record(`已有内容相同的备份，直接复用：${path.basename(backup.backupFile)}`);

  /* ── 第二步：逐个精确修复 ── */
  ui.step(2, 5, '尝试把插件真正修好（不是禁用它）…');
  let fixedAny = false;

  for (const p of broken) {
    // ① 本地目录插件：链接没建好 → 建起来
    const source = repairer.findPluginSource(p.name);
    if (source) {
      ui.info(`发现本地插件目录：${shortenPath(source)}`);
      const link = repairer.linkPlugin(p.name, source);
      if (link.ok) {
        fixedAny = true;
        continue;
      }
      repairer.record(`重建链接没成功：${link.error}`, 'warn');
    } else {
      ui.info(`没找到 ${p.name} 的本地目录，它应该是个 npm 包`);
    }
  }

  /* ── 第三步：装了没好的，试着重新装（这时才需要动网络和源） ── */
  const stillBroken = broken.filter((p) => {
    if (!env.profile) return true;
    const target = path.join(env.profile.dir, 'node_modules', ...p.name.split('/'));
    if (!exists(target)) return true; // 压根没装
    const info = linkInfo(target);
    return info.isLink && info.broken; // 装了，但链接是断的
  });

  let registryUsed = null;

  if (stillBroken.length > 0) {
    ui.step(3, 5, `还有 ${stillBroken.length} 个插件需要重新安装，正在挑一个能用的软件源…`);

    const { best, all } = await repairer.pickBestRegistry();
    const usable = all.filter((r) => r.ok);

    if (usable.length === 0) {
      repairer.record('所有候选软件源都连不上 —— 这本身就是个问题（网络或代理）', 'error');
      ui.blank();
      ui.fail('网络不通：所有软件源都连不上，装不了包。');
      ui.write('  请检查网络 / 代理设置，然后重跑。');
      ui.write(`  当前 npm 源：${env.npm.registry || '未读到'}`);
    } else {
      registryUsed = best.url;
      repairer.registryInfo = { url: best.url, switched: false, name: best.name };
      ui.ok(`选中的源：${best.name}（${best.ms}ms）`);

      // 清缓存（温柔档）—— TAR_BAD_ARCHIVE 这类"缓存里的包坏了"就靠它
      ui.info('先校验一遍 npm 缓存（只清理损坏条目，不删你的缓存）');
      repairer.cleanCache();

      for (const p of stillBroken) {
        const args = ['plugin', '--profile', env.profile.name, 'add', p.name];
        ui.info(`安装 ${p.name} …`);

        if (repairer.dryRun) {
          repairer.record(`[干跑] 会执行：dsh ${args.join(' ')}`);
          continue;
        }

        // 用 dsh plugin add（它会顺便把登记项和依赖都处理对），不行再退回 npm i
        const viaDsh = run('dsh.cmd', args, { timeout: 300_000, cwd: env.profile.dir });
        repairer.log.logExec('dsh', args, viaDsh);

        if (viaDsh.ok) {
          repairer.record(`插件 ${p.name} 安装成功`, 'ok');
          fixedAny = true;
          continue;
        }

        // 退路：直接用 npm 装到 profile 目录，并带上临时源
        const npmArgs = ['install', p.name, '--registry', best.url];
        const viaNpm = run('npm.cmd', npmArgs, { timeout: 300_000, cwd: env.profile.dir });
        repairer.log.logExec('npm', npmArgs, viaNpm);

        if (viaNpm.ok) {
          repairer.record(`插件 ${p.name} 已用 npm 装入 profile`, 'ok');
          fixedAny = true;
        } else {
          repairer.record(
            `插件 ${p.name} 装不上：${truncate(viaNpm.stderr || viaNpm.error || '未知原因', 200)}`,
            'warn',
          );
        }
      }
    }
  } else {
    ui.step(3, 5, '插件都已经在 node_modules 里了，跳过安装');
  }

  /* ── 第四步：启动验证 ── */
  ui.step(4, 5, '启动服务并验证…');
  const boot = await repairer.startAndVerify({ port: env.ports.preferredPort });

  if (boot.ok) {
    ui.step(5, 5, '确认端口上的服务确实是 DSH…');
    const v = await repairer.verify(boot.port);
    v.port = boot.port;
    if (v.ok) return v;

    // 起来了但不像 DSH —— 把真实输出看一眼，可能还有别的问题
    repairer.record('端口上有服务，但没能确认是 DSH', 'warn');
  }

  /* ── 第五步：精确修复没成 → 逐级降级 ── */
  ui.step(5, 5, '精确修复没成功，进入降级方案…');

  // 降级 ①：用 dsh-fix 精确禁用"真的有问题的那几个"（不是全部）
  const afterLink = diagnose(env, { startupOutput: boot.output });
  const stillMissing = (afterLink.primary.missingPlugins || []).filter((p) => !p.installed);

  if (stillMissing.length > 0 || afterLink.primary.type === FAULT.PLUGIN_LOAD_FAILED) {
    const target = stillMissing.length > 0 ? stillMissing : broken;
    ui.blank();
    ui.warn(`要把下面这些插件单独停用吗？其他插件不受影响。`);
    for (const p of target) ui.write(`    · id: ${p.id || p.name}   (${p.name})`);

    const yes = await ui.confirm('确认停用它们？', { defaultYes: true });
    if (yes) {
      const fix = await repairer.ensureDshFix(registryUsed);
      if (fix.ok) {
        repairer.runDshFix(['doctor', '-v'], { how: fix.how, timeout: 120_000 });

        for (const p of target) {
          const id = p.id || p.name;
          const res = repairer.runDshFix(['disable', id], { how: fix.how });
          if (res.ok) repairer.record(`已停用插件：${id}`, 'ok');
          else repairer.record(`停用 ${id} 失败：${truncate(res.stderr || '', 160)}`, 'warn');
        }

        const retry = await repairer.startAndVerify({ port: env.ports.preferredPort });
        if (retry.ok) {
          const v = await repairer.verify(retry.port);
          v.port = retry.port;
          if (v.ok) {
            repairer.record('停用故障插件后，服务已正常启动', 'ok');
            return v;
          }
        }
      }
    }
  }

  // 降级 ②：安全模式（全部用户插件停用）—— 最后手段
  return await escalateToSafeMode(env, repairer, ui, options, registryUsed);
}

/**
 * 最后手段：安全模式。
 *
 * 🔴 调用之前一定要让用户明白**代价**：所有自己装的插件都会停用。
 *   所以这里的 confirm 默认值是 **false**（用户直接回车 = 不动手）。
 *
 * @returns {Promise<object|null>}
 */
async function escalateToSafeMode(env, repairer, ui, options, registryUsed = null) {
  ui.blank();
  ui.write(ui.paint('  兜底方案：安全模式', 'bold', 'yellow'));
  ui.write('  它会把**所有**你装的插件都停用，只留 DSH 自带功能。');
  ui.write('  好处是几乎保证能让 DSH 起来；代价是工作台、中文包这些插件都会失效。');
  ui.write(ui.paint('  随时可以一键撤销：npx dsh-fix clear', 'gray'));

  const yes = await ui.confirm('要进入安全模式吗？', { defaultYes: false });
  if (!yes) {
    repairer.record('用户选择不使用安全模式', 'info');
    return null;
  }

  const fix = await repairer.ensureDshFix(registryUsed);
  if (!fix.ok) {
    repairer.record(`dsh-fix 不可用，安全模式走不通：${fix.error}`, 'error');
    return null;
  }

  const res = repairer.runDshFix(['safe'], { how: fix.how });
  if (!res.ok) {
    repairer.record(`安全模式执行失败：${truncate(res.stderr || '', 200)}`, 'error');
    return null;
  }
  repairer.record('已进入安全模式（所有用户插件已停用）', 'warn');

  const boot = await repairer.startAndVerify({ port: env.ports.preferredPort });
  if (!boot.ok) return null;

  const v = await repairer.verify(boot.port);
  v.port = boot.port;

  if (v.ok) {
    ui.blank();
    ui.write('  下一步：找出到底是哪个插件。两个办法 ——');
    ui.write(`    ${ui.paint('dsh-fix bisect', 'bold')}   两分法逐个排除（推荐，几轮就能定位）`);
    ui.write(`    ${ui.paint('dsh-fix list', 'bold')}     先看看都有哪些插件登记着`);
  }
  return v;
}

/**
 * 路径 C：端口被占用 → 换端口启动
 * @returns {Promise<object|null>}
 */
async function repairPortConflict(env, repairer, ui, options) {
  const occupied = env.ports.listening.map((c) => c.port);
  const startFrom = options.port || occupied[0] || env.ports.preferredPort;

  ui.blank();
  ui.info(`端口 ${occupied.join('、')} 被别的程序占着，正在找一个空闲端口…`);

  const free = await repairer.chooseAlternativePort(startFrom);
  if (!free) return null;

  ui.info(`将使用端口 ${free} 启动`);

  const boot = await repairer.startAndVerify({ port: free });
  if (!boot.ok) {
    const deeper = diagnose(env, { startupOutput: boot.output });
    if (deeper.primary.type === FAULT.PLUGIN_LOAD_FAILED) {
      repairer.record('换端口后启动仍失败，真实报错指向插件问题，转去修插件', 'warn');
      return await repairPluginFailure(env, deeper, repairer, ui, options);
    }
    return null;
  }

  const v = await repairer.verify(boot.port);
  v.port = boot.port;
  return v;
}

/**
 * 路径 D：服务没起来（配置正常）→ 直接启动
 *
 * 注意这里有个回路：如果启动失败，会把**真实输出**拿去重新诊断。
 * 因为"配置看起来正常"只是我们的推测，DSH 自己报的错才是事实。
 *
 * @returns {Promise<object|null>}
 */
async function repairServiceDown(env, diagnosis, repairer, ui, options) {
  const port = options.port || env.ports.preferredPort;

  ui.blank();
  ui.info(`正在启动 DSH（端口 ${port}）… 首次启动可能要十几秒，请稍候`);

  const boot = await repairer.startAndVerify({ port });

  if (boot.ok) {
    const v = await repairer.verify(boot.port);
    v.port = boot.port;
    if (v.ok) return v;
    repairer.record(`端口 ${boot.port} 有服务但不是 DSH，可能端口又被别人抢了`, 'warn');
    return null;
  }

  /* 启动失败 —— 把真实报错拿来看看，说不定能换一条路救回来 */
  const deeper = diagnose(env, { startupOutput: boot.output });

  if (deeper.primary.type === FAULT.PLUGIN_LOAD_FAILED) {
    repairer.record('启动失败，真实报错指向插件问题，转去修插件', 'warn');
    return await repairPluginFailure(env, deeper, repairer, ui, options);
  }

  if (deeper.primary.type === FAULT.PORT_CONFLICT) {
    repairer.record('启动失败，端口被人抢了，改用空闲端口重试', 'warn');
    return await repairPortConflict(env, repairer, ui, options);
  }

  // 报错认不出来：把关键几行原样摆给用户，别自己瞎猜
  ui.blank();
  ui.fail(`服务没能启动：${boot.error || '原因未知'}`);
  if (boot.output) {
    ui.write('  启动输出的关键部分：');
    for (const line of boot.output.split(/\r?\n/).filter((l) => l.trim()).slice(-15)) {
      ui.write(ui.paint('    ' + truncate(line, 160), 'gray'));
    }
  }
  repairer.record(`启动失败：${truncate(boot.output || boot.error || '', 400)}`, 'error');
  return null;
}

/* ── 小工具（放在文件末尾，避免打断阅读主线） ─────────────── */

/**
 * 备份文件的中文时间描述
 * @param {{file:string, size:number, mtimeMs:number}} backup
 * @returns {string}
 */
function when_of(backup) {
  const when = backup.mtimeMs ? new Date(backup.mtimeMs).toLocaleString('zh-CN') : '时间未知';
  return `${when} · ${(backup.size / 1024).toFixed(1)} KB`;
}

/* 说明：原先这里有两个用 require() 写的辅助函数，
   但本包是 ESM（"type": "module"），ESM 里没有 require ——
   那两处会被 try/catch 吞掉、静默返回错误结果，
   已经改成复用 util.mjs 里现成的 exists() / linkInfo()。 */
