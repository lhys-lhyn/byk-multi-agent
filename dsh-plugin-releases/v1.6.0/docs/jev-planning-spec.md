# Jev（TypeSafe SystemOne）接入规约 — 供 byk_judge 设计使用

版本：v1（2026-07-06）｜状态：可照做实施
取证方式：TypeSafe 官方文档（docs.typesafe.ai，本地引擎直读页面原文）+ 本机对 `https://api.typesafe.ai/v1/systemone` 的真实调用（3 次，原始片段见文末）+ 本机参考实现 `dsh-plugin-jev@0.1.0`。
凡标「未核实」的条目一律未经证实，禁止据此写代码。**本文不含任何 API key**，key 按第 1 节的解析规则从本机文件读取。

---

## 1. 端点、鉴权、超时

| 项 | 值 | 来源 |
|---|---|---|
| 端点 | `POST https://api.typesafe.ai/v1/systemone` | [官方 API 参考](https://docs.typesafe.ai/api.md)；参考实现 `index.mjs` 常量 `API_URL` |
| 鉴权 | `Authorization: Bearer <API_KEY>`，`Content-Type: application/json` | 同上；两者一致 |
| 请求体 | `{ state, model, questions }`（三字段均必填） | [官方 API 参考](https://docs.typesafe.ai/api.md)：三个 `<ParamField>` 均标 required |
| model 取值 | `"jev-latest"`（官方推荐别名）；实际服务端版本在响应 `model` 字段回报，本机实测为 `"jev-1.13.0"` | 官方文档；实测调用 1 原始片段 |

**key 解析规则（照抄参考实现 `index.mjs` 的 `readApiKey`，可直接搬）**：优先级 `config.apiKey` → 环境变量 `TYPESAFE_API_KEY` → 环境变量 `JEV_API_KEY` → 文件 `<plugin>/../../jev.key`（即 `$DSH_HOME/jev.key`）→ 文件 `<plugin>/key.txt`（本机权威位置：`C:\coding\DSH Home\profiles\desktop\node_modules\dsh-plugin-jev\key.txt`，readFileSync 后 `.trim()`）。全部拿不到就抛错，不静默降级。来源：参考实现 `index.mjs`（真实读取）。

**超时建议**：参考实现默认 `config.timeoutMs || 60000`（60 s），用 `AbortController` + `AbortSignal.any([exec.signal, controller.signal])` 同时响应宿主取消；请求后 `clearTimeout`。byk_judge 建议同款：**默认 60 s，可配置**。官方文档未给出服务端超时或单请求延迟上界——**未核实：官方超时数字——原因：api.md 与 primitives 页均未记载**；实测 3 题一次调用耗时约 1–3 s 量级（本机观察，非官方 SLA）。

---

## 2. 请求体字段

### 2.1 `state`（必填）
- 类型：`string | object | array`。要评估的内容：纯文本、结构化数据（对象/数组，如聊天记录、应用状态）。
- 来源：[官方 API 参考](https://docs.typesafe.ai/api.md)。结构化 state 的嵌套字段用反引号路径引用（如 \`ticket.messages[0].text\`）——来源：[State 文档](https://docs.typesafe.ai/concepts/state.md) 经 skills 说明转述（索引页 llms.txt 确认页面存在；正文未逐字核对，属**二手，低置信**）。

### 2.2 `model`（必填）
- 类型 `string`；用 `"jev-latest"`。可选模型/别名清单见 [Models](https://docs.typesafe.ai/models.md)——**未核实：models.md 具体内容——原因：本轮未打开该页**。

### 2.3 `questions`（必填）
- 类型：`map<string, Question>`。**键（question id）由调用方自定，不送入模型、不参与推理**，响应用同一个键返回。（来源：官方 API 参考：“The key is not sent to the underlying model and is not used in inference.”）
- 每个 Question 共有字段：
  - `type`（必填）：`"noul" | "choice" | "score"`。
  - `instructions`（必填）：要判断的问题。类型 `string | object | array`；对象可把「问题」放一个字段、「引用数据」放其他字段，数据字段在问题里用反引号名字引用（例：`"Is the resume for the same person as \`potential_duplicate\`?"`）。（来源：官方 API 参考，含示例）
  - `criteria`：三种 type 形状不同，见第 3 节；**noul 的 criteria 可选，choice/score 必填**（来源：官方 API 参考 ParamField：noul `criteria` 标 `type="object"` 无 required，choice/score 的 `criteria` 标 required）。
- 一次调用放多个键 = 多条独立判断并行求值（见第 4 节）。

---

## 3. 三类问题：criteria 形状与响应字段

### 3.1 Noul（是/否概率）
**criteria（可选）**：`{ true: string|object|array, false: string|object|array }`——`true` 描述「接近 1 的 yes 意味着什么」，`false` 描述「接近 0 的 no 意味着什么」。（来源：官方 API 参考）

**响应**（实测调用 1 与官方示例一致）：
```json
"acceptance_pass": { "type": "noul", "noul": 0.07 }
```
- `type`：固定 `"noul"`。
- `noul`：**数字 0–1，= 答案为 yes 的概率**。0=否，1=是；≈0.5 表示模型给 yes/no 近似相等概率，**不是「中等强度」**。官方明确：Noul **没有单独的 confidence 字段**，因为只有两个结果，单值即完整描述。（来源：官方 API 参考 + [Noul 文档](https://docs.typesafe.ai/primitives/noul.md)）
- 阈值由代码定：yes/no 同等代价用 0.5；误报代价高（派单、退款）就调高；漏报代价高（安全问题）就调低；中间值送人工。（来源：Noul 文档）
- 写法注意：一条 Noul 只问一个命题；措辞让「高分=yes」，避免反问（如「是否不含个人信息」）。（来源：Noul 文档）
- **重要语义**：noul 值是「yes 的概率」，不是被问事物的「程度」。度量程度请用 score。（来源：Noul 文档，含 4 候选人对照表）

### 3.2 Choice（多选一）
**criteria（必填）**：`map<string, string|object|array|null>`——选项 → 说明/评分标准；选项不需要细节时可置 `null`。**单个 Choice 最多 255 个选项**。（来源：官方 API 参考）

**响应**（实测调用 1 `route` 与官方示例结构一致）：
```json
"route": { "type": "choice", "choice": "frontend", "confidence": 1.0,
  "probabilities": { "docs": 0.0, "backend": 0.0, "frontend": 1.0, "other": 0.0 } }
```
- `choice`：**概率最高的那个选项**（字符串，取自你定义的 criteria 键）。
- `probabilities`：每个选项 → 概率，浮点数**求和为 1**。
- `confidence`：**0–1**，由 probabilities 的集中度算出——压在一个选项上≈1.0，摊平≈低。（来源：官方 API 参考 + [Choice 文档](https://docs.typesafe.ai/primitives/choice.md)）
- 建议：列表可能漏配时加 `other` / `none of the above` 选项让模型有出口。（来源：Choice 文档）

### 3.3 Score（有序分级）
**criteria（必填）**：`array<string|object|array>`，**从低到高的有序等级描述**；**至少 2 级，API 最多收 10 级**。等级编号=数组下标（0 起）。（来源：官方 API 参考 + [Score 文档](https://docs.typesafe.ai/primitives/score.md)）

**响应**（实测调用 1 `risk` 与官方示例结构一致）：
```json
"risk": { "type": "score", "score": 1.01, "confidence": 0.99,
  "legend": { "0": "Cosmetic; no impact to functionality",
              "1": "Broken or degraded feature, but workaround exists",
              "2": "Blocking issue; no workaround exists" },
  "probabilities": { "0": 0.0, "1": 0.99, "2": 0.01 } }
```
- `score`：**概率加权的等级位置**，取值 0 → 顶级编号（3 级则 0–2），可落在两级之间。计算式：Σ(等级号 × 该级概率)。官方示例：0×0.0 + 1×0.57 + 2×0.43 = 1.43。
- `probabilities`：**键是等级号的字符串**（`"0"...`），求和为 1。
- `legend`：等级号 → 你写的等级描述（原文回显；结构化描述时回显整个对象）。
- `confidence`：0–1，由 probabilities 分布集中度算出；全压一级=1.0，摊开=低。（来源：官方 API 参考 + Score 文档）
- 警告（官方原话义）：**同一 score 可由不同分布产生**（1.0 可能是全在 1 级，也可能是 0 级和 2 级各半）——必须连同 `probabilities`/`confidence` 一起读。写等级要「描述情境」不要「描述程度词」（“Moderately severe” 无效）；一问一维度。
- 等级描述可给对象（如 `{ what: "...", examples: [...] }`），此时 legend 回显整个对象；结构化例子能提高置信度（官方对照：1.43/0.35 → 1.03/0.96）。（来源：Score 文档「Structured level descriptions」）

### 3.4 三类共同/交叉要点
- 每个 answer 都带 `type` 与问题 type 对应；**confidence 只有 choice/score 有，noul 没有**。（官方 API 参考「Answer types」）
- 顶层响应固定三字段：`model`（实际服务版本，如 `jev-1.13.0`）、`answers`（键=question id）、`usage`（`{ input_tokens, output_tokens }`，整数，**整个请求的 token 用量，不是每题一份**）。（官方 API 参考；实测调用 1：`"usage":{"input_tokens":556,"output_tokens":78}`）
- `confidence` 反映**答案分布的集中度**，不代表答案正确、也不代表流程可以自动执行——阈值要按你自己的数据与错误代价定。（来源：skills 指引 + Score/Choice 文档措辞一致）
- 结构化 `instructions` 与等级可用 string/object/array 三种形态；从 string 起步。（官方 API 参考）

---

## 4. 一次调用多条判断

- `questions` 放多个键 → 一次请求、**并行求值、互相看不到彼此的答案**，响应 `answers` 里同键一一对应，**顺序与语义都按 key 匹配，不依赖数组位置**。（官方 API 参考 + primitives 文档；实测调用 1 一次问 3 题返回 3 个键）
- 投机式提问（speculative）：可先问「分支相关」的问题（如 return_reason 只在 department=returns 时用），代码只消费用得上的答案。（来源：Choice 文档五问示例、[fan-out pattern](https://docs.typesafe.ai/patterns/fan-out.md)）
- 成本/延迟：官方 parallel-questions cookbook 称 13 题一次调用比逐题调用 **12.2× 便宜、10.0× 快、答案不变**（**单一来源，未交叉验证**；来源：[Parallel questions cookbook](https://docs.typesafe.ai/cookbooks/parallel_questions.md) 摘要，正文未逐字读）。实测调用 1（3 题）`input_tokens=556, output_tokens=78`，单题调用约 input 300 出头（官方示例 296–360）——token 随题数近似线性叠加 state+questions。
- **需要根据前一答案构造下一问的 state 时才分两次请求**；独立问题一律合并进一次调用。（skills 指引，与官方 primitives「ask multiple questions together」一致）

---

## 5. 错误形态

| 场景 | 实测/文档行为 | 来源 |
|---|---|---|
| 缺必填字段 / 题目不合法 | **实测：HTTP 400**，`{"detail":"Noul question must have criteria or instructions: q"}`（缺 `instructions` 时；detail 点名问题 id） | 实测调用 2 原始片段 |
| 官方文档对校验失败的记载 | **422 Unprocessable Entity**，“body details the offending field” | [官方 API 参考](https://docs.typesafe.ai/api.md) Errors 表 |
| ⚠️ 分歧 | **同一类校验失败，实测给 400，文档写 422。客户端按 4xx 处理即可，但不要把状态码当判据写死** | 实测调用 2 vs 官方 Errors 表 |
| 鉴权失败（key 无效/缺失） | **实测：401**，`{"detail":{"error_type":"authentication_error","message":"Cannot authenticate with the server. Please check your API key and try again."}}` | 实测调用 3 原始片段 |
| 限流 | 429 Too Many Requests，官方要求指数退避重试 | 官方 Errors 表 |
| 服务过载 | 529 Overloaded，官方要求延迟后重试 | 官方 Errors 表 |
| 超时 | 无官方服务端超时记载（**未核实——原因：文档未写**）；客户端 AbortController 中止表现为本地 `AbortError`（参考实现语义；本轮未实测超时路径） | 参考实现 `index.mjs` |
| 5xx | 官方 Errors 表只列 529；其他 5xx 形态**未核实——原因：文档未列、未触发** | — |
| 401 错误体形状 | `detail` 是**对象**（error_type/message）；400 校验错的 `detail` 是**字符串**——解析错误体时两种都要兼容 | 实测调用 2、3 原始片段 |

错误体通用规则（官方）：标准 HTTP 状态码 + JSON body 描述问题；**没有文档化的统一 error envelope 字段名**（`detail` 为本机实测所见，**未核实是否为所有错误的固定字段**）。

---

## 6. 接线建议：Jev 进多智能体流程（byk_judge）

> 本节是**基于以上已核实契约 + TypeSafe 官方 patterns 文档的推理与设计建议**，不是实测结论；每条标出依据。

### 6.1 值得先用 Jev 判断的决策点
| 决策点 | 建议问题类型 | 依据 |
|---|---|---|
| 验收判定（某改动是否满足验收标准） | noul，criteria 给「达标/不达标」的确切判据 | noul=是/否概率，适合二值判定（官方 Noul 文档） |
| 方案取舍（A/B/C 哪个方案先做） | choice，选项→方案摘要；低置信度不硬选 | choice 返回完整分布，次优选项概率可作「保留意见」（官方 Choice 文档 + [confidence-routing](https://docs.typesafe.ai/patterns/confidence-routing.md)） |
| 风险/严重度定级 | score，等级写「情境描述」，代码归一化后加权 | score 概率加权落在级间，可排序（官方 Score 文档 + [composite-scoring](https://docs.typesafe.ai/patterns/composite-scoring.md) 模式） |
| 相关性排序（候选文档/任务/PR 对目标的相关度） | 每 (查询,候选项) 一个 score 或 noul，批量并发 | [rerank cookbook](https://docs.typesafe.ai/cookbooks/rerank_typesafe.md)（top-1 5%→18%，top-10 38%→62%，**单一来源，未交叉验证**） |
| 路由选择（任务给哪个角色/模块处理） | choice，选项=角色/模块；含 other 兜底 | [intent-routing pattern](https://docs.typesafe.ai/patterns/intent-routing.md)；本机实测调用 1 `route` 即此形态 |

### 6.2 判断结果怎么写进任务说明/结论（推荐约定）
1. **原样带值**：把 `value`（noul 数值 / choice 选项 / score 数值）+ `confidence` + 关键 `probabilities` 三件一起写入，禁止只抄一个数。score 必须注明 `len(criteria)-1` 顶级编号以便归一化。（依据：Score 文档「同一 score 可由不同分布产生」）
2. **标注判断出处**：写成 `[jev] <question_id>: <value> (confidence=<c>)`，并在任务说明里附 `model` 与 `usage`，保证可复算。（依据：byk 归因纪律 + 本规约第 3.4 节）
3. **阈值分流**：noul ≥0.8 视为 yes、≤0.2 视为 no、中间送人工/复核；choice/score confidence <0.5 时不下硬结论、只给倾向。**阈值是建议起点，必须在 byk 自己的数据上校准**（依据：官方 Noul 文档阈值讨论 + [confidence 文档](https://docs.typesafe.ai/confidence.md) 的三分法；具体数字 0.8/0.2/0.5 为推理建议，非官方数值）
4. **决策点成组一次调用**：规划阶段一次问「验收可行吗(noul) + 哪个角色做(choice) + 风险几级(score)」，把整包结果写进任务说明的「判断依据」小节。（依据：第 4 节多问一调用 + 实测调用 1）
5. **失败静默禁止**：4xx/5xx/超时一律显式记录错误与回退策略（如「Jev 不可用，改用 LLM 二次判断」），不得假装判断已做。（依据：byk 归因纪律 + 第 5 节）
6. **noul 不做程度用**：风险高低请用 score；noul 只回答命题真伪。（依据：Noul 文档对照表）

### 6.3 明确的不适用场景
- 精确计算、确定性规则、执行动作——留代码，不问 Jev（skills 指引「keep deterministic rules, calculations, and execution in code」）。
- 需要长链推理或生成解释的判断——Jev 只给类型化答案不给推理链（官方 System One 概念，**二手转述**）。

---

## 附录 A：真实调用原始片段（取证）

### 调用 1 — 多问一调用（1 noul + 1 choice + 1 score），2026-07-06
请求（state 为导出故障工单）：`{ state: "CI-2187: Export to PDF fails with a spinner... Deadline: we file our quarterly report on Friday.", model: "jev-latest", questions: { acceptance_pass: {type:"noul", instructions:"Does the described change satisfy the acceptance criterion 'the export button works in all supported browsers'?", criteria:{true:"Export works in every browser mentioned as supported", false:"Export is broken or degraded in at least one supported browser"}}, route: {type:"choice", instructions:"Which team should handle this ticket first?", criteria:{frontend:"Browser-specific rendering or export bugs", backend:"Server-side export generation failures", docs:"Documentation or how-to questions", other:"Fits none of the above"}}, risk: {type:"score", instructions:"How severe is the reported issue for the customer?", criteria:["Cosmetic; no impact to functionality","Broken or degraded feature, but workaround exists","Blocking issue; no workaround exists"]} } }`
响应（HTTP 200，**原样**）：
```json
{"model":"jev-1.13.0","answers":{"acceptance_pass":{"type":"noul","noul":0.07},"route":{"type":"choice","choice":"frontend","confidence":1.0,"probabilities":{"docs":0.0,"backend":0.0,"frontend":1.0,"other":0.0}},"risk":{"type":"score","score":1.01,"confidence":0.99,"legend":{"0":"Cosmetic; no impact to functionality","1":"Broken or degraded feature, but workaround exists","2":"Blocking issue; no workaround exists"},"probabilities":{"0":0.0,"1":0.99,"2":0.01}}},"usage":{"input_tokens":556,"output_tokens":78}}
```
一句话结论：三个键一次调用并行返回，answers 键与 questions 键一一对应；noul=0.07（否）、choice=frontend（conf 1.0）、score=1.01（conf 0.99）；usage 合计 input 556 / output 78。

### 调用 2 — 校验失败（q 缺 instructions），2026-07-06
请求：`{ state: "hello", model: "jev-latest", questions: { q: { type: "noul" } } }`
响应：`HTTP 400`，`{"detail":"Noul question must have criteria or instructions: q"}`
一句话结论：校验失败实测返回 **400**（非文档写的 422），detail 点名问题 id。

### 调用 3 — 鉴权失败（伪造 key），2026-07-06
请求：同调用 2 的合法 body，`Authorization: Bearer sk_invalid_key_000`
响应：`HTTP 401`，`{"detail":{"error_type":"authentication_error","message":"Cannot authenticate with the server. Please check your API key and try again."}}`
一句话结论：401 的 detail 是**对象**（error_type/message），与 400 的字符串 detail 形状不同，解析要兼容两种。

## 附录 B：未核实清单
1. `state` 结构化嵌套字段的反引号引用语法细则——来源仅 skills 指引转述（State 文档正文未逐字读）。
2. [Models](https://docs.typesafe.ai/models.md) 页的可用模型/别名清单——未打开。
3. 官方服务端超时、单请求延迟上界、速率限制数值——文档未载。
4. 校验失败的官方状态码到底是 400 还是 422——文档 422 vs 实测 400，存在分歧；未验证是否因错误类型不同。
5. 错误体 `detail` 是否为所有错误的固定字段名——仅实测 400/401 两种，未穷举。
6. parallel-questions cookbook 的 12.2×/10.0× 数字——单一来源（cookbook 自述），未交叉验证。
7. 超时路径（AbortError 行为）——参考实现语义，本轮未实测。
8. jev-latest → jev-1.13.0 的别名解析规则（何时升级到新版本）——未核实。
