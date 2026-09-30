# Codex /compact 与 Responses compaction：同一任务怎样续接

假设你让一个 coding Agent 修复 `export.py` 的分页遗漏。它读过 API 文档，改过本地文件，跑了 19 个测试，还在测试环境提交了一次导出。聊天越来越长，下一轮又要读入一大段日志。此时输入 Codex CLI 的 `/compact`，或在自己写的 Responses 应用中调用 compaction，任务会怎样接上？如果压缩后只剩一句“导出已提交”，Agent 还能安全地继续吗？

先读 [上下文压缩](#/lesson/compact)：**compaction 改写后续模型请求所用的历史表示**，目的是给同一任务腾出上下文窗口。它可能生成可读摘要，也可能返回不透明条目；原代码、测试环境里的导出任务和模型权重不会因此改变。本篇聚焦 Codex CLI 与 OpenAI Responses API 的实际入口和续接契约。产品文档核验日期为 **2026-09-30**；下文 Codex 实现细节固定在公开源码提交 `1b1835f751ebdc0cfc50b3fe55d4571dbb294563`，不代表所有后续版本、provider 或当前客户端配置。

## 先把要续接的任务说完整

以下记录是教学假设，路径、任务 ID、预算和结果均未实际运行。用户允许改本地脚本、运行测试及提交一次测试环境导出，要求保持 CSV 字段顺序，不改生产配置，也不要重复提交导出。压缩前，关键信息散在多轮消息和工具输出里：

```text
目标：修复 export.py 的分页遗漏，保持 CSV 字段顺序。
依据：假设的 API 文档 v2 规定 page_size 最大 1000；仍须跟随 next_cursor。
文件：C:/demo/export/src/export.py，当前工作副本 demo-v3。
尝试：仅增大 page_size 的方案已放弃，超过一页仍会漏数据。
测试：demo-v3 上 19 个用例中 18 个通过；重复游标用例失败。
外部动作：操作 op-84 返回导出任务 J7；最后观察状态为 processing。
待办：修复重复游标终止条件，重跑测试，然后查询 J7 的最终状态与条数。
未知：J7 的最终文件和条数尚未确认；不得再次提交同一导出。
```

继续任务需要分清三处状态。聊天历史是后续模型请求的材料；`export.py` 是工作目录里的文件；J7 是外部系统里的任务。compaction 主要改写第一处。它若省掉 J7 与 `processing`，下一轮模型可能误把“未看到提交记录”当成“尚未提交”。即使摘要写得完整，继续前也应读当前文件、测试结果和外部状态，因为这些事实可能在压缩后变化。

## 在 Codex CLI 输入 /compact：谁选择下一轮历史

[Codex CLI 命令文档](https://developers.openai.com/codex/cli/slash-commands)把 `/compact` 定义为缩短可见聊天、释放上下文空间；文档的操作流程还写到，在 Codex 提示时确认摘要。手动入口由人发起。自动压缩则由运行时根据预算策略发起；[Codex 配置示例](https://developers.openai.com/codex/config-sample)列出 `model_auto_compact_token_limit`，未设置时使用模型默认值。示例里的数值不是统一阈值，也不能由它推断这台机器当前的设置。

CLI 接收命令后，具体路径仍取决于功能开关与 provider 能力。固定 SHA 的 [`tasks/compact.rs`](https://github.com/openai/codex/blob/1b1835f751ebdc0cfc50b3fe55d4571dbb294563/codex-rs/core/src/tasks/compact.rs#L28-L66)显示：手动任务先检查 `TokenBudget` 分支；否则，支持 remote compaction V2 的 provider 走 remote 路径，不支持时才构造摘要 prompt，调用本地管理的摘要路径。这里“本地管理”指 Codex harness 组织请求和历史，**不等于在用户电脑上运行模型推理**。同一提交的 [`compact_remote_v2.rs`](https://github.com/openai/codex/blob/1b1835f751ebdc0cfc50b3fe55d4571dbb294563/codex-rs/core/src/compact_remote_v2.rs#L81-L115)也有 `Auto` 触发入口，因此不能用“手动=文字摘要、自动=remote”概括产品。

只看这个提交中的文本摘要路径，Codex 为压缩构造一次模型请求。若该请求超出上下文窗口，代码会移除最旧历史项后重试；取得摘要后，构造新的活动历史，调用 `replace_compacted_history`，再重算 token 使用量。[固定源码：请求、超窗重试和历史替换](https://github.com/openai/codex/blob/1b1835f751ebdc0cfc50b3fe55d4571dbb294563/codex-rs/core/src/compact.rs#L268-L401) 另一段 [`build_compacted_history_with_limit`](https://github.com/openai/codex/blob/1b1835f751ebdc0cfc50b3fe55d4571dbb294563/codex-rs/core/src/compact.rs#L662-L739)从较新的用户消息反向选择保留项，按预算截短超限文本，并在相应元数据里标记不完整，最后附上摘要。这描述的是这个函数在该提交中的行为，不能承诺每次都无损保留所有用户消息。

套进假设任务，供人检查的一份摘要至少应保留目标与禁改范围、`demo-v3` 的测试结果、J7 的操作 ID 与最后观察状态，以及下一步先修测试再查 J7 的顺序。它可能写成下面这样；**这段是教学设计，不是 Codex 实际输出，也不能替代 remote 路径的真实格式**：

```text
当前任务：修复 export.py 分页遗漏；保持 CSV 字段顺序，不改生产配置。
文件：C:/demo/export/src/export.py，工作副本 demo-v3。
证据：page_size 上限 1000，仍需跟随 next_cursor；仅增大 page_size 已证伪。
验证：demo-v3 的测试 18/19 通过，重复游标用例失败。
外部状态：op-84 对应 J7，最后观察为 processing；尚未确认最终条数。
下一步：修复重复游标逻辑并重测，查询 J7；不要重复提交导出。
```

压缩后的下一轮若收到“继续”，合理动作是先核对当前文件和失败用例，再查询 J7。摘要只给出上次观察，不能证明测试仍是 18/19，也不能把 `processing` 改说成完成。若超窗重试删去了旧项，摘要漏掉的依据更需回原文件或外部服务核验。不要把压缩视为回滚外部副作用或重置工作目录。

## 在 Responses API 中压缩：返回项怎样传给下一轮

Responses 是供应用组织模型请求的接口层。[OpenAI Compaction 指南](https://developers.openai.com/api/docs/guides/compaction)给出两种入口，处理同一假设任务时应用必须选定相应的续接方式：

| 入口 | 何时发生 | 下一轮怎样带上上下文 |
| --- | --- | --- |
| `context_management` + `compact_threshold` | 普通 `/responses` 请求的渲染 token 数跨过阈值，服务端在同一响应流程里压缩；流中出现加密 compaction item | 无状态 input 数组链把输出项照常加入下一轮输入；用 `previous_response_id` 链则每轮只传新用户消息，不手工裁剪旧项 |
| 独立 `/responses/compact` | 应用主动把当前窗口送去压缩；该输入仍须放得进模型窗口 | 把返回的**整个** compacted window 原样作为下一次 `/responses` 的输入，再加新用户消息 |

服务端返回的 compaction item 是加密且不透明的续接项，**不是承诺可读的文字摘要，也不是读取隐藏推理的接口**。独立端点的返回窗口还可能包含保留下来的其他条目，官方称它为下一轮的 canonical window，明确要求不要自行裁剪。对于服务端自动压缩，官方允许无状态数组链在追加输出后丢弃最近 compaction item 之前的条目，以减少后续请求体积；若使用 `previous_response_id`，则不要手动裁剪。这项裁剪建议不能套用到独立端点的完整返回窗口。[Compaction 指南：两种入口与输出处理](https://developers.openai.com/api/docs/guides/compaction)

这里可以用不执行的伪代码看清交接边界；它只表达独立端点的输入与输出关系，不是可直接运行的 SDK 示例：

```text
旧窗口 = 用户消息 + 助手输出 + 工具交互
压缩窗口 = responses.compact(旧窗口)  # 前提：旧窗口仍在模型容量内
下一轮输入 = 压缩窗口的全部 output 项 + 新用户消息“继续修复并查询 J7”
responses.create(下一轮输入)
```

假如应用只复制看得懂的文字，丢掉 opaque item 或窗口中的保留项，后续请求就不再遵守独立端点的契约。即便按契约传递成功，J7 的状态仍应向业务系统查询。compaction 处理的是模型上下文，而业务操作是否成功需要外部证据。

## 与 Claude Code 的公开入口有何不同

[Claude Code 命令文档](https://code.claude.com/docs/en/commands)列出 `/compact [instructions]`：它通过摘要释放上下文，允许附加关注方向。这个公开入口说明用户能指定摘要重点，例如“保留 J7 的操作 ID 与禁止重复提交”；它没有证明 Claude Code 与 Codex 固定 SHA 使用相同的分支选择、保留预算或 Responses 的 opaque item。不同 harness 的命令名称相似，不能反推内部实现相同。

三条路径共同面对一项取舍：旧记录更短，续跑所需的细节可能被遗漏。压缩请求本身也要占用窗口；独立 `/responses/compact` 要求输入仍在容量内，Codex 这个源码分支遇到超窗则可能先删最旧项重试。该例若把 J7 的 ID、文件版本或“不得重复提交”弄丢，腾出的 token 也不足以保证任务正确。压缩后应核对目标、权限、文件版本、已执行动作、失败项与未知状态；重要事实回到原始记录确认。[Responses Compaction](https://developers.openai.com/api/docs/guides/compaction)、[Codex 固定源码](https://github.com/openai/codex/blob/1b1835f751ebdc0cfc50b3fe55d4571dbb294563/codex-rs/core/src/compact.rs#L268-L401)

<details>
<summary>面试怎么回答</summary>

**一分钟回答：Codex /compact 和 Responses compaction 如何让任务继续？**

compaction 将长历史换成后续请求可用的较短表示。Codex CLI 的 `/compact` 是手动入口，自动入口由预算策略触发；在固定源码版本中，具体会走 `TokenBudget`、remote V2 或文本摘要分支，不能断言每次都生成可读摘要。Responses 可以在 `context_management` 达阈值时由服务端压缩，也可以由应用调用 `/responses/compact`；独立端点返回的整个窗口应原样传给下一轮。无论哪种方式，代码文件和外部任务都没有被压缩或撤销，恢复时仍要核对文件版本、测试、操作 ID 和最后状态。

**追问一：为什么不能只保留“任务已提交”？**

“已提交”缺少操作 ID 与完成状态。假设 J7 最后只观察到 `processing`，下一轮若重提可能造成重复副作用；若直接宣称完成又会跳过核验。摘要要记录已做、待办和未知，并以业务系统的当前状态为准。

**追问二：收到 encrypted compaction item，能只取可读消息继续吗？**

不能把它当成可解码摘要。独立 `/responses/compact` 的整个输出窗口是下一次请求的输入，保留项也要带上；服务端自动模式的数组链另有“最近 item 之前可裁剪”的建议。两种输出规则需要分别遵守。

**追问三：为什么应在窗口满之前安排压缩？**

独立端点的输入仍须适合模型窗口；Codex 这个源码分支超窗时会删除最旧历史项重试。过晚压缩可能丢掉原本可用的记录，且摘要生成也有时间与成本。应在阶段结论稳定、下一批大材料进入之前留出空间。

</details>

## 练习：下一轮究竟该传什么

沿用假设任务。应用已调用独立 `/responses/compact`，输出包含一个 opaque compaction item 和两项保留消息。开发者打算只传 opaque item，再加“继续；导出应该好了”。请指出输入组织与任务状态判断中的错误；若换为 `context_management` 自动模式且应用使用 `previous_response_id`，下一轮该怎样续接？

<details>
<summary>参考思路</summary>

独立端点的三项输出共同构成 canonical window，应全部作为下一次 `/responses` 的输入，再加入新的用户消息。只挑 opaque item 会丢掉保留项。“应该好了”没有状态依据；应查询 J7，保留 `processing` 只是上次观察，不能重提导出或宣称完成。若使用服务端自动模式与 `previous_response_id` 链，官方要求带上该 ID、每轮只传新用户消息，不手动裁剪历史。两种规则来自不同入口，不能混用。本题没有实际发起压缩或导出。

</details>
