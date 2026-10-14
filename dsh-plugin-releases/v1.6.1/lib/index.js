/**
 * dsh-plugin-byk-agents —— 把 BYK 的七个专业助手接进 DSH。
 *
 * 提供两个工具：
 *   - `byk_role`   ：把任务交给某个专业助手执行。**进程内子智能体**，按角色指定
 *                    LLM 模型与人格（`agentOptions` + `persona`），并继承调用方的工作区。
 *   - `byk_hire`   ：把一个角色"招"成官方 Agent Team 的具名持久 teammate，
 *                    出现在团队面板与任务板上，用它来做需要长期协作/可见性的活。
 *
 * 分工建议：Team 管协调（谁在干什么、任务板、持久消息），`byk_role` 管干活（模型正确）。
 *
 * 角色定义（人格、模型）来自 `byk/roles.py` 这一份**单一事实来源**：
 * 每次调用都现场跑一次
 *     <python> -m byk.cli roles --json
 * 读取，所以 `python -m byk.cli set-model --role vision --model X` 改完
 * **下一次调用立刻生效**，不需要重建插件、不需要重启 DSH。
 *
 * 为什么用子智能体接口而不是自己起进程：`ctx.subagents.start` 支持
 * `agentOptions.{provider,model}` 与 `persona`（requires 进程内 provider 的
 * agentOptions/persona 能力），也天然继承调用方的工作区与谱系。
 * 官方 Agent Team 的 `spawn_teammate` 只接受 name/description/prompt/context，
 * **不支持按 teammate 指定模型**，所以模型相关的活走这里。
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveRoute, resolveLocalCommand, loadConfigFile, formatRoute } from "./routing.js";
import { transcribeAudio, findAudioPath } from "./asr.js";
import {
  createJevCaller,
  buildQuestion,
  validateQuestion,
  toJudgeJson,
  toBatchJson,
  errorJson,
  QUESTION_TYPES,
  DEFAULT_BASE_URL as DEFAULT_JEV_BASE_URL,
  DEFAULT_MODEL as DEFAULT_JEV_MODEL,
  DEFAULT_TIMEOUT_MS as DEFAULT_JEV_TIMEOUT_MS,
} from "./jev.js";
import {
  moodQuestions,
  validateMoodCriteria,
  toMoodJson,
  summarizeMood,
} from "./mood.js";

import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import {
  ROLE_IDS,
  PLAN_INSTRUCTION,
  parsePlan,
  normalizePlan,
  planBatches,
  formatPlanText,
  formatProgressText,
} from "./plan.js";

const name = "byk-agents";
// 必须声明 subagents：否则 apply 时 ctx.subagents 可能还没挂载。
// systemPrompt 用于注入协作流程（见 BYK_WORKFLOW）。
// agentTeams 不注入 —— 它只在启用 Agent Team 的 profile 里存在，注入会让本插件在不启用的
// profile 里永远 pending。执行时用 getService(ctx, "agentTeams") 取：cordis 的
// ReflectService.get 是官方逃生口（"Read a service from the store without the inject
// requirement"），拿不到就返回 undefined，绝不会像 ctx.agentTeams 那样抛守卫错误。
const inject = ["tools", "subagents", "systemPrompt"];

/**
 * 注入到系统提示的协作流程。
 *
 * 目的：让「用户只是说话 → 任务助手拆解 → 用户确认 → 分派 → 汇总」成为**默认行为**，
 * 而不是依赖主对话每轮自觉。
 *
 * 放在 TEAM_POLICY 档位（SECTION_ORDERS 是固定枚举，不能自定义名字），
 * 该档位与官方 Agent Team 的策略同层，语义相符。
 */
const BYK_WORKFLOW = `【协作流程：默认由多个助手分工，而不是一个对话干完】

先判断当前输入是「任务/需求」还是「闲聊/提问」。

**如果是任务或需求**（要做某件事、要看/改/查/部署某个东西），按四步走：

1. **先规划。** 调用 byk_role，role 用 task，task 里写清楚用户的原始诉求、相关背景、
   以及所有涉及文件的绝对路径。任务助手会拆成子任务并为每条指派角色，返回结构化计划。
2. **交给用户确认。** 把计划摆出来：总目标、每条子任务、各自负责的角色、依赖关系、验收标准，
   然后明确问一句「确认执行吗？」。
   **用户确认之前，不要调用任何其它角色的助手，也不要自己动手做这件事。**
   用户要求改派角色或改说明时，按他的改完再确认一次。
   拿到计划后**先做两件事**：①用 todo_write 把最终步骤登记成进度清单（每条 pending）；
   ②把计划摆给用户确认。用户改派角色、增删步骤或调顺序时，改完再确认一次。
3. **分派执行。** 确认后，对每条子任务调用 byk_role（role 用该子任务被指派的那个）；
   也可以在计划已确认时一次性用 byk_batch 执行整份计划（它按依赖分批、批内并发）。
   子任务说明必须自包含：背景、要做什么、验收标准、涉及的绝对路径。
   **无依赖的子任务在同一条回复里并发发起**（多个工具调用一起发）；有依赖的等前置返回后再发。
4. **边跑边报进度。** 每批返回后立刻用一行说清：进度 x/y 步（百分比）、这一步谁在做、
   用了哪个模型、耗时多少、还剩几步、预计还要多久。同步把 todo_write 里对应项标成 completed、
   正在跑的标成 in_progress。**不要编造百分比或预计时间**——没有依据就用「已完成 x/y 步 + 每步耗时」。
   长任务被用户追问时，也要先报当前进度再解释。
   **动手前把「要动的具体目标」写进任务说明**：绝对路径 / 完整命令 / 目标主机。
   需要提权（sandbox_permissions）时，justification 里必须点名**具体目标**——
   主对话与用户只能看到你写的 justification，写「需要写文件」等于没说，写
   「写 C:\\Users\\me\\Desktop\\x.txt 用于验证导出」用户才敢点允许。
5. **汇总交付。** 全部返回后整理成一份给用户的东西：谁做了什么、各自结论、证据在哪、
   失败或被阻塞的如实说明。不要原样倒助手的输出，要归纳。

**如果不是任务**（闲聊、问一句事实、问你怎么做、让你解释代码），**直接回答**，
不要为了走流程去调用助手 —— 每次调用都会真实拉起一个助手进程并计费。

**用户明确说「你自己做」「别叫助手」时，照办。**

【判断先行：有界语义判断先问 Jev】

1. **什么算「有界语义判断」。** 下面这些判断，不要自己写一段 prompt 让 LLM 打分再解析，
   直接用 byk_judge（一条）或 byk_judge_batch（多条）拿带置信度的类型化判定：
   - **验收判定**：这一步到底达标没有（noul）。
   - **方案取舍**：A 方案还是 B 方案、先做哪个（choice）。
   - **风险定级**：低 / 中 / 高，或更细的分级（score）。
   - **优先级与相关性排序**：哪条更该先做、哪条跟当前诉求相关（choice / score）。
   - **分类与意图识别**：这条该给哪个角色、用户到底想要什么（choice）。
   - **置信度估计**：你对某个结论有多确定（noul / score）。
2. **规矩：先判定，再行动。** 遇到上面这类判断，**先用 byk_judge / byk_judge_batch 拿到判定，
   再据此决定下一步**；不要先做完再补一句「我觉得应该没问题」。判定结果要写进**进度播报与最终汇总**，
   格式带上 value 与 confidence，例如「验收由 byk_judge 判 PASS，置信度 0.86」——
   只写结论不写置信度等于没判。**noul 没有 confidence**（它只有 yes 概率一个数），这时写概率本身。
3. **例外（不必调用）。** 纯事实查证（查一个数、读一段代码）、纯代码跑测试、
   用户明确要求直接给结论时，直接用你自己的判断答，不要为了走流程去调判断工具。
4. **判定失败要诚实。** 返回 {ok:false, error_kind, error} 时（error_kind ∈ config / invalid / auth /
   rate_limit / overloaded / server / http / timeout / aborted / network / parse），
   把 error_kind 与 error 原样说明，**不要假装判断已经做过，也不要把失败当成判定结果**
   （「判定失败」不等于「不达标」）。能修的原因（缺 key、criteria 写错）就修好重试一次，
   不能修就如实报阻塞。

【先读情绪、再排任务】

1. **每个需求轮开头，先拿一次情绪判读。** 用 byk_mood 拿三件事：情绪基调（choice）、
   着急程度（score）、这一轮最需要先满足什么（choice）。它只读**用户这一轮的话本身**，
   不推测没写出来的事。已经有别的判断要一起问时，也可以把这些并进一次 byk_judge_batch。
2. **据此决定先说什么、以什么顺序交付。** 先接住情绪，再排任务顺序 —— 交付的还是同一份结果，
   但先给什么、后给什么、话怎么说，按判读结果调。下面是**示例，不是规则清单**（判读结果永远优先于例子）：
   - 判到「紧迫着急 / 焦虑压力」：先给能立刻用的最小结果或止血办法，解释与取舍放后面；
   - 判到「受挫不满」：先确认问题到底出在哪、是不是我们这边的锅，别急着辩解或先讲计划；
   - 判到「兴奋期待」：顺着他的劲往下展开，别先泼冷水；
   - 判到「中性」：照常干，不必刻意加安抚的话。
   **这些例子只是示例**：不要把它当成按场景写死的规则（例如"遇到某类具体事情就固定怎么答"）——
   情绪判读给出的结果才是依据，具体是哪件事只是那件事本身。
3. **判定结果要写进进度播报与最终交付。** 带上 value 与 confidence（choice / score 才有 confidence，
   另把 probabilities / legend 一起带上），例如「情绪由 byk_mood 判为「紧迫着急」，confidence 0.86；
   最该先满足的是「要立刻结果」」——只写结论不写置信度等于没判（同上一节的规矩）。

**四条边界（必须守住）：**
① **不改任务范围与验收标准。** 情绪判读只改措辞与呈现顺序，不改这次做什么、做到什么算完。
② **不确定就如实标注。** confidence 偏低、probabilities 分散时明说「这是弱信号」，
   别把猜的当知道的；判读失败（ok:false）照实报 error_kind，**不要把失败当成"用户情绪平静"**。
③ **不做无原则附和。** 发现方案有代价照样直说，只是把话说得更好接。
   顺着用户说「没问题」不叫安抚，那叫把问题留到以后。
④ **不是每轮都要调。** 纯事实查证、一行小问题、用户明确要求直接给结论时不触发 ——
   省一次调用，也省用户一次等待。

【关于助手】
- 七个角色的模型是按角色配置好的（看图/看视频/文件走视觉模型，代码与检索走另一档），
  你不需要也无法替它选模型。
- 助手没有跟用户交互的通道：任务说明必须自包含，它不会回来问你。
- 助手的工作目录继承本会话；要它处理某个文件，在任务说明里给绝对路径。
- 长任务可并发；单次调用默认超时 30 分钟。
- byk_plan 出结构化计划（含角色/依赖/验收/预计耗时）；byk_batch 按依赖分批并发执行整份计划。

**汇总交付时必须先给出「助手调用清单」**：一次调用一行，四列——角色 | 模型 | 状态 | 一句话结论。
模型与状态直接抄每个工具结果开头那一行【<角色> · <provider/model> ...】；失败、超时、被拒绝的也要列出来，不许略过。`;

