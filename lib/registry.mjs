/**
 * npm 源（registry）探测与切换
 * ============================================================
 * 为什么单独一个文件：这是**用户最容易踩、又最难自己看出来**的一类故障。
 * 现象是装包时报 `TAR_BAD_ARCHIVE`（下载下来的 tar 是坏的），
 * 或者一直 `ETIMEDOUT`，但用户通常只会觉得"网不好，再试一次"。
 *
 * 🔴 安全底线（这个文件里最要紧的一条）：
 *   **绝不擅自改用户的全局 npm 配置。**
 *   改 registry 有两档做法：
 *     · 温和档：给单条命令加 `--registry <url>` —— 只影响这一次，不动任何配置文件 ✓
 *     · 激进档：`npm config set registry <url>` —— 改的是用户全局配置，所有项目都受影响 ✗
 *   本工具的规矩是：**默认只做温和档**，只有用户明确同意才动全局配置，
 *   而且动之前先把原值记下来，随时能还原。
 */

import http from 'node:http';
import https from 'node:https';
import { run } from './exec.mjs';

/**
 * 候选源清单。
 *
 * ⚠️ 这些地址是"写的"不是"猜的"，但网络环境会变，
 * 所以工具不假设谁一定可用 —— 而是**现场挨个探一遍**（见 probeRegistries）。
 */
export const CANDIDATE_REGISTRIES = [
  { name: 'npm 官方源', url: 'https://registry.npmjs.org/', region: 'global' },
  { name: '淘宝镜像（npmmirror）', url: 'https://registry.npmmirror.com/', region: 'cn' },
  { name: '腾讯云镜像', url: 'https://mirrors.cloud.tencent.com/npm/', region: 'cn' },
  { name: '华为云镜像', url: 'https://repo.huaweicloud.com/repository/npm/', region: 'cn' },
  { name: '中科大镜像', url: 'https://npmreg.proxy.ustclug.org/', region: 'cn' },
];

/** 用来测源的"探针包"—— 体积小、长期存在、改动极少 */
const PROBE_PACKAGE = 'dsh-fix';

/**
 * 读当前生效的 registry。
 *
 * ⚠️ 注意：`npm config get registry` 返回的是**最终生效值**
 * （可能来自项目 .npmrc / 用户 .npmrc / 全局配置，优先级不同）。
 * 这正是我们要的 —— 用户不关心它写在哪个文件里，只关心实际用的是哪个。
 *
 * @returns {{value:string|null, error:string|null, npmMissing:boolean}}
 */
export function getCurrentRegistry() {
  const res = run('npm.cmd', ['config', 'get', 'registry'], { timeout: 20_000 });

  if (res.error || res.code !== 0) {
    // npm 完全不可用（没装 / 被策略拦 / 权限不足）都归到这里。
    // ⚠️ 别把"命令失败"当成"用户没配源"—— 要说清楚是"没读到"。
    const missing = /ENOENT|not recognized|无法将|CommandNotFound/i.test(`${res.error || ''} ${res.stderr || ''}`);
    return { value: null, error: res.error || res.stderr || 'npm config 执行失败', npmMissing: missing };
  }

  const value = res.stdout.split(/\r?\n/).pop().trim();
  return { value: value || null, error: null, npmMissing: false };
}

/**
 * 测一个源是否可用。
 *
 * 判据：能不能取到探针包的 metadata（HTTP 2xx/3xx）。
 * 只发一个 GET、不下载包体，所以很快、很轻。
 *
 * ⚠️ 为什么要真测而不是"按地区猜"：
 *   有些源在大陆可达、有些在海外可达，用户环境千差万别，
 *   写死"国内就用淘宝"一定会翻车。**现场探**才是唯一可靠的做法。
 *
 * @param {string} baseUrl 源地址
 * @param {number} [timeout] 毫秒，默认 6000
 * @returns {Promise<{ok:boolean, ms:number|null, status:number|null, error:string|null}>}
 */
export function testRegistry(baseUrl, timeout = 6000) {
  return new Promise((resolve) => {
    const started = Date.now();

    let url;
    try {
      url = new URL(PROBE_PACKAGE, baseUrl.endsWith('/') ? baseUrl : baseUrl + '/');
    } catch {
      return resolve({ ok: false, ms: null, status: null, error: '地址非法' });
    }

    const client = url.protocol === 'https:' ? https : http;
    let settled = false;
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      resolve({ ...payload, ms: Date.now() - started });
    };

    let req;
    try {
      req = client.get(
        url,
        { timeout, headers: { 'user-agent': 'dsh-tudian (+https://www.npmjs.com/package/dsh-tudian)', accept: 'application/json' } },
        (res) => {
          res.resume(); // 不要响应体，直接丢掉
          const ok = res.statusCode >= 200 && res.statusCode < 400;
          finish({ ok, status: res.statusCode, error: ok ? null : `HTTP ${res.statusCode}` });
        },
      );
    } catch (err) {
      return finish({ ok: false, status: null, error: String(err.message || err) });
    }

    req.on('timeout', () => {
      req.destroy();
      finish({ ok: false, status: null, error: '超时' });
    });
    req.on('error', (err) => finish({ ok: false, status: null, error: err.code || String(err.message || err) }));
  });
}

/**
 * 把所有候选源都探一遍，按"能用 + 快"排序。
 *
 * @param {object} [opts]
 * @param {number} [opts.timeout] 每个源的超时
 * @param {(row:object)=>void} [opts.onProbe] 每探完一个回调一次（用于显示进度）
 * @returns {Promise<Array<{name:string,url:string,region:string,ok:boolean,ms:number|null,error:string|null}>>}
 */
export async function probeRegistries(opts = {}) {
  const timeout = opts.timeout || 6000;

  const results = await Promise.all(
    CANDIDATE_REGISTRIES.map(async (item) => {
      const r = await testRegistry(item.url, timeout);
      const row = { ...item, ...r };
      if (opts.onProbe) opts.onProbe(row);
      return row;
    }),
  );

  // 能用的排前面，同档按延迟快慢排（快的优先）
  return results.sort((a, b) => {
    if (a.ok !== b.ok) return a.ok ? -1 : 1;
    return (a.ms ?? 9e9) - (b.ms ?? 9e9);
  });
}

/**
 * 设置 registry（⚠️ 有副作用：改的是用户的 npm 配置）
 *
 * 🔴 只在用户明确同意后调用。
 * 调用前请先用 getCurrentRegistry() 把原值存下来，并告诉用户怎么还原。
 *
 * @param {string} url 目标源
 * @returns {{ok:boolean, error:string|null}}
 */
export function setRegistry(url) {
  const res = run('npm.cmd', ['config', 'set', 'registry', url], { timeout: 30_000 });
  return { ok: res.ok, error: res.ok ? null : res.error || res.stderr || '设置失败' };
}

/**
 * 计算"临时用某个源跑一条 npm 命令"的参数。
 *
 * 这是**温和档**：给单条命令加 --registry，不碰任何配置文件。
 * 本工具装包时默认都用这个，而不是去改用户配置。
 *
 * @param {string} url
 * @returns {string[]} 要追加到 npm 命令后面的参数
 */
export function tempRegistryArgs(url) {
  return ['--registry', url];
}
