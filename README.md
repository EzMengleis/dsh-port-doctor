# dsh-port-doctor

> 不用再手动 `netstat` + `tasklist` 了：让 agent 直接告诉你 3080 被谁占着、是不是它自己、该不该杀。

DSH（DeepSeek Harness）插件。注册一个面向模型的工具 **`port_doctor`**，诊断 `dsh web` 启动失败时的
`EADDRINUSE`。它只做判断，**不替你杀进程**——是否清理、复用还是换端口，决定权留给你。

## 它解决什么

```
Error: listen EADDRINUSE: address already in use 127.0.0.1:3080
```

这句话背后有三件完全不同的事，处置方式也完全不同：

| 实际情况 | 正确处理 |
| --- | --- |
| 就是你正在用的这个 DSH（最常见） | 换端口，**不能杀**（会连当前会话一起没） |
| 另一个还开着的 DSH 窗口 | 关掉那个窗口，或换端口 |
| 一个非 DSH 的程序（nginx / 别的 node 服务） | 换端口，别动它 |

`port_doctor` 把这三件事区分开，并给出占用进程的 PID、进程名、完整命令行、父进程、启动时间和 profile。

## 为什么是「按需诊断」而不是「启动时弹窗拦截」

这是本插件唯一重要的设计取舍，值得说清楚：

- ~~webserver 启动失败时插件介入弹窗~~ —— **做不到**。bind 失败发生在 webserver 自己的 fiber 里，
  cordis boot 会直接 fail-loud 退出；排在 webserver 后面的插件行**根本不会被挂载**。
- ✅ 注册一个诊断工具，由你或 agent 主动调用。端口冲突时你往往**已经有另一个 DSH 活着**
  （否则你也没法和 agent 对话），它正好能当「现场目击者」。

代价也要说明：**如果机器上一个 DSH 都没在跑，插件工具就调不到**。为此本包附带一个独立 CLI
（见下），DSH 完全起不来时也能用。

## 安装

```bash
# 本地开发（指向包含 package.json 的目录）
npx @deepseek-ai/dsh plugin --profile web add link:<插件目录的绝对路径>

# 从 Git 仓库（GitHub / Gitee 均可，需要本机有 git）
npx @deepseek-ai/dsh plugin --profile web add git+https://gitee.com/<用户名>/dsh-port-doctor.git
npx @deepseek-ai/dsh plugin --profile web add github:<用户名>/dsh-port-doctor

# 从 npm
npx @deepseek-ai/dsh plugin --profile web add dsh-port-doctor
```

装完检查 profile 的 `package.json`：`dependencies` 里要有 `dsh-port-doctor`，
并且 `dsh.profile.bundles` 里要出现它（GUI 的插件管理页会自动维护这一项；
手工装的话需要自己加，否则不会被加载）：

```json
"dsh": { "profile": { "bundles": ["...", "dsh-port-doctor"] } }
```

`patchReload: live` 的 profile 会热加载新插件，通常不用重启；否则 Ctrl+C 后重新启动。

> **`link:` 安装的额外要求**：pnpm 不会为被链接的包解析 peer 依赖，插件是从**真实目录**
> （`<插件目录>`）被加载的，所以那个目录里必须有能解析 `@deepseek-ai/dsh-tools`
> 的 `node_modules`。用「开发」一节里的目录联接即可；用 `github:` / npm 安装则不需要，
> 依赖由 dsh 安装自带的共享 `$DSH_HOME/profiles/node_modules` 提供。

## 用法

对 agent 说一句：

> 用 port_doctor 看看 3080 被谁占了

或不带参数（默认诊断**当前 DSH 自己服务的端口**）：

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `port` | integer | 要诊断的端口，1-65535；省略时用当前 DSH 的监听端口，再退到 3080 |
| `host` | string | 绑定地址，默认 `127.0.0.1` |
| `scan` | boolean | 被占用时是否向上扫描可用端口，默认 `true` |

输出示例（3080 被另一个 DSH 占用时的 CLI 视角；PID 与启动时间为示意值）：

```
[other-dsh] 端口 3080 被另一个 DSH 实例（PID 48210）占用。
  进程    node.exe  PID 48210  父进程 5512
  启动于  2026-01-01T09:00:00.0000000+08:00
  profile web
  命令行  "node" "...\@deepseek-ai\dsh\lib\bin.js" web
  监听    127.0.0.1:3080 (PID 48210)
  绑定    127.0.0.1:3080 → 失败（EADDRINUSE：listen EADDRINUSE: address already in use 127.0.0.1:3080）
  HTTP    401：这是 DSH Web（需要 dsh 启动时打印的鉴权令牌）
  建议
    · 另一个 DSH 实例正占用该端口（PID 48210，profile web）。
    · 它可能是一个还开着的窗口，也可能是上次没退干净的残留——看上面的启动时间和命令行再判断。
    · 确认那个实例不再需要：先正常退出（在那个终端按 Ctrl+C），再启动；确需强杀才执行 taskkill /PID 48210 /F。
    · 两个都要同时跑：换端口 npx @deepseek-ai/dsh web --port 3081
    · 当前可用端口：3081、3082、3083。
```

### 独立 CLI（DSH 起不来时）

```bash
node cli.js              # 诊断 3080
node cli.js 3081 --json  # 指定端口 + 机器可读输出
node cli.js --help
```

（发布到 npm 之后可以直接 `npx dsh-port-doctor ...`，参数完全相同。）