/**
 * 追加给角色子智能体的**工具复用约定**（拼在任务说明之后，走 prompt，不新增工具、不改 inject）。
 *
 * 目的：让子智能体先看"宿主已经给了什么工具"再决定动手，优先复用其它已安装插件提供的工具，
 * 而不是自己重写一遍。**不列任何工具清单** —— 工具 schema 是注册即注入系统提示的，
 * 把清单再抄进 prompt 等于同一份 schema 付两次钱（见 v1.2.0 设计 1.4）。
 */
const SUBAGENT_TOOL_REUSE = `【工具复用约定】
- 你继承调用方会话的全部工具，其中包含**其它已安装插件注册的工具**与宿主内置工具。系统提示里的工具清单就是你的能力清单，动手前先扫一眼。
- 能复用现成的工具就复用，不要自己重写：先看有没有可用的工具或已装插件能力，再决定怎么干。重复造轮子既慢又费 token。
- 能力上限是"调用方会话本来就有的一切"（工具集是交集）：你拿不到调用方没有的能力，别去调用自己没有的工具。
- 安全边界不变：只做任务说明里的事，不越权扩大范围。删除、改凭据、动系统配置、批量改动这类高风险动作在子会话里要人工审批：子会话的待批请求会**冒泡到主对话**，由用户在主对话点「允许一次 / 拒绝」；低风险请求由 dsh-approval-gate 判定后自动放行。
- **提权申请必须写清目标**：需要 sandbox_permissions 提权时，justification 里要点名**具体路径 / 完整命令 / 目标主机**，并说清为什么非提权不可——用户只看到这句话来做决定，只写「需要写工作区外的文件」等于没写。
- **等审批超时不等于被拒绝**：一次 run_code 若因等人工审批超时，把**完全相同的调用**原样重发一次即可，不要换命令、不要绕过。`;


/** 角色 id 由设计固定（见 lib/plan.js）。模型与人格是动态读取的。 */

const ROLE_BLURB = {
  task: "任务助手：把一段诉求拆成可执行的子任务并指派角色",
  code: "代码助手：代码审查、缺陷排查、执行命令、构建、部署（有完整 shell 权限）",
  vision: "视觉助手：图片直读 + 视频直读（画面与音轨）",
  file: "文件助手：Word / PPT / PDF / Excel 内容提取与结构化",
  audio: "语音助手：语音转写的整理与理解",
  research: "科研助手：科研问题分析、文献检索、成果综述，引用可核查",
  search: "搜索助手：检索资料并汇总成带出处的信息",
};

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

const Config = z.object({
  /** BYK 项目根目录（含 byk/ 包） */
  bykRoot: z.string().required(),
  /** 跑 BYK 的 Python 解释器（应为项目 .venv 里的 python） */
  python: z.string().required(),
  /** 单次调用的超时（毫秒） */
  timeoutMs: z.number().default(DEFAULT_TIMEOUT_MS),
  /** 峰谷/角色模型配置文件的路径；留空则按 bykRoot/agents.config.json、插件目录/agents.config.json 依次找 */
  routingConfigPath: z.string().default(""),
  /** 子智能体里是否允许再嵌套调用 byk_role（默认禁止，防递归） */
  allowSubagentDelegation: z.boolean().default(false),
  /** 出计划时用哪个角色（默认任务助手） */
  planRole: z.string().default("task"),
  /** byk_batch 批内并发上限 */
  maxParallel: z.number().default(3),
  /** 子智能体可见哪些工具。
   *  "inherit-all"（默认）= 不设 toolFilter，继承父会话全部工具（含其它已安装插件注册的全局工具）。
   *  { allow?, deny? } = 在父会话工具集之内再做一次收窄（交集语义：只能变少，不能变多）。 */
  subagentTools: z.union([
    z.const("inherit-all"),
    z.object({
      allow: z.array(z.string()),
      deny: z.array(z.string()),
    }),
  ]).default("inherit-all"),
  /** Jev（TypeSafe SystemOne）判定：byk_judge / byk_judge_batch 用。
   *  任何一项留空都回落到 lib/jev.js 的默认值；key 找不到时工具**明确报错并点名找过哪些位置**，不静默降级。 */
  jev: z.object({
    /** 判定端点 */
    baseUrl: z.string().default(DEFAULT_JEV_BASE_URL),
    /** 模型别名；服务端实际版本在响应 model 字段回报（实测 jev-1.13.0） */
    model: z.string().default(DEFAULT_JEV_MODEL),
    /** 单次判定超时（毫秒）；工具自身的 timeoutMs 取它 +5s，好让超时以我们自己的明确错误返回 */
    timeoutMs: z.number().default(DEFAULT_JEV_TIMEOUT_MS),
    /** 直接给 key；留空则按 TYPESAFE_API_KEY → JEV_API_KEY → keyPath → 一组默认文件位置依次找 */
    apiKey: z.string().default(""),
    /** 直接从这个文件读 key（优先于默认文件位置） */
    keyPath: z.string().default(""),
  }).default({}),
});

