# WorkBuddy：模式配置怎样变成模型上下文

假设你让 WorkBuddy 修改一份订单导出脚本，先在 Craft 中讨论实现，随后切到 Plan，要求先列方案。检查工具配置时却仍能看见 `Write` 和 `Bash`；再看系统模板，竟然沿用了 Craft 的选择入口。这是否意味着切换失败？要回答它，必须跟踪模式字段怎样分别进入提示词、工具集合和权限配置。页面上的一个模式名称，未必对应一份独立 Prompt。

WorkBuddy 是桌面 Agent 应用；Craft 和 Plan 是界面提供的两种工作模式，前者用于直接推进任务，后者强调先形成方案。模式名只是用户选择的入口，模型最终看见的指令、可用工具和权限要由后续代码组合。本篇以 2026-09-28 只读核验的 WorkBuddy 5.6.2 安装包为依据，跟踪其中的 legacy mode handler 路径。安装包也有由 CLI 组合 addons 的分支，后文会说明它怎样影响最终输入。所有会话参数和切换结果都是按代码推导的假设，没有读取当前用户配置、运行供应商代码或捕获实际模型请求。正文中的行号相对安装包条目，例如 `main/tar.js`；[公开报告](https://jiuchenm.github.io/workbuddy-study/#S04)提供证据定位目录，并未公开这些源码全文。

## 从一次 Craft→Plan 切换开始

先把教学条件固定下来：应用传给 `ModeService.resolveOptions` 的初始配置如下。`demo-model`、目录和会话 ID 都是假设值；没有显式 `tools`、`systemPrompt` 或 `expertId`，没有声明 MCP。假设下游也未启用 CLI addon composition，并且所需模板文件存在。这样可以观察模式自身提供的默认值，而不把其他覆盖项混进来。

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

`ModeService` 根据 `mode` 找 handler，缺省按 `craft` 处理。`DefaultModeHandler` 负责 craft、ask、plan、quick；`ExpertModeHandler` 负责 expert，且要求存在 `expertId`。handler 先生成模式配置，service 再把输入中非 `undefined` 的字段覆盖上去，最后把 handler 提供的 `mcpConfig`、`permissionMode`、`model` 再放回结果。因此显式工具集合可以覆盖模式默认工具，但权限不能简单按“输入最后出现，所以输入获胜”理解。未知模式在此入口会原样返回；上游归一化属于另一个边界。（`main/tar.js`，`ModeService` L44620–44638，`ExpertModeHandler` L44572–44602；[S05 定位](https://jiuchenm.github.io/workbuddy-study/#S05)。）

输入里的两个 mode 也需要分开。`mode` 表示本轮交互场景，`welcomeMode` 表示 code、work、design 这一类任务方向；本例切换交互方式，仍然处理代码，所以 welcomeMode 保持 code。归一化函数还把历史值 coding、working 转为 code、work。这样的拆分允许同一种交互模式选择不同任务模板，却也意味着排查时只记下“Plan”会丢失一部分选择条件。（`main/tar.js`，`normalizeWelcomeMode` L22540–22546；[S06 定位](https://jiuchenm.github.io/workbuddy-study/#S06)。）

现在只把输入的 `mode` 改为 `plan`，其他条件不变。`DefaultModeHandler.resolve` 把 requestedMode 分成两路：`promptMode` 得到 craft，`toolsMode` 保留 plan，并把 `permissionMode` 强制设为 plan。下面是原创、简化的控制流伪代码，只表达本例，不包含完整的覆盖、MCP 或错误处理：

```python
def explain_switch(requested_mode):
    prompt_mode = "craft" if requested_mode == "plan" else requested_mode
    tool_names = default_tools_for(requested_mode)
    permission = default_permission_for(requested_mode)
    template_kind = choose_template(prompt_mode, expert_id=None, welcome="code")
    variables = collect_in_order()
    return render(template_kind, variables), tool_names, permission
```

按本例条件，装配结果是：

| 项目 | Craft 输入 | 切到 Plan 后 |
| --- | --- | --- |
| 请求模式 | craft | plan |
| 传给 renderer 的模式 | craft | craft |
| 模板 kind | normal-code | normal-code |
| 默认工具 | CRAFT_TOOLS | CRAFT_TOOLS 加 EnterPlanMode、ExitPlanMode |
| permissionMode | bypassPermissions | plan |

这里没有切换模型权重，也没有保证两次渲染出的文本逐字相同：日期、记忆和环境变量仍可能变化。能够确定的是模板选择入口相同，工具模式和权限发生变化。Plan 的含义由多处配置共同表达。（`main/tar.js`，`DefaultModeHandler.resolve` L44527–44556；[S05 定位](https://jiuchenm.github.io/workbuddy-study/#S05)。）

回到订单脚本，用户输入“先列方案”之后，本例可推导到的输出是这份已解析配置：代码方向的普通模板、计划模式的工具集合、计划权限，以及原模型和工作目录。模型随后是否提出“先检查分页，再设计修改，最后验证”，属于另一层输出；本次没有发请求，不能伪造这段回答。配置解释解决的是模型在什么条件下工作，业务验证还要检查它实际读了什么、调用了什么，以及是否修改了文件。

## 工具名称、许可策略与行为指令分别负责什么

工具集合告诉运行时配置了哪些能力名称；Prompt 告诉模型怎样处理任务；`permissionMode` 进入运行时的许可策略。前两者不能代替第三者。因此 Plan 集合里仍包含写文件与命令工具，并不能单独证明这些动作可以立即执行。反过来，一段“只做计划”的自然语言也不足以证明执行层会阻止写入。本篇只确认字段传递，没有审计 CLI 内每种工具的具体拒绝条件。

安装包里的 `PLAN_TOOLS` 直接扩展 `CRAFT_TOOLS`，Expert 默认也使用 Plan 集合。Ask 在这张配置表中只有 Read、WebFetch、WebSearch、Glob、Grep；Quick 是空字符串。默认权限表给 Craft、Expert、Quick 配置 `bypassPermissions`，Ask 为 `default`，Plan 为 `plan`。这些是此版本的运行默认配置，不能当作当前用户实际会话配置；`bypassPermissions` 这个字段也没有证明连接器授权或其他执行边界被取消。（`main/tar.js`，`MODE_TOOLS_CONFIG` L22349–22409、`DEFAULT_MODE_PERMISSION_CONFIG` L22508–22514；[S06 定位](https://jiuchenm.github.io/workbuddy-study/#S06)。）

覆盖顺序还有一个容易漏掉的条件。`isPermissionModeWeakerThanSceneDefault` 在场景默认是 bypassPermissions 时，把传入的 default 或 acceptEdits 判为需要忽略的值，handler 随后采用场景默认。无论怎样理解函数名中的 weaker，代码比较的就是这两个字符串。Plan 又有独立强制分支，所以即使本例额外传入 `permissionMode: "bypassPermissions"`，最终仍是 plan。排查时应看实际条件和合并结果，不能只读“用户显式值”这样的概括。（`main/tar.js` L22715–22718、L44546–44550、L44632–44637；[S05](https://jiuchenm.github.io/workbuddy-study/#S05)、[S06 定位](https://jiuchenm.github.io/workbuddy-study/#S06)。）

退出 Plan 则还有恢复状态的问题。`normalizeDesiredConfig` 遇到 mode 为 plan 时直接归一化出 plan 权限；mode 已离开 plan、原权限却仍为 plan 时，尝试使用合法的 `permissionModeBeforePlan`，否则采用 bypassPermissions。这个字段保存切换前的许可信息，使“退出计划”不只是删掉一个字符串。但最终值仍要经过后面的 handler；只检查持久配置，不能代替检查整个装配结果。（`main/tar.js`，`normalizeDesiredConfig` L22617–22637；[S06 定位](https://jiuchenm.github.io/workbuddy-study/#S06)。）

## collectors 怎样把配置补成可渲染的材料

模板只规定文本结构，还需要具体变量。`PromptRendererImpl` 把这些工作分给收集器（collector）：每个收集器读取自己负责的来源，把结果写入同一份 `vars`。实现采用逐个 `await`，不是把所有收集器并行启动；代码中的数组确定了调用顺序。（`main/tar.js`，`collectSystemPromptVariables` L44451–44459、`getCollectors` L44484–44499；[S04 定位](https://jiuchenm.github.io/workbuddy-study/#S04)。）

顺序先是 `EnvCollector`，补入目录、平台、模型标识和响应语言等环境信息；接着是 `IdentityCollector` 与 `PersonalizationCollector`，处理身份文件、语气和自定义指令。之后 `MemoryCollector` 提供本地记忆相关变量，`UserMemoryCollector` 处理用户记忆，再由 `CollaborationCollector` 填入工具结果呈现及适用的连接提示。最后依次是 `ExpertPromptSlotCollector`、`ExpertManagementCollector`、`BinaryCollector`，负责专家内容、专家管理开关和随附工具环境。循环结束后才合入 native runtime 可用性变量。

调用某个收集器不代表它必定贡献内容。例如用户记忆在未登录、功能关闭或结果为空时可写入空字符串；专家 Prompt 收集器在没有专家上下文时也返回空内容。`MemoryCollector` 会读取工作目录的记忆，但这不等于完整聊天历史已被装入模板。收集器产生变量，模板还要实际引用变量，文本才会出现在渲染结果中。（`main/tar.js`，各 collector 实现 L42822–43002、L43111–43139、L43515–43549、L43735–43805、L43934–43963、L44168–44205；[S04 定位](https://jiuchenm.github.io/workbuddy-study/#S04)。）

handler 可以先收集一次变量，并以同一个 options 对象为键存进 WeakMap；随后 `renderSystemPrompt` 读取这份结果，避免重复收集。这里的复用范围依赖对象身份，不是给同名会话建立一个永久缓存。渲染器最终用 Nunjucks 把模板和变量合成字符串。这一步产出文本，尚未证明文本已发送给模型。

顺序执行让变量写入次序明确，但也有代价：后面的收集器要等待前面的异步读取结束。当前代码还保留各自的失败处理，例如二进制工具环境读取失败会记录警告，用户记忆失败会退化为空。由此只能推断它们允许部分材料缺失时继续装配，不能推断所有收集器都不会抛错，更不能给出启动延迟或缓存收益。核验性能需要运行测量，本次静态阅读没有这类结果。

显式 Prompt 也不会自动取消前面的收集动作。handler 先调用 `collectSystemPromptVariables`，然后才用空值合并运算选择输入的 systemPrompt 或模板渲染结果。因此“没有使用模板文本”和“没有读取上下文来源”是两件事。若自定义 Prompt 的行为与预期不同，需要同时查看显式字符串、收集到的变量及后续传递位置，而不只是比较模板文件。（`main/tar.js` L44544–44553、L44592–44601；[S05 定位](https://jiuchenm.github.io/workbuddy-study/#S05)。）

用户上下文（user context）另有 `renderUserContext` 入口。它再次按顺序运行 collectors，按是否存在 expertId 选择 `user-context` 或 `user-context-expert`，再渲染成独立文本。代码注释将其用途说明为首条用户消息的隐含上下文，让身份、语气等与可复用系统模板分开；该函数本身只返回字符串，不能凭它断言每轮消息都重新注入。这里也没有使用前述 WeakMap 复用逻辑，部分 collector 自己的缓存是另一回事。（`main/tar.js`，`PRECOLLECTED_SYSTEM_PROMPT_VARIABLES` L44423–44430、`renderSystemPrompt` L44443–44449、`renderUserContext` L44467–44480；[S04 定位](https://jiuchenm.github.io/workbuddy-study/#S04)。）

## 模板存在，为什么还不能认定它正在生效

本例没有 expertId，`selectTemplateKind` 会选 normal family，再结合 `welcomeMode: "code"` 得到 normal-code。`TEMPLATE_NAMES` 将它映射到 `workbuddy-craft-code-prompt.tpl`。loader 先搜索该文件；找不到变体时，才按 `FALLBACK_KIND` 回到 normal，对应 `workbuddy-prompt.tpl`。基础模板也不存在时会抛错，不是自动得到一段空 Prompt。（`main/tar.js`，`selectTemplateKind` L44415–44421、`TEMPLATE_NAMES` L44672–44687、`createTemplateLoader` L44714–44726；[S07 定位](https://jiuchenm.github.io/workbuddy-study/#S07)。）

文件搜索首先考虑宿主提供的 runtime 模板目录，随后还有基于进程 cwd 的开发、测试候选路径。另一方面，安装包确实含有 `resources/plugins/workbuddy-builtin/welcomemode/work/prompt.tpl`，其中 L5–L8 根据 `workMode` include 各种 interactionmode 片段。但找到这份材料，不能证明它就是上面 normal-code 的加载结果；要把两者连起来，还需确认本次配置、实际路径与调用分支。（`main/tar.js`，`listWorkbuddyPromptTemplateDirCandidates` L43873–43894；[S07](https://jiuchenm.github.io/workbuddy-study/#S07)、[S08 定位](https://jiuchenm.github.io/workbuddy-study/#S08)。）

更下游还有一个会改变结论的分支：`buildAgentCliRuntimeArgs` 检查 addon manifest。若 `expanded.compose.cliComposeEnabled` 为 true，且 systemPrompts 中有 `source: "work_mode"`，就不传 legacy system prompt 参数；tools 中出现同类来源时，则单独抑制 legacy `--tools`。两项判断彼此独立，`--permission-mode` 仍会组装。于是“handler 生成了配置”和“CLI 采用了该配置文本”之间，还隔着一次选择。本例排除了这个分支；真实排查必须看具体 manifest。本次只读核验补充定位为 `main/server.js`，`shouldSuppressLegacySystemPrompt`、`shouldSuppressLegacyTools`、`buildAgentCliRuntimeArgs` L174227–174254；该片段未收录在上述公开 S04–S08 目录中。

这也是为什么不能把安装包中的文件数量解释成上下文容量。一个文件可能只是候选材料，只有满足选择条件、完成加载并进入发送路径，才成为这次请求的一部分。顺着文件目录阅读，可以理解产品提供了哪些内容；顺着调用链阅读，才能知道程序可能怎样使用这些内容；要回答“我刚才那次用了哪份”，仍然需要对应会话的运行证据。三种问题需要的证据不同，前一种阅读再完整，也补不上最后一步。

## 残留 expertId 怎样改变同一次选择

把本例稍改一下：用户切到 Plan，但输入还残留 `expertId: "demo-expert"`。`DefaultModeHandler` 会把 promptMode 改成 craft，却照样向 renderer 传递 expertId。`renderSystemPrompt` 据此计算 `isExpert=true`；`selectTemplateKind` 先判断 quick、expert、ask，其他情况再看 isExpert。因此这次会选 expert-code，而非 normal-code。权限仍为 plan。

这里必须核对代码而非只信注释。附近注释概括为“scene mode 优先于 expertId”，实际分支仅对 quick、expert、ask 作明确优先判断，craft 和 plan 仍可落入 isExpert 分支。`renderUserContext` 更是直接按 expertId 选专家模板；collector 的专家判断也依赖这个字段。残留值因此可能同时影响模板和变量，单改页面上的模式名称未必足够。（`main/tar.js` L44388–44421、L44444–44454、L44467–44477、L44528–44543；[S04](https://jiuchenm.github.io/workbuddy-study/#S04)、[S05 定位](https://jiuchenm.github.io/workbuddy-study/#S05)。）

这证明一个有条件的静态路径，不证明当前应用切换时一定留下 expertId；上游可能已经清理它，显式 systemPrompt 或 CLI composition 也可能绕过相关渲染结果。若要复现，就应记录切换前后传入的字段、选中的 handler、template kind、解析到的文件与下游 CLI 参数。只有这些对应起来，才能判断是输入状态残留、模板回退，还是下游采用了另一套组合方式。

<details>
<summary>面试怎么回答</summary>

**一分钟回答：** WorkBuddy 的模式装配把行为提示、工具集合和权限分开处理。在核验的 legacy 路径中，ModeService 选 handler，handler 生成默认配置，再按字段规则合并输入。Plan 的 promptMode 映射为 Craft，但保留 Plan 工具模式并强制 plan 权限。renderer 选择模板，顺序调用 collectors，填入环境、身份、记忆等变量；user context 另行渲染。最终是否传给 CLI，还受 addon composition 分支影响。因此默认表、模板文件存在和当前模型真实输入，需要分别取证。

**追问一：Plan 中出现 Write，是否说明权限控制失效？** 不能这样判断。配置工具名称和执行时允许动作是两个环节，应继续核对 permissionMode 及具体执行结果。仅凭工具列表或 Prompt 文案，都无法证明一次写操作获准。

**追问二：为什么切回 Craft 仍可能选专家模板？** 如果 expertId 残留，实际选择函数在 craft 分支仍会检查 isExpert，可能选 expert family。要确认故障，必须验证输入确实残留，且该渲染结果没有被显式 Prompt 或下游组合分支替代。

</details>

练习：沿用本例，但切到 Plan 时保留 `expertId: "demo-expert"`，并显式传入 `tools: "Read,Grep"` 与 `permissionMode: "bypassPermissions"`。未提供 systemPrompt，未启用 CLI composition，所需模板存在。请推导 handler 渲染的 template kind、ModeService 合并后的 tools 和 permissionMode。若之后只启用 work_mode 的 systemPrompts addon，能否继续断言该模板就是实际系统提示词？

<details>
<summary>练习参考思路</summary>

template kind 为 expert-code：Plan 被映射到 craft，但 expertId 仍为真。合并后的 tools 为 Read,Grep，因为非 undefined 的显式工具覆盖默认集合；permissionMode 为 plan，因为 handler 的强制结果在合并末尾重新覆盖输入。若启用 CLI composition 且 systemPrompts 中有 work_mode 来源，legacy system prompt 参数会被抑制，不能继续认定该模板进入模型请求。仅此条件并未抑制 legacy tools，还需分别检查 tools addon。以上是按已读代码手动推导，未运行 WorkBuddy 会话。

</details>
