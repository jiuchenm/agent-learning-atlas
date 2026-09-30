# WorkBuddy：模式配置怎样变成模型上下文

WorkBuddy 是桌面 Agent 应用。你在界面里选 Craft 或 Plan，应用就要把这个选择转成模型可接收的指令和工具配置，并为执行工具设置权限。这里的**模型上下文**指一次调用时提供给模型的材料，例如系统提示词、用户消息和工具定义。本篇只跟踪模式配置参与装配的部分：模板怎样得到变量并变成文本，工具与权限怎样另行合并，结果怎样被交给下游。聊天历史的完整处理不在这条链路里。

Craft 用于直接推进任务，Plan 强调先形成方案。假设你先在 Craft 中讨论订单导出脚本，随后切到 Plan，说“先列方案”。这时工具配置仍列出 `Write` 和 `Bash`，系统模板的选择入口也仍是 Craft。要判断切换是否失败，需要分清三个问题：提示词告诉模型怎样做；工具配置提供可用工具的候选；权限配置交给运行时判断怎样执行。**模式名称不能单独回答这三个问题。**

依据是 2026-09-28 原核验记录中的 WorkBuddy 5.6.2 安装包；2026-10-01 改稿时重查关键片段，包 hash 仍一致。下面跟踪的是 legacy mode handler 路径，也就是由宿主的模式处理器生成配置的分支。安装包另有 CLI addon composition 分支，允许命令行运行端组合附加内容，后文会说明它怎样改变传参。例子的配置和结果均为静态代码手动推导；没有读取用户配置、运行供应商代码或捕获真实模型 payload。源码行号相对安装包条目；[公开报告](https://jiuchenm.github.io/workbuddy-study/#S04)提供证据定位目录，未公开这些源码全文。

## 从一次 Craft→Plan 切换开始

订单脚本例子先固定输入。`ModeService.resolveOptions` 接收以下教学配置，目录、模型和会话 ID 都是假设值；没有显式 `tools`、`systemPrompt` 或 `expertId`，也没有声明 MCP。假设所需模板存在，下游未启用 CLI addon composition。这样才能看清模式本身贡献了什么。

```json
{
  "mode": "craft",
  "welcomeMode": "code",
  "model": "demo-model",
  "cwd": "C:/demo/orders",
  "sessionId": "demo-session-01",
  "hasDeclaredMcp": false
}
```

两个 mode 字段职责不同。`mode` 指这轮采用 Craft、Plan 等哪种交互方式；`welcomeMode` 指 code、work、design 哪种任务方向。切到 Plan 后，任务仍是修改代码，后者保持 code。归一化函数还把历史值 coding、working 转为 code、work。只记“用户选了 Plan”，会遗漏模板选择所需的任务方向。（`main/tar.js` L22540–22546；[S06 定位](https://jiuchenm.github.io/workbuddy-study/#S06)。）

`ModeService` 是协调这次装配的服务。它按 `mode` 选择模式处理器（handler），由处理器生成提示词、工具和权限的默认配置。`DefaultModeHandler` 处理 craft、ask、plan、quick；`ExpertModeHandler` 处理 expert，且要求传入 expertId。缺省模式按 craft 处理；这个入口遇到未知模式会原样返回输入，上游的归一化是另一个环节。（`main/tar.js` L44572–44602、L44620–44638；[S05 定位](https://jiuchenm.github.io/workbuddy-study/#S05)。）

现在只把输入的 mode 改为 plan。`DefaultModeHandler.resolve` 将选择拆成两路：给提示词渲染器的 `promptMode` 是 craft，查工具表的 `toolsMode` 是 plan，权限则强制为 plan。下表是按已读代码推导的结果；模板 kind 是渲染器用来查找模板的类别名。

| 装配项 | Craft 输入 | 切到 Plan 后 |
| --- | --- | --- |
| 请求模式 | craft | plan |
| renderer 接收的模式 | craft | craft |
| 模板 kind | normal-code | normal-code |
| 默认工具 | CRAFT_TOOLS | CRAFT_TOOLS 加 EnterPlanMode、ExitPlanMode |
| permissionMode | bypassPermissions | plan |

`CRAFT_TOOLS` 包含 Read、Write、Bash 等工具，`PLAN_TOOLS` 继承它再加两个计划工具，因此切到 Plan 后仍能看见写工具。表中描述的是配置结果；要证明某次写操作实际获准，还需检查 CLI 的权限执行与工具结果。本例也没有切换模型权重，两次渲染出的文本仍可能因日期、环境、记忆变化而不同。（`main/tar.js` L22349–22418、L22508–22514、L44527–44556；[S05](https://jiuchenm.github.io/workbuddy-study/#S05)、[S06 定位](https://jiuchenm.github.io/workbuddy-study/#S06)。）

处理器返回后，ModeService 做字段覆盖（overlay）：先以生成的配置为底，再覆盖输入中非 `undefined` 的字段，最后重新放回处理器提供的 `mcpConfig`、`permissionMode`、`model`。所以显式 tools 能覆盖默认工具，显式权限却还受处理器结果约束。以下是原创教学伪代码，只表达这个合并顺序，不是可执行的供应商实现：

```python
generated = await handler.resolve(input_options)
merged = copy(generated)
for key, value in input_options.items():
    if value is not undefined:
        merged[key] = value
for key in ["mcpConfig", "permissionMode", "model"]:
    if generated.get(key) is not undefined:
        merged[key] = generated[key]
```

按原条件，这一步输出的是已解析配置：普通代码模板的渲染结果、Plan 工具集合、plan 权限，以及输入的 demo-model。它尚未输出模型回答，也未执行订单脚本。（`main/tar.js` L44632–44638；[S05 定位](https://jiuchenm.github.io/workbuddy-study/#S05)。）

权限还需保留两个具体条件。`isPermissionModeWeakerThanSceneDefault` 在场景默认为 bypassPermissions 时，将显式 default、acceptEdits 判为应忽略的值；不要仅凭函数名猜含义。Plan 有单独强制分支，即使输入 bypassPermissions，也仍得到 plan。退出 Plan 时，`normalizeDesiredConfig` 若发现 mode 已离开 plan、旧权限仍为 plan，就尝试恢复合法的 `permissionModeBeforePlan`，否则回到 bypassPermissions；后续仍需经过 handler。这解释了为什么持久配置与最终结果要分别检查。（`main/tar.js` L22617–22637、L22715–22718、L44546–44550；[S05](https://jiuchenm.github.io/workbuddy-study/#S05)、[S06 定位](https://jiuchenm.github.io/workbuddy-study/#S06)。）

## collectors 怎样把配置补成可渲染的材料

模板是一份带变量位置的文本；只有知道工作目录、语言、身份和记忆等具体值，才能渲染成这次会话的提示词。`PromptRendererImpl` 把取值工作交给收集器（collector）。每个收集器处理一种来源，将结果写入同一份 `vars` 变量表。本例中，EnvCollector 从输入得到 workDir 为 C:/demo/orders、modelId 为 demo-model；其他内容取决于相应来源和开关，不能从这几个输入字段推导出来。

渲染器按数组顺序逐个 `await` 收集器：EnvCollector 填环境和响应语言；IdentityCollector、PersonalizationCollector 填身份、语气与自定义指令；MemoryCollector、UserMemoryCollector 处理本地和用户记忆；CollaborationCollector 处理工具结果呈现与适用的连接提示；最后是 ExpertPromptSlotCollector、ExpertManagementCollector、BinaryCollector，处理专家内容、管理开关和随附工具环境。循环完成后才合入 native runtime 可用性变量。这个顺序指收集器之间；例如 IdentityCollector 内部仍用 Promise.all 读取它负责的文件。（`main/tar.js` L42950–43001、L43519–43545、L44451–44459、L44484–44499；[S04 定位](https://jiuchenm.github.io/workbuddy-study/#S04)。）

收集器被调用，并不意味着一定贡献文本。UserMemoryCollector 在未登录、功能关闭或结果为空时可写入空字符串；没有专家上下文时，ExpertPromptSlotCollector 也返回空内容。MemoryCollector 读取工作目录的记忆，不能据此认定完整聊天历史已经装入模板。更后面还有一道条件：模板必须引用某个变量，它才会成为渲染文本的一部分。（`main/tar.js` L43111–43139、L43735–43805、L44168–44205；[S04 定位](https://jiuchenm.github.io/workbuddy-study/#S04)。）

handler 先收集变量，再把这份结果按同一个 options 对象的身份存入 WeakMap；随后 `renderSystemPrompt` 可取回它，避免这次装配重复收集。WeakMap 是按对象身份关联值的映射，这里没有建立按 sessionId 永久复用的会话缓存。Nunjucks 模板引擎再把模板与 vars 合成为字符串。此时完成的是提示词文本的生成，是否发送仍由下游决定。（`main/tar.js` L44423–44449；[S04 定位](https://jiuchenm.github.io/workbuddy-study/#S04)。）

显式 systemPrompt 也有细节：handler 先收集变量，然后才用空值合并运算选择输入字符串或模板结果。因此提供自定义提示词可以替代模板渲染，但这段代码仍会先尝试收集来源。串行调用让变量写入次序明确，也意味着后一个收集器要等前一个完成；二进制环境读取失败会记录警告，用户记忆失败可退化为空。这些局部处理不证明所有收集器都不会抛错，也没有给出延迟或缓存收益的实测结果。（`main/tar.js` L42822–42849、L44203–44205、L44544–44553、L44592–44601；[S04](https://jiuchenm.github.io/workbuddy-study/#S04)、[S05 定位](https://jiuchenm.github.io/workbuddy-study/#S05)。）

用户上下文（user context）有独立的 `renderUserContext` 入口：它重新顺序调用 collectors，再按 expertId 选择 user-context 或 user-context-expert 模板。注释将其定位为首条用户消息的隐含上下文，用来将身份、语气等与可复用系统模板分开。函数本身只返回字符串，也未用上述 WeakMap；它不能证明每轮都重新注入，collector 自身的缓存另算。（`main/tar.js` L44461–44480；[S04 定位](https://jiuchenm.github.io/workbuddy-study/#S04)。）

## 模板存在，为什么还不能认定它正在生效

回到没有 expertId 的订单例子，`selectTemplateKind` 选择 normal family，与 welcomeMode code 合成 normal-code。`TEMPLATE_NAMES` 将它映射到 workbuddy-craft-code-prompt.tpl。加载器（loader）先找这个文件，缺少变体时才回退到 normal 对应的 workbuddy-prompt.tpl；基础文件也不存在会抛错。因而“选择了 normal-code”和“读到了代码专用模板”仍有区别。（`main/tar.js` L44415–44421、L44672–44726；[S07 定位](https://jiuchenm.github.io/workbuddy-study/#S07)。）

搜索先考虑宿主提供的 runtime 模板目录，再考虑基于进程 cwd 的开发、测试路径。安装包中另有 resources/plugins/workbuddy-builtin/welcomemode/work/prompt.tpl，它按 workMode include 不同 interactionmode 片段。但文件在磁盘上，并不能证明它就是本例加载到的模板；需要实际路径和调用分支才能将两者对应起来。（`main/tar.js` L43873–43894；该 prompt.tpl L5–L8；[S07](https://jiuchenm.github.io/workbuddy-study/#S07)、[S08 定位](https://jiuchenm.github.io/workbuddy-study/#S08)。）

下游的 `buildAgentCliRuntimeArgs` 还会检查 addon manifest，即描述附加内容及组合方式的清单。若 `expanded.compose.cliComposeEnabled` 为 true，且 systemPrompts 列表有 `source: "work_mode"`，就抑制 legacy system prompt 参数；tools 列表出现同类来源时，才单独抑制 legacy `--tools`。这两项独立判断，`--permission-mode` 仍会组装。补充证据是 `main/server.js` L174227–174254，未收录在上述公开 S04–S08 定位目录中。

本例排除了 addon composition，所以可继续推导：若生成的系统提示词文本或文件路径已传给该函数，它会加入相应的 legacy 参数；工具字符串会加入 `--tools`，权限会加入 `--permission-mode plan`。但 CLI 接收参数之后怎样组成请求、模型最终收到什么，仍需继续取证。**handler 输出、CLI 参数、真实模型 payload 是三个观察位置。** 仅统计安装包文件数量，也不能得出上下文容量；文件需经过选择、加载和实际发送，才会成为某次请求的材料。

## 残留 expertId 怎样改变同一次选择

只改一个条件：切到 Plan 时，输入仍带 `expertId: "demo-expert"`。DefaultModeHandler 虽将 promptMode 改为 craft，却照样传入 expertId。renderer 以它计算 isExpert 为真；选择函数先判断 quick、expert、ask，其他情况才看 isExpert，所以这次选 expert-code，权限仍为 plan。（`main/tar.js` L44415–44421、L44444–44454、L44528–44543；[S04](https://jiuchenm.github.io/workbuddy-study/#S04)、[S05 定位](https://jiuchenm.github.io/workbuddy-study/#S05)。）

附近注释概括“scene mode 优先于 expertId”，实际分支只对 quick、expert、ask 明确优先，craft 和 plan 仍可选专家模板。renderUserContext 也直接按 expertId 选择模板，collector 的专家判断同样依赖它。因此残留字段可能同时影响模板和变量。这个条件路径已在代码中核对，但尚未验证上游切换是否真的留下 expertId；上游也可能清理字段，显式 systemPrompt 或 CLI composition 还可能替代这份渲染结果。

如果排查真实切换，应先对应切换前后输入、选中的 handler、template kind、解析到的文件、合并配置与下游 CLI 参数，再看请求 payload。这样才能判断是哪一步沿用了旧状态。读到选择函数只能证明条件满足时会走哪个分支，不能证明当前用户已经遇到这个缺陷。

<details>
<summary>面试怎么回答</summary>

一分钟回答：WorkBuddy 将界面模式转换成提示词、工具和权限配置。在已核验的 legacy 路径中，ModeService 选 handler；handler 把 Plan 的 promptMode 映射为 Craft，同时保留 Plan 工具模式并强制 plan 权限。renderer 用 collectors 收集环境、身份、记忆等变量，选择并加载模板，再渲染为文本。ModeService 随后覆盖显式字段，并重新保留处理器指定的权限等字段。最后还要检查 CLI addon composition 是否抑制 legacy 参数。要知道模型实际收到了什么，必须取得对应请求，不能凭模板文件存在来判断。

追问一：Plan 中出现 Write，是否说明权限失效？工具候选和执行权限是不同环节；这版 Plan 默认继承 Craft 工具。应继续核对 permissionMode 与实际执行结果，不能用名称列表代替一次写操作获准的证据。

追问二：为什么切回 Craft 仍可能选专家模板？在 expertId 残留的条件下，craft 分支仍会检查 isExpert。要确认当前故障，还需证明输入确实残留，且模板结果没有被显式 Prompt 或下游组合分支替代。

追问三：自定义 systemPrompt 是否意味着完全不读记忆？这段 handler 先收集变量，才选择显式字符串或模板渲染结果，所以不能这样断言。具体读取是否成功、最终文本包含什么仍是不同证据。

</details>

练习：沿用订单例子，切到 Plan 时保留 `expertId: "demo-expert"`，显式传入 `tools: "Read,Grep"` 与 `permissionMode: "bypassPermissions"`。未提供 systemPrompt，所需模板存在，未启用 CLI composition。推导 template kind、合并后的 tools 和 permissionMode。随后开启 CLI composition，且仅 systemPrompts 有 work_mode 来源，还能断言该模板就是实际系统提示词吗？

<details>
<summary>练习参考思路</summary>

按代码手动推导，template kind 为 expert-code：Plan 映射到 craft，但 expertId 仍为真。tools 为 Read,Grep，因为显式字段覆盖默认集合；permissionMode 为 plan，因为处理器强制的值在合并末尾再次覆盖输入。开启组合且 systemPrompts 有 work_mode 后，legacy system prompt 参数被抑制，不能认定该模板进入实际请求。legacy tools 是否被抑制仍需单独检查 tools 列表；题设的 systemPrompts 条件本身不足以抑制它。这些结果没有通过运行 WorkBuddy 会话验证。

</details>
