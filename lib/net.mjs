/**
 * 网络探测：端口 / HTTP
 * ============================================================
 * 🔴 这个文件有一条**实测得来的铁律**，别改：
 *
 *   **判断端口有没有被占用，只能用 Node 的 net 模块，不许调 netstat，
 *     也不许调 PowerShell 的 Get-NetTCPConnection。**
 *
 * 为什么（2026-09-30 实测）：
 *   DSH 明明正开着（浏览器就指着 127.0.0.1:3080），
 *   但 `Get-NetTCPConnection -LocalPort 3080 -State Listen` 返回**空**，
 *   于是判断成"3080 空闲、服务没起来"——**完全反了**。
 *   而 `net.connect()` 同一时刻稳定返回"连得上"。
 *
 *   这类"系统工具被权限/沙箱限制后静默返回空结果"的坑很阴险：
 *   它不报错，只是**悄悄少给你东西**，然后你就拿这个空结果当结论了。
 *   ⇒ Node 自己的 net 模块不受这类限制，且跨平台行为一致，所以用它。
 */

import net from 'node:net';
import http from 'node:http';
import https from 'node:https';

/**
 * 判断某个端口上有没有服务在监听。
 *
 * 用"能不能连上"来判断，而不是"系统说它有没有在听"——
 * 前者是事实，后者是被各种权限过滤过的二手信息。
 *
 * @param {number} port 端口号
 * @param {string} [host] 默认 127.0.0.1
 * @param {number} [timeout] 毫秒，默认 1500
 * @returns {Promise<{listening:boolean, code:string|null}>}
 */
export function isPortListening(port, host = '127.0.0.1', timeout = 1500) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;

    /** 只允许结算一次（connect / error / timeout 可能连着来） */
    const finish = (listening, code) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ listening, code });
    };

    socket.setTimeout(timeout);
    socket.once('connect', () => finish(true, null));
    socket.once('timeout', () => finish(false, 'TIMEOUT'));
    socket.once('error', (err) => finish(false, err.code || 'ERROR'));
    socket.connect(port, host);
  });
}

/**
 * 从一批候选端口里找出"正在跑 DSH 的那个"。
 *
 * @param {number[]} candidates 候选端口
 * @param {string} [host]
 * @returns {Promise<number[]>} 有服务在监听的端口列表
 */
export async function findListeningPorts(candidates, host = '127.0.0.1') {
  const results = await Promise.all(
    candidates.map(async (port) => ((await isPortListening(port, host)).listening ? port : null)),
  );
  return results.filter((p) => p !== null);
}

/**
 * 找一个空闲端口（用于"原端口被别的程序占了，换一个"）
 *
 * @param {number} start 从哪个端口开始找
 * @param {number} [limit] 最多往上找多少个，默认 50
 * @returns {Promise<number|null>} 找到的空闲端口，找不到返回 null
 */
export async function findFreePort(start, limit = 50) {
  for (let port = start; port < start + limit; port++) {
    if (port > 65535) break;
    // 先把明显的"系统保留端口"跳掉，省得白试
    if (port < 1024) continue;
    const { listening } = await isPortListening(port);
    if (!listening) return port;
  }
  return null;
}

/**
 * 发一个 HTTP 请求，看对方是不是活的（用于确认"这个端口上的服务到底是不是 DSH"）
 *
 * ⚠️ 这一步很重要：端口有监听 ≠ 那是 DSH。
 * 可能是别的程序占着 3080，那就要走"端口冲突"分支而不是"服务已启动"分支。
 *
 * @param {string} url 完整 URL
 * @param {number} [timeout] 毫秒
 * @returns {Promise<{ok:boolean, status:number|null, body:string, headers:object, error:string|null}>}
 */
export function httpGet(url, timeout = 3000) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      resolve(payload);
    };

    let client;
    try {
      client = url.startsWith('https:') ? https : http;
    } catch {
      return finish({ ok: false, status: null, body: '', headers: {}, error: 'URL 非法' });
    }

    let req;
    try {
      req = client.get(url, { timeout }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        // 只读前 8KB 就够了 —— 我们是来判断"这是不是 DSH"的，不是来抓网页的
        res.on('data', (chunk) => {
          if (body.length < 8192) body += chunk;
        });
        res.on('end', () =>
          finish({
            ok: res.statusCode >= 200 && res.statusCode < 400,
            status: res.statusCode,
            body,
            headers: res.headers || {},
            error: null,
          }),
        );
      });
    } catch (err) {
      return finish({ ok: false, status: null, body: '', headers: {}, error: String(err.message || err) });
    }

    req.on('timeout', () => {
      req.destroy();
      finish({ ok: false, status: null, body: '', headers: {}, error: '请求超时' });
    });
    req.on('error', (err) =>
      finish({ ok: false, status: null, body: '', headers: {}, error: err.code || String(err.message || err) }),
    );
  });
}

/**
 * 确认"这个端口上跑的确实是 DSH"。
 *
 * 🔴 这个函数的判据必须**严**，宁可不认，也不能认错。
 *   实测教训（2026-09-30）：本机 8000 端口上跑着一个 C-Lodop 打印服务，
 *   它好好地返回 HTTP 200。早先的版本写着"HTTP 能通就算 DSH（弱证据）"，
 *   于是工具报告「端口 8000：DSH 正在运行」，然后判定"服务运行正常、无需修复" ——
 *   **用户以为工具检查过了，其实什么都没查**。这是最坏的一种错：
 *   假阳性比查不出来危险得多，因为它会让用户放心。
 *   ⇒ 所以：**只有拿到强证据才敢说 isDsh**，
 *     拿不到强证据的只能说 reachable（那儿有东西，但不是 DSH）。
 *
 * 什么算强证据（任一命中）：
 *   · 响应头或正文里出现独立的 `dsh` 词
 *   · 出现 `deepseek-harness` / `deepseek harness`
 *   （实测 DSH 的认证响应就是 `dsh web authentication required; …`，能命中 ✓）
 *
 * @param {number} port
 * @returns {Promise<{isDsh:boolean, reachable:boolean, status:number|null, evidence:string}>}
 */
export async function probeDshHttp(port) {
  const url = `http://127.0.0.1:${port}/`;
  const res = await httpGet(url, 3000);

  if (!res.status) {
    return { isDsh: false, reachable: false, status: null, evidence: res.error || '无响应' };
  }

  const headerText = JSON.stringify(res.headers || {}).toLowerCase();
  const bodyText = String(res.body || '').toLowerCase();
  const haystack = `${headerText} ${bodyText}`;

  // 用 \b 卡词边界，避免 "loadsh"/"gdshell" 这种巧合命中
  const strong = /\bdsh\b/.test(haystack) || haystack.includes('deepseek-harness') || haystack.includes('deepseek harness');

  if (strong) {
    return {
      isDsh: true,
      reachable: true,
      status: res.status,
      evidence: `响应里出现 DSH 标识（HTTP ${res.status}）`,
    };
  }

  // 有东西在应答，但**不是** DSH —— 必须如实说出来，不能含糊
  return {
    isDsh: false,
    reachable: true,
    status: res.status,
    evidence: `HTTP ${res.status}，但响应里没有任何 DSH 标识（看着像别的程序）`,
  };
}