/** 把 subagentTools 归一成 toolFilter。
 *
 * 返回 null 表示默认路径（inherit-all）：不设 toolFilter，子会话继承父会话全部工具。
 * 语义层校验放在这里、由 apply 在加载期调用：既没 allow 也没 deny 的 {} 是配置错误，
 * 必须加载即报错，不静默降级成"继承全部"。
 */
/**
 * 取宿主服务，且**不触发 cordis 的 inject 守卫**。
 *
 * 为什么不用 `ctx.agentTeams`：cordis 只允许读 inject 里声明过的服务，直接读未声明的属性会抛
 * `cannot get property "xxx" without inject` —— 连 `if (!ctx.agentTeams)` 这种兜底判断都会先炸。
 * 而 agentTeams 又**不能**写进 inject：它只在启用 Agent Team 的 profile 里存在，写进去会让本插件
 * 在没有该服务的 profile 里永远 pending。
 *
 * `ctx.get(name)` 是 cordis 的官方逃生口（ReflectService.get：「Read a service from the store
 * without the inject requirement」），服务不存在时返回 undefined。
 *
 * @param ctx 插件上下文。
 * @param name 服务名。
 * @returns 服务实例；没有该服务时 undefined。
 */
function getService(ctx, name) {
  try {
    if (ctx && typeof ctx.get === "function") return ctx.get(name) ?? undefined;
  } catch {}
  try {
    if (ctx && ctx.reflect && typeof ctx.reflect.get === "function") return ctx.reflect.get(name) ?? undefined;
  } catch {}
  return undefined;
}

function resolveToolFilter(value, where) {
  if (value === undefined || value === "inherit-all") return null;
  const allow = Array.isArray(value.allow) ? value.allow : [];
  const deny = Array.isArray(value.deny) ? value.deny : [];
  if (allow.length === 0 && deny.length === 0) {
    throw new Error(
      `${where}：subagentTools 既没给 allow 也没给 deny。要继承全部工具请写 "inherit-all"，` +
      `要收窄请至少给一项（推荐 deny：漏写一项不会让工具消失）。`,
    );
  }
  const filter = {};
  if (allow.length > 0) filter.allow = allow;
  if (deny.length > 0) filter.deny = deny;
  return filter;
}

function runProcess(cmd, args, opts, signal) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { ...opts, stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      resolve({ code: -1, stdout: "", stderr: `无法启动进程：${err && err.message}` });
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    child.stdout.on("data", (d) => { stdout += d.toString("utf8"); });
    child.stderr.on("data", (d) => { stderr += d.toString("utf8"); });
    const onAbort = () => { try { child.kill(); } catch { /* 已退出 */ } };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      resolve({ code: -1, stdout, stderr: `${stderr}\n${err.message}` });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      if (signal) signal.removeEventListener?.("abort", onAbort);
      resolve({ code: code === null ? -1 : code, stdout, stderr });
    });
  });
}

/** 插件目录（lib/ 的上一级）：找 agents.config.json / cordis.patch.yml 用。 */
const pluginDir = dirname(dirname(fileURLToPath(import.meta.url)));

/** 这次该读哪份配置：config.routingConfigPath > <bykRoot>/agents.config.json > <插件目录>/agents.config.json。 */
function routingConfigFor(cfg) {
  const candidates = [];
  if (cfg && cfg.routingConfigPath) candidates.push(cfg.routingConfigPath);
  if (cfg && cfg.bykRoot) candidates.push(join(cfg.bykRoot, "agents.config.json"));
  candidates.push(join(pluginDir, "agents.config.json"));
  for (const p of candidates) {
    if (p && existsSync(p)) return loadConfigFile(p);
  }
  return {};
}

/** 本地后端：跑用户自己的命令/脚本，全程不调用任何大模型。 */
function runLocal(spec, signal, fallbackTimeoutMs) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(spec.command, spec.args || [], {
        cwd: spec.cwd || undefined,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      resolve({ code: -1, stdout: "", stderr: "无法启动本地命令：" + String(err && err.message) });
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    const limit = Number(spec.timeoutMs || fallbackTimeoutMs || 0);
    const timer = limit > 0 ? setTimeout(() => {
      stderr += "\n（已超时 " + Math.round(limit / 1000) + "s，已终止）";
      try { child.kill(); } catch { /* 已退出 */ }
    }, limit) : null;
    const done = (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ code: code === null ? -1 : code, stdout, stderr });
    };
    child.stdout.on("data", (d) => { stdout += d.toString("utf8"); });
    child.stderr.on("data", (d) => { stderr += d.toString("utf8"); });
    const onAbort = () => { try { child.kill(); } catch { /* 已退出 */ } };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    child.on("error", (err) => { stderr += "\n" + err.message; done(-1); });
    child.on("close", (code) => {
      if (signal) signal.removeEventListener?.("abort", onAbort);
      done(code);
    });
  });
}

