# dsh-tudian

**中文** | [**English**](#english)

> **你的 DeepSeek Harness 起不来了？跑一条命令，它自己查清楚哪儿坏了，并把能修的都修好。**
>
> One command that diagnoses and repairs a DeepSeek Harness that will not start.

`零第三方依赖` · `Windows / macOS / Linux` · `Node ≥ 18 即可运行` · `全中文输出` · `可回退`

---

## 中文

### 它解决的是一个很难受的场景

你的 DSH 突然起不来了。

桌面上那些快捷方式 —— 「DeepSeek工作台」「对话浮窗」「DSH浏览器」—— **全都点不动**。你连入口都没了，更别说去查为什么。

而这类故障常见得让人恼火：装了个新插件、手改了一行配置、端口被别的程序抢了、Node 版本太低……每种的修法都不一样，而报错信息通常只有一行英文。

**dsh-tudian 就是为这一刻准备的。** 一条命令，它自己把病因找出来，把能修的都修好。

### 它是怎么工作的

```
探测  →  诊断  →  修复  →  验证  →  报告
```

| 阶段 | 做什么 | 会不会改东西 |
|---|---|---|
| **探测** | 环境体检：系统 / Node / npm / DSH 装在哪 / profile / 端口 / 配置 / 历史备份 / 软件源可用性 | **全部只读** |
| **诊断** | 判定属于哪一类故障，并给出**主因 + 次因**（不是一个让你自己挑的问题清单） | 只判断 |
| **修复** | 按照代价从低到高的顺序动手 | **唯一会改东西的一步** |
| **验证** | 端口 + HTTP 双重确认，确保起来的**确实是** DSH | 只读 |
| **报告** | 中文报告：环境信息、发现的问题、**动过的每一个文件**、结果、下一步 | 写一份日志 |

分层是刻意的：**探测层只读、诊断层只判断、修复层才动手。**
所以"只看不改"模式的安全性是一眼可查的 —— 想确认它有没有偷偷写东西，只需要看一个文件。

### 能修哪些故障

| 故障 | 能不能自动修 |
|---|---|
| 插件加载失败（启动就退，报 `ERR_MODULE_NOT_FOUND`） | ✅ |
| 配置文件损坏（报 `failed to parse patches`） | ✅ |
| 端口被别的程序占用 | ✅ |
| 服务单纯没启动 | ✅ |
| npm 源异常（装包报 `TAR_BAD_ARCHIVE`） | ✅ |
| Node 版本过低 | 只能告诉你该怎么办 |
| profile 目录没有写权限 | 只能告诉你该怎么办 |
| 找不到 DSH 本体 | 只能告诉你该怎么办 |

认不出来的时候，它会**老实说"不确定"**，把真实报错原样摆给你看，而不是硬猜一个原因去乱改你的机器。

### 为什么敢让它在自己机器上跑

这是这类工具最该先回答的问题。

- **改任何文件之前，先备份。** 备份失败就中止整个流程 —— 没备份就动手是这套流程里最不可原谅的错
- **只做加法，不做减法。** 停用插件用的是 DSH 原生的 `disabled` 补丁，追加在文件末尾，**原始内容一个字节都不动**
- **从不删除你的任何东西。** 不删插件目录、不删会话记录、不删数据文件。连"清缓存"用的都是只读校验，而不是清空
- **不改你的 npm 全局配置。** 装包只在单条命令上临时指定源
- **重复跑不会出问题。** 备份前先算内容指纹，内容相同就复用 —— 连跑十次磁盘上还是那一份
- **换端口之前不杀任何进程。** 它只会去找一个空着的端口，不会去动占用端口的那个程序

### 开始用

```sh
npx dsh-tudian --dry-run     # 先看看问题在哪（只读，一个字节都不改）
npx dsh-tudian               # 确认没问题，就让它动手
```

Windows 用户不想碰命令行：双击 `一键修复.bat` 就行。

### 它是怎么来的

这个工具诞生于一次真实事故。

给 DSH 装一个语音插件，插件的目录放好了、启动配置里也登记了 —— 但漏了一步：忘了在依赖目录里建那条链接。结果 DSH 一重启就报 `Cannot find package` 然后整个进程退出。

**桌面上所有入口同时失效。** 连"打开工具看看怎么修"这件事都做不到。

事后复盘，那次故障的真正教训不是"忘了建链接"，而是：**当唯一的入口就是你要修的那个东西时，你手里必须有一个不依赖它的东西。**

所以 dsh-tudian 有三条硬规矩：**零依赖**（不靠 npm 也能跑）、**不写死任何路径和端口**（换台机器照样能用）、**只读优先**（先看清楚，再决定动不动手）。

---

## English

### The situation it is built for

Your DSH suddenly will not start.

Every shortcut on your desktop — the ones that all pointed at it — **stops working**. You have lost your entry point, which makes investigating the failure that much harder.

And the causes are annoyingly common: a freshly installed plugin, one hand-edited line of config, a port taken by another program, a Node version that is too old. Each one needs a different fix, and the error you get is usually a single line of English.

**dsh-tudian exists for that moment.** One command finds the cause and repairs whatever can be repaired.

### How it works

```
probe  →  diagnose  →  repair  →  verify  →  report
```

| Stage | What it does | Does it modify anything? |
|---|---|---|
| **Probe** | Environment checkup: OS / Node / npm / where DSH lives / profile / ports / config / existing backups / registry availability | **Read-only** |
| **Diagnose** | Determine the fault class, and report a **primary cause plus secondary findings** — not a menu of problems for you to sort out | Judgement only |
| **Repair** | Act, in order of increasing cost | **The only stage that writes** |
| **Verify** | Confirm over both port and HTTP that what came up really is DSH | Read-only |
| **Report** | Plain-language report: environment, findings, **every file touched**, outcome, next steps | Writes one log file |

The layering is deliberate: **probe reads, diagnose judges, only repair acts.**
That makes dry-run safety auditable at a glance — verifying that it does not secretly write anything means reading one file.

### What it can fix

| Fault | Automatic? |
|---|---|
| Plugin failed to load (exits at boot with `ERR_MODULE_NOT_FOUND`) | ✅ |
| Corrupted config file (`failed to parse patches`) | ✅ |
| Port occupied by another program | ✅ |
| Service simply not running | ✅ |
| Broken npm registry (`TAR_BAD_ARCHIVE`) | ✅ |
| Node version too old | Advice only |
| profile directory not writable | Advice only |
| DSH installation not found | Advice only |

When it cannot identify the cause, it **says so plainly** and shows you the real error output — rather than inventing a plausible reason and modifying your machine on the strength of a guess.

### Why it is safe to run on your own machine

This is the question such a tool should answer first.

- **Every file is backed up before it is touched.** If the backup fails, the whole run stops — modifying without a backup is the least forgivable mistake in this flow
- **It only adds, never subtracts.** Disabling a plugin appends a native `disabled` patch at the end of the file; **the original content is left byte-for-byte intact**
- **It never deletes anything of yours.** Not plugin directories, not session history, not data files. Even "clearing the cache" is a read-only verification rather than a wipe
- **Your global npm configuration is left alone.** Packages are installed with a per-command registry override
- **Running it repeatedly is harmless.** Backups are content-hashed and reused — run it ten times and you still have one backup
- **No process is ever killed.** If a port is taken it simply finds a free one

### Getting started

```sh
npx dsh-tudian --dry-run     # see what is wrong first (read-only, changes nothing)
npx dsh-tudian              # happy with the diagnosis? let it act
```

On Windows, you can also just double-click `一键修复.bat`.

### Where it came from

This tool was born out of a real incident.

A voice plugin was installed into DSH. Its directory was in place, it was registered in the startup config — but one step was missed: the link inside the dependency directory was never created. DSH restarted, reported `Cannot find package`, and the whole process exited.

**Every shortcut on the desktop stopped working at once.** It was not even possible to open a tool to investigate.

The real lesson was not "remember to create the link". It was this: **when the only entry point is the very thing that is broken, you need something in your hands that does not depend on it.**

Hence three hard rules for dsh-tudian: **zero dependencies** (it runs without npm), **nothing hardcoded** (no paths, no ports — it works on someone else's machine), and **read-only first** (look before you touch).

---

## License

MIT
