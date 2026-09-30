# LangChain：组织 LLM 应用的模型、消息、工具与 Agent

假设你要做一个订单助手。用户问“订单 O42 到哪里了，预计何时送达？”，大语言模型（LLM）能理解问题并组织文字，却不知道订单系统里的最新记录。应用必须调用订单和物流接口，再把结果交给模型。第一版直接调用模型 SDK 就能完成；当应用还要接入多个模型提供方、统一工具调用记录、限制查询次数时，连接代码会逐渐分散。

**LangChain 是组织这些连接代码的开源 LLM 应用框架。** 它提供模型、消息、工具等接口，并用 Agent 运行机制把多次模型调用与工具执行串起来。它位于应用代码和模型服务、外部工具之间：模型服务负责生成内容；订单服务负责真实数据与权限；应用负责业务规则和最终验收。LangChain 不提供订单数据，也不会替业务服务判断谁能看 O42。[LangChain 官方概览](https://docs.langchain.com/oss/python/langchain/overview)

本文沿一条**教学假设**中的 O42 请求，先看完整往返，再拆开这些接口。下面的订单、身份、时间和结果均为假设；没有连接真实订单服务，也没有运行模型 SDK。文中涉及的 Python 文档于 2026-09-30 核验，实际开发仍需按锁定的包版本查 API。读过 [Function Calling](#/lesson/function-calling) 有助于理解模型怎样提出工具请求；[RAG](#/lesson/rag-basics) 是框架的另一种应用场景，并非理解本篇的必要条件。

## 一次 O42 查询先经过什么

假设用户已登录，应用从已验证会话得到用户 ID `U7`。用户输入“订单 O42 到哪里了，预计何时送达？”。应用只开放两个只读能力：`read_order(order_id)` 查当前用户可见的订单，`read_shipment(order_id)` 查该订单关联的包裹。订单号可由模型从问题中提取；用户身份不能由模型自行填写。一次可能的运行顺序如下：

1. 应用把用户问题交给模型。模型返回对 `read_order` 的工具请求，参数为 `O42`。这只是**请求执行**，不是订单事实。
2. 运行代码把请求交给应用实现的函数。函数用可信会话中的 `U7` 验证订单可见性，假设返回“已发货、包裹 S9、9 月 27 日 18:00 从仓库发出”。运行代码将结果与这次工具调用关联，再交给模型。
3. 模型发现“已发货”还不足以回答包裹位置，于是请求 `read_shipment`。该函数再次通过可见订单找到 S9，假设物流返回“9 月 28 日 09:20 到达分拨中心；预计送达时间为空”。
4. 模型据此回答：“订单 O42 已发货；截至 9 月 28 日 09:20，包裹到达分拨中心。物流系统尚未提供预计送达时间。”如果它把空值补成“明天”，应用需要在输出验收中发现这个无依据的结论。

这里有三种信息来源：用户问题提出需求，模型决定要查什么，业务工具返回可核查的订单事实。LangChain 能组织模型请求、工具执行、结果回传的往返；**工具返回正确与否、访问权限和最终回答是否符合业务契约，仍由应用负责**。官方把围绕模型循环的提示、工具和中间件称为 *harness*，可以先把它理解成“使模型完成这类往返的运行代码”。[LangChain Agents](https://docs.langchain.com/oss/python/langchain/agents)

## 模型、消息和工具各提供什么接口

刚才的四步里，模型、消息、工具各解决一种连接问题。

**模型接口**让应用以较一致的调用方式接入不同提供方的 chat model。提供方适配包负责把通用调用转成相应 API 请求；同一接口也可用于单次模型调用或 Agent。接口统一有利于试换模型，却不保证输出等价：工具调用、结构化输出、流式事件、图片输入、特有参数及任务表现仍需逐项验证。[LangChain Models](https://docs.langchain.com/oss/python/langchain/models)

**消息接口**保存一次调用中谁说了什么，以及内容和必要元数据。用户问题是用户消息；模型消息可能是文字，也可能带有工具调用；工具消息承载某次调用的结果。O42 例子里，第二次模型调用要看到第一次查询的结果及其对应关系，不能把所有返回值拼成一段无来源的字符串。不同提供方对字段的使用仍有差异，统一表示不意味着底层语义完全相同。[LangChain Messages](https://docs.langchain.com/oss/python/langchain/messages)

**工具接口**向模型描述可调用函数的名称、用途和输入结构，并把请求接到应用函数。工具是可调用的能力，不等于模型获得了任意数据库访问权。`read_shipment` 接收订单号，再由应用从可见订单查关联包裹，比让模型提供任意包裹号直接查询更容易守住权限边界。应用还需验证参数、处理超时和明确“尚未发货”之类的业务结果。[LangChain Tools](https://docs.langchain.com/oss/python/langchain/tools)

下面是责任划分的 **Python 风格教学伪代码**。`register_tool`、`build_agent` 和 `run` 是本例的自定义记号，不是可直接复制的 LangChain API；真实入口及 context 注入方式须依实际版本实现。

```python
# 教学伪代码：省略 SDK 类型与网络连接，不可直接运行。
def read_order(order_id, trusted_context):
    order = order_service.read_visible_order(
        user_id=trusted_context.user_id,
        order_id=order_id,
    )
    return select_order_fields(order)

def read_shipment(order_id, trusted_context):
    order = order_service.read_visible_order(
        user_id=trusted_context.user_id,
        order_id=order_id,
    )
    if order.shipment_id is None:
        return {"status": "no_shipment", "order_status": order.status}
    return shipping_service.read(order.shipment_id)

agent = build_agent(
    model=provider_adapter,
    tools=[register_tool(read_order), register_tool(read_shipment)],
    instructions="只依据查询结果回答；缺少预计送达时间就明确说未知。",
    middleware=[trace_calls, enforce_tool_budget],
)
result = agent.run(user_message, context=verified_session)
```

`trusted_context` 表示应用传入的已验证身份，不属于模型自由生成的工具参数。官方 Tools 文档区分运行中的可变 *state* 与调用时传入的 *context*；这里的伪代码只表达这个边界。[LangChain Tools：Access context](https://docs.langchain.com/oss/python/langchain/tools#access-context)

## Agent 循环与固定流程怎样选

O42 的第二次查询是谁决定的？若由模型看到订单结果后选择物流工具，这就是 Agent 的关键特征：**模型提出下一步工具调用，运行代码执行并回传结果，模型再决定继续或回答**。LangChain 当前 Python 文档以 `create_agent` 作为可配置入口；官方将 Agent 描述为模型调用工具的循环。循环可以让“只问订单是否取消”和“还问物流进度”走不同路径，但也可能选错工具、重复查询或过早作答。[LangChain Agents](https://docs.langchain.com/oss/python/langchain/agents)

同一产品也能采用固定流程：程序先查订单；仅当订单已发货且有包裹号时查物流；最后让模型根据结果写答复。这里的“固定链”只是预先确定步骤与分支，不指某个旧版 `Chain` 类。它仍可使用 LangChain 的模型和消息接口，甚至完全使用原生 SDK。若产品只支持这几类订单问题，程序分支通常更容易逐项验证；若后续任务范围扩大，下一步依赖用户意图及中途发现的信息，Agent 的动态选择才可能节省大量路由代码。

| 要比较的事 | 固定流程 | Agent 循环 |
| --- | --- | --- |
| 谁决定下一步 | 程序规则 | 模型提出，运行代码执行 |
| O42 的物流查询 | 满足“已发货且有包裹”就查 | 模型读到订单结果后决定是否查 |
| 主要风险 | 分支随需求增加而膨胀 | 错选、重复调用、提前回答 |

无论哪种方式，“模型停止调用工具”只说明循环停了，**不等于回答已满足业务要求**。例如预计送达时间为空时，最终答复必须保留未知；权限拒绝时，不能把拒绝当成“订单不存在”。

## 中间件、状态和日志放在何处

中间件（middleware）在模型或工具执行的边界插入共同控制。例如 O42 请求最多执行两次工具查询：每次执行前检查本次任务剩余次数，执行后记录调用、耗时与结果类型；达到上限后明确停止或交接。日志、提示调整、工具选择和输出处理都是官方文档列出的中间件用途。[LangChain Middleware](https://docs.langchain.com/oss/python/langchain/middleware/overview)

“已经调用几次工具”属于本次任务会变化的 **state**；`U7` 来自已验证会话，是调用时提供的 **context**。计数不能放在跨用户共享的全局变量里，身份也不能让模型在对话中改写。即使中间件能读写状态，跨进程保存与中断后恢复仍需单独设计持久化；它不会自动把状态写入业务数据库。[LangChain Tools：Access context](https://docs.langchain.com/oss/python/langchain/tools#access-context) 更复杂的状态图、checkpoint 和恢复可接着读 [LangGraph](#/lesson/langgraph)；官方把 LangGraph 定位为较底层的编排框架，LangChain Agent 构建于其运行机制之上。[LangChain overview](https://docs.langchain.com/oss/python/langchain/overview)

日志至少应能回答：模型请求了哪个工具、参数是什么、哪次调用对应哪个结果、耗时多久、空值或错误来自哪一层、为何停止。LangSmith 是官方提供的跟踪和评估集成选项，并非使用 LangChain 的前提；应用也要决定敏感订单与用户数据的记录范围。记录的目的是区分权限拒绝、业务服务超时、模型误读和预算耗尽，而不能凭最终一段回答猜原因。[LangChain overview：Tracing](https://docs.langchain.com/oss/python/langchain/overview)

## 什么时候直接用 SDK 更简单

如果只接一家模型服务，执行一次生成，或只有“查订单—有包裹才查物流—回答”这样短而稳定的流程，直接调用原生 SDK 往往足够。它使提供方特有字段、错误和流式事件直接可见，也少一层版本依赖；应用则自己维护消息、工具结果关联和日志。多种模型接入、共享工具定义、反复出现的运行控制逐渐成为维护成本时，LangChain 的接口与 Agent 机制可能更划算，但仍要处理抽象差异和版本升级。

实际选型可以用同一组 O42 用例比较两种实现：正常发货、未发货且无包裹、无权查看、物流超时、预计时间缺失。逐项检查答案、调用轨迹和代码的修改范围，再决定框架是否减少了真正的重复工作。当前文档的 `create_agent`、中间件与提供方适配方式有版本边界；不要把旧版 chain 类或旧 Agent 初始化代码与当前 API 混用。[LangChain overview](https://docs.langchain.com/oss/python/langchain/overview)

<details>
<summary>面试怎么回答</summary>

**一分钟回答：** LangChain 是组织 LLM 应用的框架，提供较统一的模型、消息和工具接口，并用 Agent 循环协调模型调用与工具执行。以订单查询为例，模型提出查订单，应用工具验证权限并返回事实；模型再决定是否查物流，最后基于结果回答。中间件可在调用边界做日志和预算控制。业务数据、授权、错误含义与答案验收仍归应用。流程短且固定时可以直接用原生 SDK；当多模型、多工具与共同运行控制产生重复代码时，再评估框架收益。

**追问一：统一模型接口意味着换提供方不用复测吗？** 不意味着。接口能减少部分适配代码，但工具调用、内容格式、流式事件和模型行为可能不同。至少复测工具选择、参数、空值和失败路径。

**追问二：加了中间件，权限和工具可靠性就交给框架了吗？** 中间件提供检查位置，规则仍须应用定义。身份来自已验证 context，订单服务每次查询仍要校验可见性；超时、业务拒绝和可重试错误也必须区分。

</details>

练习：订单 O42 返回“尚未发货、包裹号为空”，模型却请求物流查询，工具拒绝后又请求一次。指出至少三个应用应处理的地方，并判断一个仅支持订单状态查询的小产品是否一定需要 Agent。

<details>
<summary>参考思路</summary>

物流工具应先确认可见订单确有包裹，再查询关联物流；没有包裹时返回明确的业务结果，不能访问空包裹号。运行代码不要把“尚未发货”当成临时网络错误自动重试；调用预算应阻止无进展循环；最终回答只能说明当前未发货。若所有问题都可由固定的“查订单—有包裹才查物流—回答”覆盖，就可以用固定流程，直接 SDK 或只使用框架的模型接口均可。是否需要 Agent 取决于任务是否真的要动态选择下一步。

</details>