退出码：`0`=空闲，`1`=被占用，`2`=出错。适合写进启动脚本：

```bash
node cli.js 3080 && npx @deepseek-ai/dsh web
```

## 它怎么判断的

四步，任何一步都可能在坏环境下降级，但不会因此给出**虚假的「端口空闲」**：

1. **绑定探测**：真的 `listen` 一次再释放。这比 grep netstat 更接近「dsh 到底能不能起来」。
2. **监听者枚举**：Windows 用 `netstat -ano -p TCP`，macOS/Linux 用 `lsof -nP -iTCP:<port> -sTCP:LISTEN`
   （IPv4/IPv6 多条目会全部列出；PID 为 0 的 `TIME_WAIT` 行会被丢掉）。
3. **进程身份**：Windows 用 `Get-CimInstance Win32_Process` 一次取回进程名、完整命令行、
   父进程、启动时间（`wmic` 在 Win11 24H2 已被移除，所以不用它）；取不到再退回 `tasklist`。
4. **HTTP 指纹**：DSH Web 在未带鉴权令牌时固定返回
   `401 dsh web authentication required; ...`，比「进程名叫 node」可靠得多。
   命中 `__DSH_BOOT__`、该 401 文案或 `DeepSeek Harness` 都判为 DSH。

结论枚举：

| verdict | 含义 | 建议 |
| --- | --- | --- |
| `free` | 该地址可绑定 | 直接启动 |
| `self` | 占用者就是当前这个 DSH 进程 | 换端口，**别杀** |
| `other-dsh` | 另一个 DSH 实例 | 关掉它或换端口 |
| `other-node` | 另一个 node 进程 | 换端口，别动它 |
| `other-process` | 非 node 程序 | 换端口 |
| `unknown` | 拿不到 PID（权限/系统保留） | 换端口 + 手工排查 |

## 配置（可选）

在 profile 补丁行里覆盖默认值：

```yaml
- id: port-doctor
  name: dsh-port-doctor
  config:
    port: 3080
    host: 127.0.0.1
```

优先级：工具参数 > 插件 config > 当前 DSH 监听端口 > 内置默认 3080。

## 边界与已知限制

- **绝不杀进程**。杀进程是不可逆动作，且「上次残留的 dsh」和「你另一个正在用的窗口」从进程信息上
  无法可靠区分。需要清理时，报告里会给出确切的 `taskkill /PID <pid> /F`，由你确认后执行。
- Windows 下取命令行依赖 `powershell.exe`（系统自带 5.1 即可）；被策略禁用时会降级成只有进程名。
- 非 HTTP 服务只会报「HTTP 探测无响应」，不影响 PID/命令行判断。
- 只探测 TCP。UDP 端口冲突不在 DSH Web 的范畴内。
- 权限不足（例如占用者是别的用户的服务）时拿不到 PID，结论为 `unknown`。

## 开发

```bash
node --test "*.test.mjs"
```

测试会真的在本机开/关端口做端到端诊断（含「自己占着自己」和「假 DSH 401」两个场景）。
插件层测试需要能解析 `@deepseek-ai/dsh-tools`；解析不到时那组用例会自动跳过。链接一次即可：

```
mklink /J <本目录>\node_modules\@deepseek-ai ^
          %USERPROFILE%\.dsh\profiles\node_modules\@deepseek-ai
```

（`node_modules/` 已在 `.gitignore` 里，不会被提交。）

仓库是**平铺结构**（没有 `lib/`、`bin/` 子目录）：`index.js` 注册工具，`engine.js` 是
与框架无关的诊断内核，`cli.js` 是独立命令行入口，`*.test.mjs` 是测试。整包只有 10 个文件
（含 `.gitignore` 与两个测试文件），安装、审阅、上传都更省事。

## 兼容性

- Node.js >= 20
- DSH `0.2.x`（`@deepseek-ai/dsh-tools`、`@deepseek-ai/schemastery` 均为**可选** peer 依赖，
  由 dsh 安装自带的共享 `node_modules` 提供）
- 主路径 Windows 10/11；macOS / Linux 走 `lsof` + `ps` 回退路径

## 发布

```bash
git init
git add -A && git commit -m "feat: dsh-port-doctor v1.0.0"
git branch -M main

# 任选其一：GitHub 或 Gitee
git remote add origin https://github.com/<用户名>/dsh-port-doctor.git
git remote add origin https://gitee.com/<用户名>/dsh-port-doctor.git

git push -u origin main
git tag -a v1.0.0 -m "v1.0.0" && git push --tags

# 可选：发 npm（peerDependencies 全是 optional，不会拖进来一堆 @deepseek-ai 包）
npm publish
```

发布前记得在 `package.json` 里补 `repository` / `homepage` / `bugs` / `author`。

## License

MIT

---

### English

`dsh-port-doctor` is a DeepSeek Harness plugin that registers a `port_doctor` tool. When `dsh web`
fails with `EADDRINUSE`, it reports the real owner: PID, image name, full command line, parent PID,
start time, dsh profile, an HTTP fingerprint that tells another DSH apart from unrelated services,
and concrete next steps (reuse / relaunch on a free port / kill after you confirm). It never kills
anything itself. A standalone `dsh-port-doctor` CLI covers the case where DSH cannot boot at all.

Install: `npx @deepseek-ai/dsh plugin --profile web add <this package>`.
