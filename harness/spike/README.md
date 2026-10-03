# harness/spike — 工具面 B 的运行时探针（E1–E6）

静态闸（`../tools/hook-liveness.mjs`）只能回答"上游有没有派发这个钩子"。这里回答的是另一半：**我们的模块真在上游里跑起来时，是什么样**。全部实验都不需要模型、不需要凭据、不花钱。

## 依赖与运行

```bash
# 一次性：把 pin 的那版 opencode 与插件 SDK 装到仓库外
mkdir -p /Volumes/Eng-Dev/.upstream/spike && cd /Volumes/Eng-Dev/.upstream/spike
printf '{"name":"glasspane-harness-spike","private":true,"type":"module"}\n' > package.json
npm i opencode-ai@1.18.32 @opencode-ai/plugin@1.18.32        # 真二进制在 node_modules/opencode-darwin-arm64/bin/opencode
npm i --prefix /tmp/bun-tools bun@1.3.14                     # 上游 packageManager 钉的版本；插件实际跑在 Bun 里
```

```bash
harness/spike/run.sh          # E1/E2/E6：装载 + 工具注册 + 工具体执行
harness/spike/run.sh --demo   # E5：上游自带离线模式，渲染权限卡与工具部件
```

`run.sh` 在依赖缺失时**明确报 SKIPPED 并非零退出**——它不会把"没跑"说成"通过"。

## 2026-09-24 实测结果（本机，pin = `v1.18.32`）

| # | 问题 | 结果 | 证据 |
|---|---|---|---|
| E1 | 以 `plugin: ["./plugin.ts"]` 形态写的插件会不会被上游装载 | **会**。`config` 钩子被访问并被调用，回调里拿到的 config 含 `plugin_origins[{spec, source, scope:"local"}]` | `hooks-fired.jsonl` |
| E2 | `gp_*` 工具名会不会被改名/加前缀 | **不会**。`GET /experimental/tool/ids` 返回 `"…","apply_patch","gp_probe_status"` —— 原样、无命名空间 | 实例路由需带 `?directory=`（不带会挂住），这是对接时的真实坑 |
| E5 | 权限请求真的发生时，引擎会不会派发 `permission.ask` | **没有**。`opencode --mini --demo --prompt "/permission"` 在终端上真渲染出了权限卡（`△ Permission required / → Edit src/demo-format.ts / Allow once / Allow always / Reject`），而插件侧被访问的钩子集是 `config, provider, event, dispose`——**不含 `permission.ask`**。`run.sh --demo` 现在把"卡片出现过"当成判定的**前置条件**：没出现就报 INCONCLUSIVE 并计一次失败 | 见下方"边界" |
| E5b | 工具部件在上游长什么样 | `/fmt bash` 输出是**纯文本行**（`$ git status` / `On branch demo` / `nothing to commit…`），没有结构化落点 | 与静态结论一致：`GenericTool` 之外无渲染器注册表 |
| E6 | 我们的工具体在上游的运行时（Bun）里能不能真的把证据取回来 | **能**。直接 `import` 插件默认导出 → 取 `hooks.tool.gp_probe_status.execute()` → 经 local socket 拿到 daemon 的 `hello` + `probe_status`，返回 `{title, output, metadata}`；`output` 里带 engine 版本与 daemon 自报权限（`accessibility: granted / developerTools: unverifiable`），metadata 带结构化体 | `REMEDY VISIBLE TO THE MODEL: yes`（模型只能看到 `output`，所以错误码与补救必须写进 `output`——这条已回写进 §5 的 M1 约束） |

**边界（如实）**：E5 走的是上游 `--demo` 通道，它"合成 SDK 事件、喂进真实 reducer 与 footer 管线"，**不经过 `Permission` 服务本身**。所以 E5 是旁证，不是决定性的。`permission.ask` 死钩子的决定性证据仍然是静态那三条：① 全树只出现一次＝`packages/plugin/src/index.ts:261` 的声明；② 宿主只按字面量名 `trigger(name, …)` 派发；③ `permission/index.ts`（223 行）对 plugin host 零引用。要把它升级成"运行时决定性"，需要一次真模型轮次（或上游肯加一个测试注入点）。

## 这条 E5 一开始是假绿（记下来，别再犯）

E5 的断言第一版写成"插件装载了 且 没观测到 `permission.ask`"→ PASS。第二次跑的时候权限卡**根本没出现**（进程在卡渲染前就被杀了），断言照样放行——测了个空。现在的形状是：**必须先看到被测量物出现过**（轮询 `demo.log` 里的 `Permission required`，最多 90 s），没看到就 INCONCLUSIVE 并计入失败；`hooks-fired.jsonl` 不存在则直接 FAIL。

`--mini` 还有一处会让探针静默失效：它按 **CWD** 选项目，不认 `--directory`。第一版从仓库根启动它，加载的是 GlassPane 这个没有插件的项目——同样是空测。`run.sh` 里那两行注释就是为这个。

## 为什么不进 CI

需要真二进制（`opencode-ai` 平台包）、Bun、以及本机在跑的 `glasspaned`。CI 里跑的是静态金样（`hook-liveness --offline`）与每周一次的上游探查（`harness-contract.yml`）；这个 runner 定位是**本地/发布前的实测**，以及将来 M1/M2 真模块落地时的固定点测试底子。

## 这批探针的复用价值

`plugin.ts` 里的记录器不是脚手架——**它就是 §6.1 说的 hook-liveness 运行时那一半**：Proxy 包住返回给宿主的 `Hooks` 对象，记录每一次属性访问（宿主只在真要派发时才读这个名字），declared 集合直接从 `../contracts/hook-liveness.json` 读，所以静态金样和运行时观测不可能各自漂移。等 fork 立起来，把它换成上游测试树里的固定点测试即可（那需要 `bun install` 整个 32 包 workspace）。

`mock-model.mjs` 同理：一个**确定性**的"总是调一次工具然后收尾"的假模型。真模型会偶尔不调工具，契约测试就不能那样写——所以这个假件是资产，不是临时品。