function apply(ctx, config) {
  const cfg = config || {};
  const bykRoot = cfg.bykRoot;
  const python = cfg.python;
  const timeoutMs = cfg.timeoutMs || DEFAULT_TIMEOUT_MS;
  const planRole = cfg.planRole || "task";
  const maxParallel = Math.max(1, Number(cfg.maxParallel) || 3);
  const maxPlanSteps = 12;

  if (!bykRoot || !python) {
    ctx.logger?.warn?.(
      "[byk-agents] 未配置 bykRoot / python，工具不会注册。" +
      "示例：{ bykRoot: 'C:/Projects/byk', python: 'C:/Projects/byk/.venv/Scripts/python.exe' }",
    );
    return;
  }

  const env = { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" };

  // 子智能体工具可见性：默认 inherit-all（不设 toolFilter，继承父会话全部工具）。
  // 语义层校验放在加载期：非法值（如 {} 既无 allow 也无 deny）直接抛错，不静默降级。
  const toolFilter = resolveToolFilter(cfg.subagentTools, "[byk-agents] subagentTools 配置错误");

  // 注入协作流程到系统提示。放在 TEAM_POLICY 档（SECTION_ORDERS 是固定枚举）。
  // 这一段让"先规划→等确认→再分派→后汇总"成为默认行为，而不是靠主对话自觉。
  try {
    ctx.systemPrompt.section({
      name: "byk:workflow",
      order: ctx.systemPrompt.getSectionOrder("TEAM_POLICY"),
      text: BYK_WORKFLOW,
    });
  } catch (err) {
    ctx.logger?.warn?.(`[byk-agents] 注入协作流程失败：${err && err.message}`);
  }

  /**
   * 现场读取角色注册表。**每次调用都读** —— 这就是"改了模型立刻生效"的实现方式，
   * 也保证人格只有一份定义（byk/roles.py）。
   */
  async function loadRegistry() {
    const res = await runProcess(python, ["-m", "byk.cli", "roles", "--json"], { cwd: bykRoot, env });
    if (res.code !== 0) throw new Error(`读取角色注册表失败（退出码 ${res.code}）：${res.stderr.trim()}`);
    try {
      return JSON.parse(res.stdout);
    } catch (err) {
      throw new Error(`角色注册表不是合法 JSON：${String(err && err.message)}`);
    }
  }

  /** 挑一个支持 agentOptions + persona 的**进程内** provider。
   *
   * 必须是**惰性**的：`inject: ["subagents"]` 只保证服务已挂载，
   * 不保证 provider 已注册 —— 在 apply 时调用会拿到空列表（实测踩过）。
   */
  let cachedProvider = null;
  let probed = false;
  /** 已配置收窄、但因 provider 不支持 toolFilter 而被跳过的 provider 名（用于明确报错，不静默回退）。 */
  const toolFilterBlocked = [];
  function pickProvider() {
    if (probed) return cachedProvider;
    probed = true;
    let names = [];
    try { names = ctx.subagents?.list?.() ?? []; } catch { names = []; }
    const ordered = ["spawn", "fork", ...names.filter((n) => n !== "spawn" && n !== "fork")];
    for (const n of ordered) {
      if (!names.includes(n)) continue;
      let p;
      try { p = ctx.subagents.getProvider(n); } catch { p = undefined; }
      const caps = p && p.capabilities;
      if (caps && caps.agentOptions && caps.persona) {
        // 只有**显式配置收窄**时才要求 caps.toolFilter；默认路径不新增任何能力要求
        // （否则在不支持 toolFilter 的 provider 上会挑不到 provider 而静默回退）。
        if (toolFilter && caps.toolFilter !== true) { toolFilterBlocked.push(n); continue; }
        cachedProvider = n;
        return n;
      }
    }
    return null;
  }

  // ── 工具 1：byk_role ────────────────────────────────────────────────
  /**
   * 角色执行内核：byk_role / byk_plan / byk_batch 共用。
   * 负责防递归、解析路由（峰谷/固定/本地/ASR）、拉起进程内子智能体、格式化结果。
   */
  async function runRole(roleArg, rawTask, exec) {
  const role = String(roleArg || "");
  if (!ROLE_IDS.includes(role)) {
    return { ok: false, role, model: "", duration_s: 0, text: `未知角色 "${role}"。可用：${ROLE_IDS.join("、")}。` };
  }

  const started = Date.now();
  let registry;
  try {
    registry = await loadRegistry();
  } catch (err) {
    return { ok: false, role, model: "", duration_s: 0, text: `无法读取角色定义：${String(err && err.message)}` };
  }
  const meta = registry[role];
  if (!meta) {
    return { ok: false, role, model: "", duration_s: 0, text: `角色注册表里没有 "${role}"。` };
  }
  // 1) 防递归：byk_role 自己就是在子智能体里跑的，默认不再嵌套。
  const depth = Number((exec && exec.agent && exec.agent.session && exec.agent.session.header
    && exec.agent.session.header.delegationDepth) || 0);
  if (depth > 0 && !cfg.allowSubagentDelegation) {
    return {
      ok: false, role, model: "", duration_s: 0,
      text: `拒绝调用：当前已经是子智能体（delegationDepth=${depth}），不再嵌套。` +
        `确实需要的话，请在插件配置里打开 allowSubagentDelegation。`,
    };
  }

  // 2) 这一次该用哪个模型：峰谷路由 / 角色固定 / 本地后端 / 直连 ASR。
  let route;
  try {
    route = resolveRoute(role, { config: routingConfigFor(cfg), registry });
  } catch (err) {
    return { ok: false, role, model: "", duration_s: 0, text: `模型路由解析失败：${String(err && err.message)}` };
  }
  const modelLabel = formatRoute(route);
  let promptText = String(rawTask || "");

  // 2a) 本地后端：完全不调用大模型，直接跑配置好的命令。
  if (route.backend === "local") {
    let spec;
    try {
      spec = resolveLocalCommand(role, { task: promptText, config: routingConfigFor(cfg) });
    } catch (err) {
      return { ok: false, role, model: modelLabel, duration_s: 0, text: `本地后端配置有问题：${String(err && err.message)}` };
    }
    const t0 = Date.now();
    const r = await runLocal(spec, exec.signal, route.timeoutMs || timeoutMs);
    const durLocal = (Date.now() - t0) / 1000;
    const headLocal = `【${meta.name} · 本地后端】`;
    if (r.code === 0) {
      return { ok: true, role, model: modelLabel, duration_s: durLocal, text: `${headLocal}\n\n${(r.stdout || "").trim() || "（无输出）"}` };
    }
    return {
      ok: false, role, model: modelLabel, duration_s: durLocal,
      text: `${headLocal}\n本地命令失败（退出码 ${r.code}）：${spec.command}\n` +
        `${(r.stderr || r.stdout || "").trim().slice(0, 2000)}`,
    };
  }

  // 2b) 直连 ASR：先把音频转写，再交给 understand 指定的 chat 模型整理。
  if (route.backend === "asr") {
    const asr = route.asr || {};
    const filePath = findAudioPath(promptText);
    if (!filePath) {
      return {
        ok: false, role, model: modelLabel, duration_s: 0,
        text: "语音助手需要音频文件的绝对路径（wav/mp3/m4a/aac/flac/ogg/opus/wma/amr）。" +
          "请在任务说明里给出完整路径。",
      };
    }
    const t = await transcribeAudio({
      filePath, model: asr.model, baseURL: asr.baseURL, apiKeyEnv: asr.apiKeyEnv,
    });
    if (!t.ok) {
      return { ok: false, role, model: modelLabel, duration_s: t.ms / 1000, text: `【${meta.name} · ${modelLabel}】转写失败：${t.error}` };
    }
    const transcript = `【转写原文 · ${t.model} · ${(t.ms / 1000).toFixed(1)}s】\n${t.text}`;
    if (!route.understand) {
      return { ok: true, role, model: modelLabel, duration_s: t.ms / 1000, text: `【${meta.name} · ${modelLabel}】\n\n${transcript}` };
    }
    promptText = "请阅读下面这段语音转写文本，按任务要求整理并给出结论。" +
      `\n\n任务：${promptText}\n\n${transcript}`;
    route = {
      ...route, backend: "llm",
      provider: route.understand.provider, model: route.understand.model,
      reasoningEffort: undefined,
    };
  }
  const providerName = pickProvider();

  // 显式收窄但 provider 不支持 toolFilter：明确报错，绝不静默忽略或回退到非子智能体路径。
  if (toolFilter && !providerName && toolFilterBlocked.length > 0) {
    return {
      ok: false, role, model: modelLabel, duration_s: (Date.now() - started) / 1000,
      text: `【${meta.name}】subagentTools 要求在配置里收窄工具，但当前 provider "${toolFilterBlocked[0]}" ` +
        `不支持 toolFilter；请改用支持它的进程内 provider，或把 subagentTools 设回 "inherit-all"。`,
    };
  }

  // 首选：进程内子智能体，可指定模型与人格，且继承调用方工作区
  if (providerName && ctx.subagents && exec.agent) {
    let run;
    const startReq = {
      parent: exec.agent,
      label: `BYK ${role}`,
      // 任务说明后追加工具复用约定（见 SUBAGENT_TOOL_REUSE）；不抄任何工具清单。
      prompt: [{ type: "text", text: `${promptText}\n\n${SUBAGENT_TOOL_REUSE}` }],
      agentOptions: route.reasoningEffort === undefined
        ? { provider: route.provider, model: route.model }
        : { provider: route.provider, model: route.model, reasoningEffort: route.reasoningEffort },
      // 用**子智能体版人格**：BYK 原始人格是给编排流程写的，会让助手去找不存在的
      // TASK.md 并把结果写进 RESULT.md；这里换成"回复正文即交付物"的版本。
      persona: route.persona || meta.persona_subagent || meta.persona,
      signal: exec.signal,
    };
    // 默认路径（inherit-all）载荷逐字节不变：不设 toolFilter，继承父会话全部工具。
    if (toolFilter) startReq.toolFilter = toolFilter;
    try {
      run = await ctx.subagents.start(providerName, startReq);
    } catch (err) {
      const detail = String((err && err.message) || err);
      return {
        ok: false, role, model: modelLabel, duration_s: (Date.now() - started) / 1000,
        text: `${meta.name}（${modelLabel}）启动失败：${detail}`,
      };
    }
    try {
      const result = await run.result;
      // SubagentResult.output 是 ContentBlock[]，不是字符串 —— 必须把 text 块拼起来。
      const blocks = Array.isArray(result && result.output) ? result.output : [];
      const out = blocks
        .filter((b) => b && b.type === "text" && typeof b.text === "string")
        .map((b) => b.text)
        .join("\n")
        .trim();
      const dur = (Date.now() - started) / 1000;
      const head = `【${meta.name} · ${modelLabel}】`;
      const stop = result && result.stopReason;
      const diag = result && result.diagnostic;
      const warn = stop && stop !== "completed"
        ? `\n\n（注意：本次运行以 ${stop} 结束，产出可能不完整${diag ? `；${diag}` : ""}）`
        : (diag ? `\n\n（诊断：${diag}）` : "");
      const hint = stop === "error"
        ? `\n\n（提示：模型 ${route.provider}/${route.model} 没跑起来。若报 not allowed / provider 解析失败，` +
          `请确认 profile 的 cordis.patch.yml 里声明了 llm-pi-ai 的 providers.${route.provider}，` +
          `并且 .credentials.yaml 里有对应 api key。）`
        : "";
      if (!out) {
        return {
          ok: false, role, model: modelLabel, duration_s: dur,
          text: `${head}\n（助手没有产出任何文本${stop ? `；stopReason=${stop}` : ""}）${warn}`,
        };
      }
      return { ok: true, role, model: modelLabel, duration_s: dur, text: `${head}\n\n${out}${warn}` };
    } finally {
      try { await run.dispose?.(); } catch { /* 忽略 */ }
    }
  }

  // 回退：独立进程跑 BYK 自己的助手（拿不到工作区继承，但人格/模型仍由 --patch 保证）
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const work = `${bykRoot}/data/jobs/plugin-${role}-${stamp}`;
  const res = await runProcess(
    python,
    ["-m", "byk.cli", "agent", "--role", role, "--task", String(rawTask || ""), "--job-dir", work],
    { cwd: bykRoot, env },
    exec.signal,
  );
  const dur = (Date.now() - started) / 1000;
  const out = (res.stdout || "").trim();
  const errText = (res.stderr || "").trim();
  const where = `\n\n---\n[byk] ${modelLabel} ｜ 工作目录：${work}`;
  if (res.code === 0) {
    return { ok: true, role, model: modelLabel, duration_s: dur, text: (out || "（无产出）") + where };
  }
  return {
    ok: false, role, model: modelLabel, duration_s: dur,
    text: `【${meta.name}】执行失败（退出码 ${res.code}）。${errText ? `\n${errText}` : ""}${where}`,
  };
  }

  ctx.tools.register(defineTool({
    name: "byk_role",
    description:
      "把一个任务交给 BYK 的专业助手执行，拿回它的结论。它会以**该角色专属的模型与人格**" +
      "在一个独立上下文里干活（不同角色的模型不同：看图/看视频走视觉模型，代码走强推理模型）。\n\n" +
      "可用角色：\n" + ROLE_IDS.map((id) => `- \`${id}\`：${ROLE_BLURB[id]}`).join("\n") + "\n\n" +
      "什么时候用：任务明显属于上面某一类，且需要真实操作（跑命令、读文档、看图看视频、查资料）时。\n" +
      "什么时候别用：只是问一句话、或你自己就能立刻回答时 —— 每次调用都会真实拉起一个助手并计费。\n" +
      "助手没有跟你交互的通道，所以任务描述要自包含：写清背景、要做什么、怎样算完成；需要它读文件就给绝对路径。\n" +
      "长任务可以并发调用多个角色。",
    parameters: {
      role: { type: "string", required: true, enum: [...ROLE_IDS], description: "派给哪个助手。" },
      task: {
        type: "string",
        required: true,
        description: "完整任务说明：背景、目标、已知材料（含绝对路径）、验收标准。",
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean", required: true },
          role: { type: "string", required: true },
          model: { type: "string", required: true },
          duration_s: { type: "number", required: true },
          text: { type: "string", required: true },
        },
      },
      render: (_args, value) => [{ type: "text", text: value.text }],
    },
    timeoutMs,
    async execute(args, exec) {
      return runRole(String(args.role || ""), String(args.task || ""), exec);
    },
    presentCall: (args) => ({
      card: "generic",
      title: `助手：${args && args.role ? args.role : "BYK"}`,
      kind: "other",
      rawInput: args,
    }),
    // 结果卡片：让用户一眼看到「调了哪个助手、用哪个模型、成没成、花了多久」。
    presentResult: (args, result) => {
      const v = (result && result.value) || {};
      const role = String((args && args.role) || v.role || "助手");
      const text = String(v.text || "（无输出）");
      const status = v.ok ? "完成" : "失败";
      const secs = typeof v.duration_s === "number" ? `${v.duration_s.toFixed(1)}s` : "";
      const title = `助手 ${role} · ${v.model || ""} · ${status}${secs ? " · " + secs : ""}`;
      return { card: "generic", title, content: [{ type: "text", text }] };
    },
  }));

  // ── 工具 2：byk_hire ────────────────────────────────────────────────
  // 官方 Team 的 spawn_teammate 不支持按 teammate 指定模型，所以这里只负责
  // "把角色挂到团队面板与任务板上"，实际执行由该 teammate 调用 byk_role 完成。
  // ── 工具：byk_plan ────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: "byk_plan",
    description:
      "把用户的原始诉求交给「任务助手」拆成结构化计划：每步都带角色、依赖、验收标准与预计耗时。" +
      "返回的 plan_json 可直接喂给 byk_batch 执行。\n\n" +
      "拿到计划后必须先摆给用户确认（总目标、每步的角色、依赖、验收），确认或改完再执行；" +
      "用户还没确认就不要开始调其它角色的助手。",
    parameters: {
      request: { type: "string", required: true, description: "用户的原始诉求（尽量原文），附背景与涉及的绝对路径。" },
      context: { type: "string", description: "可选补充背景：已有材料、约束、上一版计划与用户反馈。" },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean", required: true },
          goal: { type: "string", required: true },
          step_count: { type: "number", required: true },
          plan_json: { type: "string", required: true },
          model: { type: "string", required: true },
          duration_s: { type: "number", required: true },
          text: { type: "string", required: true },
        },
      },
      render: (_args, value) => [{ type: "text", text: value.text }],
    },
    timeoutMs,
    async execute(args, exec) {
      const request = String(args.request || "").trim();
      if (!request) {
        return { ok: false, goal: "", step_count: 0, plan_json: "", model: "", duration_s: 0, text: "byk_plan 需要 request（用户的原始诉求）。" };
      }
      const promptText = PLAN_INSTRUCTION + "\n\n【用户诉求】\n" + request +
        (args.context ? "\n\n【补充背景】\n" + String(args.context) : "");
      const r = await runRole(planRole, promptText, exec);
      if (!r.ok) {
        return { ok: false, goal: "", step_count: 0, plan_json: "", model: r.model, duration_s: r.duration_s, text: r.text };
      }
      const parsed = parsePlan(r.text);
      if (!parsed.ok) {
        return {
          ok: false, goal: "", step_count: 0, plan_json: "", model: r.model, duration_s: r.duration_s,
          text: "任务助手没有返回可解析的计划 JSON（" + parsed.error + "）。\n\n【原始输出】\n" + r.text,
        };
      }
      const norm = normalizePlan(parsed.plan, { roles: ROLE_IDS, maxSteps: maxPlanSteps });
      const text = formatPlanText(norm.plan, norm.problems);
      return {
        ok: true, goal: norm.plan.goal, step_count: norm.plan.steps.length,
        plan_json: JSON.stringify(norm.plan), model: r.model, duration_s: r.duration_s, text,
      };
    },
    presentCall: (args) => ({
      card: "generic",
      title: "规划：任务助手拆解诉求",
      kind: "other",
      rawInput: args,
    }),
    presentResult: (args, result) => {
      const v = result && result.value ? result.value : {};
      const title = v.ok
        ? "执行计划 · " + String(v.step_count || 0) + " 步 · " + String(v.model || "") + " · " + Number(v.duration_s || 0).toFixed(1) + "s"
        : "规划失败 · " + String(v.model || "");
      return { card: "generic", title, kind: "other", rawOutput: v.text };
    },
  }));

  // ── 工具：byk_batch ───────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: "byk_batch",
    description:
      "并发执行一份已确认的计划：按 depends_on 拓扑分批，批内并发（默认上限 maxParallel），" +
      "每步都用它那个角色的模型与人格，并把前置步骤的结论自动拼进下一步的任务说明。" +
      "\n\n返回逐条结果 + 执行汇总（完成/失败计数、总耗时）。计划没经用户确认不要调用。" +
      "\n需要逐步可见的进度时，也可以不用本工具，改为按批次分别调用 byk_role。",
    parameters: {
      plan: { type: "string", required: true, description: "byk_plan 返回的 plan_json（原样贴回），或同结构 JSON 字符串。" },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean", required: true },
          total: { type: "number", required: true },
          done: { type: "number", required: true },
          failed: { type: "number", required: true },
          results_json: { type: "string", required: true },
          duration_s: { type: "number", required: true },
          text: { type: "string", required: true },
        },
      },
      render: (_args, value) => [{ type: "text", text: value.text }],
    },
    timeoutMs,
    async execute(args, exec) {
      const started = Date.now();
      let obj = null;
      try { obj = JSON.parse(String(args.plan || "")); }
      catch (err) {
        return { ok: false, total: 0, done: 0, failed: 0, results_json: "[]", duration_s: 0, text: "计划不是合法 JSON：" + String(err && err.message) };
      }
      const norm = normalizePlan(obj, { roles: ROLE_IDS, maxSteps: 24 });
      const plan = norm.plan;
      if (!plan.steps.length) {
        return { ok: false, total: 0, done: 0, failed: 0, results_json: "[]", duration_s: 0, text: "计划里没有可执行的步骤。" };
      }
      const { batches, blocked } = planBatches(plan, { maxParallel });
      const results = new Map();
      const rows = [];
      let done = 0;
      for (const batch of batches) {
        const settled = await Promise.all(batch.map(async (step) => {
          const depText = step.depends_on
            .filter((d) => results.has(d))
            .map((d) => "- " + d + "（" + results.get(d).model + "）：\n" + results.get(d).text)
            .join("\n\n");
          const full = step.task +
            (step.acceptance ? "\n\n【验收标准】" + step.acceptance : "") +
            (depText ? "\n\n【前置步骤结论】\n" + depText : "");
          const r = await runRole(step.role, full, exec);
          return { step, r };
        }));
        for (const { step, r } of settled) {
          results.set(step.id, r);
          done += 1;
          rows.push({
            id: step.id, title: step.title, role: step.role, ok: r.ok,
            model: r.model, duration_s: r.duration_s, text: r.text,
          });
        }
      }
      const failed = rows.filter((x) => !x.ok).length;
      const total = plan.steps.length;
      const dur = (Date.now() - started) / 1000;
      const lines = [];
      lines.push("【执行汇总】共 " + total + " 步，完成 " + (done - failed) + " 步，失败 " + failed + " 步，总耗时 " + dur.toFixed(1) + "s");
      lines.push("");
      lines.push("▸ 助手调用清单（角色 | 模型 | 状态 | 一句话结论）");
      rows.forEach((x, i) => {
        lines.push((i + 1) + ". " + x.id + " ｜ " + x.role + " ｜ " + x.model + " ｜ " + (x.ok ? "完成" : "失败") + " ｜ " + x.duration_s.toFixed(1) + "s ｜ " + String(x.title || "").slice(0, 60));
      });
      lines.push("");
      lines.push("▸ 各步结论");
      rows.forEach((x) => {
        lines.push("");
        lines.push("### " + x.id + "（" + x.role + " · " + x.model + " · " + (x.ok ? "完成" : "失败") + "）" + (x.title ? " " + x.title : ""));
        lines.push(x.text);
      });
      if (blocked.length) lines.push("", "【未执行】" + blocked.join("、") + "（依赖无法满足）");
      if (norm.problems.length) {
        lines.push("", "【计划提醒】");
        for (const p of norm.problems) lines.push("- " + p);
      }
      lines.push("", formatProgressText(done, total, "全部批次已结束"));
      return {
        ok: failed === 0 && blocked.length === 0,
        total, done, failed,
        results_json: JSON.stringify(rows.map((x) => ({ id: x.id, role: x.role, ok: x.ok, model: x.model, duration_s: x.duration_s, text: x.text }))),
        duration_s: dur,
        text: lines.join("\n"),
      };
    },
    presentCall: (args) => ({
      card: "generic",
      title: "批量执行已确认的计划",
      kind: "other",
      rawInput: args && typeof args.plan === "string" ? { plan: args.plan.slice(0, 400) } : args,
    }),
    presentResult: (args, result) => {
      const v = result && result.value ? result.value : {};
      return {
        card: "generic",
        title: "执行汇总 · 完成 " + String(v.done || 0) + "/" + String(v.total || 0) + " · 失败 " + String(v.failed || 0) + " · " + Number(v.duration_s || 0).toFixed(1) + "s",
        kind: "other",
        rawOutput: v.text,
      };
    },
  }));

  ctx.tools.register(defineTool({
    name: "byk_hire",
    description:
      "把一个 BYK 专业助手招进当前 Agent Team，成为具名持久 teammate：它会出现在团队面板与" +
      "共享任务板上，可以收发持久消息、跨中断恢复。\n\n" +
      "注意分工：**官方 teammate 不支持按人指定模型**，所以被招进来的 teammate 只是" +
      "这个角色的负责人，真正干活时要让它调用 `byk_role`（那个才会用对角色的模型与人格）。\n\n" +
      "什么时候用：需要长期协作、要在任务板上跟踪进度、或需要 teammate 之间互相通信时。\n" +
      "只是跑一次任务就直接用 `byk_role`，不必招人。",
    parameters: {
      role: { type: "string", required: true, enum: [...ROLE_IDS], description: "要招哪个角色。" },
      extra: {
        type: "string",
        description: "可选的额外职责说明，会附加到该 teammate 的初始任务里。",
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean", required: true },
          name: { type: "string", required: true },
          text: { type: "string", required: true },
        },
      },
      render: (_args, value) => [{ type: "text", text: value.text }],
    },
    async execute(args, exec) {
      const role = String(args.role || "");
      if (!ROLE_IDS.includes(role)) {
        return { ok: false, name: "", text: `未知角色 "${role}"。可用：${ROLE_IDS.join("、")}。` };
      }
      const agentTeams = getService(ctx, "agentTeams");
      if (!agentTeams) {
        return {
          ok: false, name: "",
          text: "当前会话没有启用 Agent Team（取不到 agentTeams 服务），无法招募 teammate。" +
                "请直接用 byk_role 执行任务。",
        };
      }
      let meta;
      try {
        meta = (await loadRegistry())[role];
      } catch (err) {
        return { ok: false, name: "", text: `无法读取角色定义：${String(err && err.message)}` };
      }
      const memberName = `byk-${role}`;
      const extra = args.extra ? `\n\n额外职责：${args.extra}` : "";
      const prompt =
        `你是团队里「${meta.name}」这个角色的负责人（角色 id：\`${role}\`）。\n\n` +
        `职责：${meta.description}\n` +
        `该角色配置的模型是 ${meta.provider}/${meta.model}。\n\n` +
        `**重要**：官方 teammate 不支持按人指定模型，所以你自己不直接干活 —— ` +
        `拿到任务后用 \`byk_role\` 工具、参数 role="${role}" 去执行。\n` +
        `那个工具会以该角色专属的模型与人格、在独立上下文里真正完成任务，然后把结论回给你，` +
        `你再把结论整理后回复 Lead。\n\n` +
        `协作纪律：用 \`team_task_*\` 更新你负责的任务状态；一次只处理交给你的任务；` +
        `完成后用 \`send_message\` 把结论发给 lead。` + extra;
      try {
        const res = await agentTeams.spawnTeammate(exec.agent, {
          name: memberName,
          description: `${meta.name}（BYK 角色 ${role}）`,
          prompt: [{ type: "text", text: prompt }],
          context: "fresh",
          signal: exec.signal,
        });
        return {
          ok: true, name: memberName,
          text: `已招入 teammate \`${memberName}\`（${meta.name}）。` +
                `它出现在团队面板与任务板上；执行任务时它会调用 byk_role（${meta.provider}/${meta.model}）。` +
                (res && res.childId ? `\n子会话 id：${res.childId}` : ""),
        };
      } catch (err) {
        return { ok: false, name: memberName, text: `招募失败：${String((err && err.message) || err)}` };
      }
    },
    presentCall: (args) => ({
      card: "generic",
      title: `招入 BYK ${args && args.role ? args.role : "助手"}`,
      kind: "other",
      rawInput: args,
    }),
  }));

  // ── 工具：byk_judge / byk_judge_batch ──────────────────────────────
  //
  // 为什么不复用宿主已装的 dsh-plugin-jev 工具（jev_judge / jev_systemone）：
  // ctx.tools 上的工具是注册给**模型**看的，插件之间没有"调用对方工具"的通道；
  // 要在 BYK 的规划/验收流程**内部**拿判定，走宿主工具就得再起一个子智能体、
  // 花一次完整的模型请求。这里直接发 HTTP：零额外 turn，且超时、错误归一化、
  // 返回格式都由本插件自己掌握。契约来源：docs/jev-planning-spec.md。
  const jevCfg = cfg.jev && typeof cfg.jev === "object" ? cfg.jev : {};
  const jevTimeoutMs = Number(jevCfg.timeoutMs) > 0 ? Number(jevCfg.timeoutMs) : DEFAULT_JEV_TIMEOUT_MS;
  const jev = createJevCaller(jevCfg, {
    fetch: globalThis.fetch,
    env: process.env,
    pluginDir,
  });

  /** 两个工具共用的 description 前半段：讲清"何时该用"，且**不依赖用户是否提到 Jev**。 */
  const JEV_WHEN_TO_USE =
    "对一个**有界语义判断**拿一次类型化判定（TypeSafe System One / Jev）。" +
    "**不依赖用户是否提到 Jev**：只要问题属于下面几类就直接用它，" +
    "不要自己写一段 prompt 让 LLM 打分再解析。\n\n" +
    "该用：验收判定（是否达标）、方案取舍（A/B/C 先做哪个）、风险与严重度定级、" +
    "相关性/优先级排序、分类与路由（这条该给谁）、置信度估计。\n" +
    "不该用：精确计算、确定性规则、执行动作（这些留代码）；需要长篇推理链或要生成解释的判断。\n\n" +
    "三类问题：" +
    "\n- \`noul\`：是/否概率，value 是 0–1 的数（1=是）。只问一个命题，措辞让「高分=是」。**noul 没有 confidence**。\n" +
    "- \`choice\`：多选一。value 是概率最高的选项，另给完整 probabilities 与 confidence。\n" +
    "- \`score\`：有序分级。value 是概率加权的等级位置（可落在两级之间），必须连 legend/probabilities 一起读。\n\n" +
    "返回**紧凑 JSON 字符串**：ok / value / confidence / judge_model / usage；" +
    "失败时是 ok:false + error_kind + error（不含糊、不假装判定已做）。" +
    "写进结论时请把 value、confidence、probabilities 一起带上，并标注 [jev] 出处。";

  ctx.tools.register(defineTool({
    name: "byk_judge",
    description:
      JEV_WHEN_TO_USE +
      "\n\n参数与宿主的 jev_judge 同构（state / question_type / question / criteria）。只问一条。",
    parameters: {
      state: { type: "string", required: true, description: "要评估的内容：文本或结构化数据。" },
      question_type: {
        type: "string",
        required: true,
        enum: [...QUESTION_TYPES],
        description: "noul=是/否概率；choice=多选一；score=有序分级。",
      },
      question: {
        type: "string",
        required: true,
        description: "要判断的问题。noul 只问一个命题；choice/score 写清判定标准。",
      },
      criteria: {
        type: "json",
        description: "noul 可选 {true,false}；choice 必填 {选项:说明}；score 必填 从低到高的等级数组（2–10 级）。",
      },
    },
    output: {
      schema: { type: "string" },
      render: (_args, value) => [{ type: "text", text: String(value) }],
    },
    // 比内部 AbortController 多留 5s：让"超时"以我们自己那句明确错误返回，
    // 而不是被宿主的工具超时掐掉、变成一句看不出原因的失败。
    timeoutMs: jevTimeoutMs + 5000,
    async execute(args, exec) {
      const type = String(args.question_type || "");
      const question = String(args.question || "").trim();
      // choice/score 缺 criteria 会必然吃 400，本地先拦下来（见 lib/jev.js validateQuestion）。
      const bad = validateQuestion(type, args.criteria);
      if (bad) return errorJson("config", bad);
      if (!question) return errorJson("config", "question 不能为空。");

      const r = await jev.call(
        String(args.state == null ? "" : args.state),
        { q: buildQuestion(type, question, args.criteria) },
        exec,
      );
      if (!r.ok) {
        ctx.logger?.warn?.("[byk-agents] byk_judge 失败 [" + r.kind + "]：" + String(r.error).slice(0, 300));
      }
      return toJudgeJson(r, "q");
    },
    presentCall: (args) => ({
      card: "generic",
      title: "Jev 判定：" + String((args && args.question_type) || ""),
      kind: "other",
      rawInput: args,
    }),
    presentResult: (_args, result) => {
      const raw = String((result && result.value) || "");
      let title = "Jev 判定";
      try {
        const v = JSON.parse(raw);
        title = v.ok
          ? "Jev " + String(v.type || "") + " · " + JSON.stringify(v.value) +
            (typeof v.confidence === "number" ? " · conf " + v.confidence : "") +
            (v.judge_model ? " · " + v.judge_model : "")
          : "Jev 判定失败 · " + String(v.error_kind || "");
      } catch { /* 不是 JSON 就按原文显示 */ }
      return { card: "generic", title, kind: "other", rawOutput: raw };
    },
  }));

  ctx.tools.register(defineTool({
    name: "byk_judge_batch",
    description:
      JEV_WHEN_TO_USE +
      "\n\n**多题一次调用**：questions 里放多个键 = 并行多条互相独立的判断（官方称比逐题调用" +
      "便宜约一个数量级、快约 10 倍），answers 按同一批键返回；answer 顺序与语义都按 key 匹配。" +
      "规划阶段建议一次问完「验收可行吗(noul) + 该谁做(choice) + 风险几级(score)」，" +
      "把整包结果写进任务说明的判断依据。**只有需要根据前一答案构造下一问的 state 时才分两次调用。**",
    parameters: {
      state: { type: "string", required: true, description: "要评估的内容（所有题共用同一份 state）。" },
      questions: {
        type: "json",
        required: true,
        description: "Jev questions 对象：{ 问题id: { type, instructions, criteria? } }；id 由你自定、不参与推理，响应按同一批键返回。",
      },
    },
    output: {
      schema: { type: "string" },
      render: (_args, value) => [{ type: "text", text: String(value) }],
    },
    timeoutMs: jevTimeoutMs + 5000,
    async execute(args, exec) {
      const questions = args.questions;
      if (!questions || typeof questions !== "object" || Array.isArray(questions)) {
        return errorJson("config", "questions 必须是对象 { 问题id: { type, instructions, criteria? } }。");
      }
      const ids = Object.keys(questions);
      if (ids.length === 0) return errorJson("config", "questions 里一道题都没有。");
      for (const id of ids) {
        const item = questions[id] && typeof questions[id] === "object" ? questions[id] : {};
        const bad = validateQuestion(String(item.type || ""), item.criteria);
        if (bad) return errorJson("config", "questions." + id + "：" + bad);
        if (!item.instructions) return errorJson("config", "questions." + id + " 缺少 instructions。");
      }
      const r = await jev.call(String(args.state == null ? "" : args.state), questions, exec);
      if (!r.ok) {
        ctx.logger?.warn?.("[byk-agents] byk_judge_batch 失败 [" + r.kind + "]：" + String(r.error).slice(0, 300));
      }
      return toBatchJson(r);
    },
    presentCall: (args) => ({
      card: "generic",
      title: "Jev 批量判定：" + String(
        args && args.questions && typeof args.questions === "object" ? Object.keys(args.questions).length : 0,
      ) + " 题",
      kind: "other",
      rawInput: args,
    }),
    presentResult: (_args, result) => {
      const raw = String((result && result.value) || "");
      let title = "Jev 批量判定";
      try {
        const v = JSON.parse(raw);
        title = v.ok
          ? "Jev 批量 · " + Object.keys(v.answers || {}).length + " 题 · " + String(v.judge_model || "")
          : "Jev 批量判定失败 · " + String(v.error_kind || "");
      } catch { /* 不是 JSON 就按原文显示 */ }
      return { card: "generic", title, kind: "other", rawOutput: raw };
    },
  }));

  // ── 工具：byk_mood ─────────────────────────────────────────────────
  //
  // 一次 Jev 调用固定三问（情绪基调 choice / 着急程度 score / 这一轮最需要什么 choice）。
  // 三问共用一份 state、走同一个请求：官方多问一调用的说法是比拆成三次便宜一个数量级。
  // 问题措辞与默认选项定义在 lib/mood.js（语义层），这里只做参数校验与结果透传，
  // HTTP / key / 超时全部复用上面那一个 jev 调用器。
  ctx.tools.register(defineTool({
    name: "byk_mood",
    description:
      "读一次用户这一轮的情绪：一次 Jev 调用固定问三件事——情绪基调（choice）、" +
      "着急程度（score）、这一轮最需要先满足什么（choice）。**只读用户的话本身**，不推测没写出来的事。\n\n" +
      "什么时候用：**每个需求轮开头**拿一次，再据此决定先说什么、以什么顺序交付——" +
      "先把情绪接住，再排任务顺序；判定结果连同 value / confidence 写进进度播报与最终交付。\n" +
      "什么时候不用：纯事实查证、一行小问题、用户明确要求直接给结论时不要调用，" +
      "省一次调用，也省一次等待。\n\n" +
      "边界：情绪判读**只改措辞与呈现顺序，不改任务范围与验收标准**；confidence 偏低时如实说是弱信号；" +
      "不做无原则附和——方案有代价照样直说，只是把话说得更接得住。\n\n" +
      "criteria 可选，用来覆盖三问的选项：{ emotion?, urgency?, need? }" +
      "（emotion / need 是 choice 的 {选项: 说明}；urgency 是从低到高的等级数组，2–10 级）；" +
      "不覆盖就用通用默认选项。\n\n" +
      "返回**紧凑 JSON 字符串**：成功 { ok:true, emotion:{...}, urgency:{...}, need:{...}, judge_model, usage }，" +
      "每项带 id / type / value / confidence（choice 另带 probabilities，score 另带 legend 与 probabilities）；" +
      "失败 { ok:false, error_kind, error }（不含糊、不假装判过）。",
    parameters: {
      state: {
        type: "string",
        required: true,
        description:
          "用户这一轮的原话或输入（被读的对象）。原文照抄即可，不要替他改写成「他好像很急」再传进来。",
      },
      criteria: {
        type: "json",
        description:
          "可选覆盖 { emotion?, urgency?, need? }：emotion/need 为 {选项:说明}，urgency 为从低到高的等级数组（2–10 级）。",
      },
    },
    output: {
      schema: { type: "string" },
      render: (_args, value) => [{ type: "text", text: String(value) }],
    },
    // 与 byk_judge 同款：比内部 AbortController 多留 5s，让超时以我们自己的明确错误返回。
    timeoutMs: jevTimeoutMs + 5000,
    async execute(args, exec) {
      // 覆盖项形状不对（choice 没给对象、score 只给一级…）本地先拦下，
      // 不拿必然 400 的请求去打网络（见 lib/mood.js validateMoodCriteria）。
      const bad = validateMoodCriteria(args.criteria);
      if (bad) return errorJson("config", bad);
      const r = await jev.call(
        String(args.state == null ? "" : args.state),
        moodQuestions(args.criteria),
        exec,
      );
      if (!r.ok) {
        ctx.logger?.warn?.("[byk-agents] byk_mood 失败 [" + r.kind + "]：" + String(r.error).slice(0, 300));
      }
      return toMoodJson(r);
    },
    presentCall: (args) => ({
      card: "generic",
      title: "读一次用户情绪",
      kind: "other",
      rawInput: args,
    }),
    presentResult: (_args, result) => {
      const raw = String((result && result.value) || "");
      let title = "情绪判读";
      try {
        const v = JSON.parse(raw);
        title = v.ok ? summarizeMood(raw) : "情绪判读失败 · " + String(v.error_kind || "");
      } catch { /* 不是 JSON 就按原文显示 */ }
      return { card: "generic", title, kind: "other", rawOutput: raw };
    },
  }));

  ctx.logger?.info?.(
    `[byk-agents] 已注册 byk_role / byk_plan / byk_batch / byk_hire / byk_judge / byk_judge_batch / byk_mood（角色：${ROLE_IDS.join(", ")}；` +
    `子智能体 provider 在执行时惰性探测；Jev：${jev.baseUrl} · ${jev.model} · ${jevTimeoutMs}ms · key ${jev.describe().keySource || "未配置（调用时明确报错）"}）`,
  );
}

export { Config, apply, inject, name };