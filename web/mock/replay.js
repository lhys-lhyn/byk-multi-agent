/* mock 回放脚本（浏览器端 ES module）。
   产出符合契约 §5 的事件序列；由 js/mock-backend.js 按定时器逐步投递。
   步骤字段：
     id                调试/截图用的锚点，可用 ?mock=1&at=<id> 直接跳到该步并冻结
     event             SSE 事件名（契约 §5）
     data              事件负载（对象，或返回对象的函数；返回 null 则跳过该事件）
     delay             该步之前的等待毫秒数
     gate              需要用户操作的闸门：'plan' / 'privilege-1' / 'privilege-2'
     rejectBranch      该闸门被拒绝后进入的分支
     missingSecretBranch  已批准但没提交 secret_ref 时进入的分支（仅 requires_secret 的闸门）
     branch            分支标记，只有当前分支匹配时才执行
     gateHint          发出对应 confirmation 后，告诉后端驱动"下一个闸门是谁"
     needs             依赖的 live 子任务 id；该子任务被删掉后跳过

   两个提权闸门分别对应 mock/confirmation.json 里的两个样本：
     c_mock_01  requires_secret=false（密钥引用已由先例绑定）→ 普通确认
     c_mock_02  requires_secret=true （{{secret}} 未绑定引用，risk=high）→ 告警态 + 需补密钥引用
*/

const clone = (x) => JSON.parse(JSON.stringify(x));

const ST1_STREAM = `[code] 读取 TASK.md 与附件清单（a1 server.log / a2 PDF / a3 PNG）
[code] 读取 G:\\deploy\\order-service\\logs\\server.log （18432 B / 12 行）
[code] 命中关键行：Web server failed to start. Port 8080 was already in use.
[code] 证据 1 · 第 3 行 08:58:13.512 Tomcat started on port(s): 8080 (http)
[code] 证据 2 · 第 7 行 Web server failed to start. Port 8080 was already in use.
[code] 证据 3 · 第 11 行 Shutting down, uptime 1.6s（绑定失败后立即退出）
[code] 执行 netstat -ano | findstr :8080
[code]   TCP    0.0.0.0:8080    0.0.0.0:0    LISTENING    10432
[code] 执行 tasklist /FI "PID eq 10432"
[code]   order-service-legacy.exe    10432    Console    1    128,412 K
[code] 结论：上一代 order-service-legacy（PID 10432）仍占用 8080，Tomcat 绑定失败即退出。
[code] 已写入 RESULT.md（含 3 条证据与行号）。
`;

const ST2_STREAM_OUT = `[code] 用户已批准提权操作，密钥引用 PRECEDENT_ROOT_PW_SRV1（不回显明文）
[code] 执行 powershell -NoProfile -Command "Stop-Process -Id 10432 -Force"
[code] Stop-Process 完成：PID 10432 已终止
[code] 执行 Restart-Service order-service
[code] 等待 8 秒后探测 http://127.0.0.1:8080/health ...
[code] 第 1 次：HTTP 200 {"status":"UP","port":8080}
[code] 第 2 次：HTTP 200 {"status":"UP","port":8080}
[code] netstat 复查：8080 现在由 PID 22180（order-service）监听
`;

const ST2_STREAM_ERR = `[warn] Stop-Process 需要管理员权限，已通过先例模板切换到提升模式
[warn] 端口释放检测到 1.2s 的 TIME_WAIT，可忽略
`;

const ST3_STREAM_REST = `[code] 执行 Set-ADAccountPassword -Identity order-svc
[code] 口令已更新（密钥值不回显，仅以引用方式注入）
[code] 执行 sc.exe config order-service obj= 'DOMAIN\\order-svc' password= <已注入>
[code] 服务注册信息已更新
[code] 重启 order-service 并等待 8 秒
[code] GET /health → 200 {"status":"UP","port":8080}
[code] 已写入 RESULT.md：口令轮换完成，服务注册已更新
`;

const ST4_STREAM = `[search] web_search: order-service framework "Port 8080 was already in use" windows
[search] 命中官方文档：未显式配置 server.port 时会回落到 8080（建议配置化）
[search] 命中 issue #4127：升级脚本未校验端口占用，3.5.0 已修复
[search] 命中 issue #3988：Windows 服务默认不处理优雅停机信号，需显式配置
[search] 汇总 2 条可落地建议并附来源
`;

const ST1_OUTPUT = `根因：8080 被上一代进程 order-service-legacy（PID 10432）占用，order-service 启动时 Tomcat 绑定失败并立即退出。

证据：
1. server.log 第 3 行 08:58:13.512 — Tomcat initialized with port(s): 8080 (http)
2. server.log 第 7 行 08:58:13.515 — Web server failed to start. Port 8080 was already in use.
3. server.log 第 11 行 08:58:13.640 — Shutting down, uptime 1.6s
4. netstat -ano → 0.0.0.0:8080 LISTENING 10432；tasklist 显示该 PID 为 order-service-legacy.exe

说明：a3（crash-2026-06-11.png）因本机缺少 rapidocr-onnxruntime 未做 OCR，未纳入判定。
下一步需要终止 PID 10432 并重启服务（属特权操作，等待确认）。`;

const ST2_OUTPUT = `结论：占用 8080 的旧进程已终止，order-service 重启成功，健康检查连续两次返回 200。

执行记录：
- Stop-Process -Id 10432 -Force → 成功
- Restart-Service order-service → 成功（耗时 6.2s）
- GET /health → 200 {"status":"UP","port":8080}（第 1 次）
- GET /health → 200 {"status":"UP","port":8080}（第 2 次）
- netstat 复查：0.0.0.0:8080 LISTENING 22180（order-service）

风险动作已由用户批准后执行，密钥仅以引用方式使用。`;

const ST3_OUTPUT = `结论：服务账号口令已轮换，order-service 已用新口令重新注册并恢复正常。

执行记录：
- 密钥引用：由用户在提权确认弹层中补充（明文不回显，仅以引用注入）
- Set-ADAccountPassword -Identity order-svc → 成功
- sc.exe config order-service obj= 'DOMAIN\\order-svc' password= <已注入> → 成功
- Restart-Service order-service → 成功；GET /health → 200
- 复查：服务登录身份为 DOMAIN\\order-svc，启动类型 auto

说明：该确认的 requires_secret 为 true（{{secret}} 未绑定引用），因此没有用户补充的引用就无法执行。`;

const ST4_OUTPUT = `可落地建议（均附来源）：
1. 端口配置化：显式配置 server.port 并加入启动预检，避免回落 8080（官方配置文档）。
2. 升级脚本增加端口占用校验：升级前 netstat 检测，冲突则中止（issue #4127，3.5.0 修复）。
3. 配置优雅停机：Windows 服务下显式处理停机信号，避免旧进程残留（issue #3988）。

来源：框架官方配置文档、issue #4127、issue #3988（检索于 2026-06-11）。`;

/** 把长文本切成"流式"小块，模拟 agent_delta */
function chunkify(text, size = 44) {
  const out = [];
  for (const line of text.split('\n')) {
    const s = `${line}\n`;
    if (s.length <= size) { out.push(s); continue; }
    for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size));
  }
  return out;
}

function subBase(s) {
  return {
    id: s.id, title: s.title, role: s.role, detail: s.detail,
    status: 'pending', started_at: null, finished_at: null,
    duration_s: null, output: '', log_tail: '', error: null, artifacts: [],
  };
}

export function buildReplay(ctx) {
  const { turn, plan } = ctx;
  const confirmations = Array.isArray(ctx.confirmations) ? ctx.confirmations : [ctx.confirmations];
  const confA = confirmations.find((c) => c && c.requires_secret === false) || confirmations[0];
  const confB = confirmations.find((c) => c && c.requires_secret === true) || confirmations[1] || confirmations[0];
  const T = turn.turn_id;
  const [exLog, exPdf, exPng] = ctx.extractions;

  const live = { plan: clone(plan), subs: {}, secretRef: null, secretGate: null };
  const rebuildSubs = () => {
    live.subs = {};
    for (const s of live.plan.subtasks || []) live.subs[s.id] = subBase(s);
  };
  rebuildSubs();

  const steps = [];
  const step = (s) => { steps.push(s); return s; };

  /** 生成"把 live.subs[id] 打补丁后作为 subtask 事件负载"的函数 */
  const sub = (id, patch, opts = {}) => () => {
    const s = live.subs[id];
    if (!s) return null;                       // 该子任务已被用户在计划卡片里删除
    Object.assign(s, typeof patch === 'function' ? patch(s) : patch);
    return { turn_id: T, subtask: clone(s) };
  };

  const deltas = (id, text, { stream = 'stdout', delay = 105, anchor = null, anchorAt = -1, branch = null } = {}) => {
    const parts = chunkify(text);
    parts.forEach((p, i) => {
      step({
        needs: id,                                   // 该子任务被删掉后不再产流
        branch,                                      // 必须在闸门之后的流要打分支标记，否则拒绝后会继续产流
        event: 'agent_delta',
        data: { turn_id: T, subtask_id: id, stream, text: p },
        delay: i === 0 ? 160 : delay,
        id: anchor && i === anchorAt ? anchor : undefined,
      });
    });
  };

  const iso = (offsetMs) => new Date(Date.now() + offsetMs).toISOString();
  const confirmationPayload = (c) => clone({ ...c, turn_id: T });

  /* ---------------------------------------------------------- 事件序列 */

  step({ id: 'connect', event: 'snapshot', data: clone(turn), delay: 260 });

  step({ id: 'extracting', event: 'stage', data: { turn_id: T, stage: 'extracting' }, delay: 520 });
  step({ event: 'extraction', data: { turn_id: T, extraction: exLog }, delay: 780 });
  step({ event: 'extraction', data: { turn_id: T, extraction: exPdf }, delay: 620 });
  step({ event: 'extraction', data: { turn_id: T, extraction: exPng }, delay: 620 });

  step({ event: 'stage', data: { turn_id: T, stage: 'planning' }, delay: 760 });
  step({ id: 'plan-ready', event: 'plan', data: () => ({ turn_id: T, plan: clone(live.plan) }), delay: 900 });
  step({ id: 'plan', event: 'stage', data: { turn_id: T, stage: 'awaiting_confirmation' }, delay: 220 });

  // 闸门 0：等待用户在计划确认卡片上点「确认执行」
  step({ gate: 'plan', delay: 0 });

  step({ event: 'stage', data: { turn_id: T, stage: 'executing' }, delay: 260 });

  /* --- st_1：正常执行，流式输出 --- */
  step({ event: 'subtask', data: sub('st_1', { status: 'running', started_at: iso(0) }), delay: 200 });
  deltas('st_1', ST1_STREAM, { anchor: 'running', anchorAt: 12 });
  step({
    event: 'subtask',
    delay: 420,
    data: sub('st_1', {
      status: 'succeeded', finished_at: iso(0), duration_s: 6.4, output: ST1_OUTPUT,
      artifacts: [{ name: 'RESULT.md', path: 'G:\\byk-data\\jobs\\t_mock_0001\\st_1\\RESULT.md', kind: 'markdown' }],
    }),
  });

  /* --- 闸门 1：提权确认 A（requires_secret=false，密钥引用已由先例绑定） --- */
  step({
    event: 'confirmation', gateHint: 'privilege-1', delay: 700,
    data: () => ({ turn_id: T, confirmation: confirmationPayload(confA) }),
  });
  step({ id: 'privilege', gate: 'privilege-1', confirmationId: confA.id, confirmationSecretRef: confA.secret_ref || null, rejectBranch: 'privilege-rejected', delay: 0 });

  step({ branch: 'approved', event: 'subtask', delay: 240, data: sub('st_2', { status: 'running', started_at: iso(0) }) });
  deltas('st_2', ST2_STREAM_ERR, { stream: 'stderr', delay: 150, anchor: 'running-st2', anchorAt: 1, branch: 'approved' });
  deltas('st_2', ST2_STREAM_OUT, { delay: 105, branch: 'approved' });
  step({
    branch: 'approved', event: 'subtask', delay: 420,
    data: sub('st_2', {
      status: 'succeeded', finished_at: iso(0), duration_s: 6.2, output: ST2_OUTPUT,
      artifacts: [{ name: 'RESULT.md', path: 'G:\\byk-data\\jobs\\t_mock_0001\\st_2\\RESULT.md', kind: 'markdown' }],
    }),
  });

  /* --- 闸门 2：提权确认 B（requires_secret=true，{{secret}} 未绑定引用，risk=high） --- */
  step({
    branch: 'approved', event: 'confirmation', gateHint: 'privilege-2', delay: 700,
    data: () => ({ turn_id: T, confirmation: confirmationPayload(confB) }),
  });
  step({
    branch: 'approved',
    id: 'privilege-secret', gate: 'privilege-2', confirmationId: confB.id,
    confirmationSecretRef: confB.secret_ref || null, requireSecret: confB.requires_secret === true,
    rejectBranch: 'privilege-2-rejected', missingSecretBranch: 'secret-missing', delay: 0,
  });

  // 第一段增量按"用户是否补了密钥引用"动态生成（单独一步，避免分块数不一致）
  step({
    needs: 'st_3', branch: 'approved', event: 'agent_delta', delay: 200,
    data: () => ({
      turn_id: T, subtask_id: 'st_3', stream: 'stdout',
      text: live.secretRef
        ? `[code] 用户已批准提权，密钥引用由弹层补充：${live.secretRef}（不回显明文）\n`
        : '[code] 用户已批准提权，但未提交 secret_ref（沿用先例绑定：无）\n',
    }),
  });
  step({ branch: 'approved', event: 'subtask', delay: 60, data: sub('st_3', { status: 'running', started_at: iso(0) }) });
  deltas('st_3', ST3_STREAM_REST, { delay: 105, branch: 'approved' });
  step({
    branch: 'approved', event: 'subtask', delay: 420,
    data: sub('st_3', (s) => ({
      status: 'succeeded', finished_at: iso(0), duration_s: 5.3,
      output: `${ST3_OUTPUT.replace('由用户在提权确认弹层中补充', live.secretRef ? `由用户在提权确认弹层中补充：${live.secretRef}` : '缺失')}`,
      artifacts: [{ name: 'RESULT.md', path: 'G:\\byk-data\\jobs\\t_mock_0001\\st_3\\RESULT.md', kind: 'markdown' }],
      log_tail: s.log_tail,
    })),
  });

  step({ branch: 'approved', event: 'subtask', delay: 300, data: sub('st_4', { status: 'running', started_at: iso(0) }) });
  deltas('st_4', ST4_STREAM, { delay: 100, branch: 'approved' });
  step({
    branch: 'approved', event: 'subtask', delay: 400,
    data: sub('st_4', {
      status: 'succeeded', finished_at: iso(0), duration_s: 4.1, output: ST4_OUTPUT,
      artifacts: [{ name: 'RESULT.md', path: 'G:\\byk-data\\jobs\\t_mock_0001\\st_4\\RESULT.md', kind: 'markdown' }],
    }),
  });

  step({ branch: 'approved', event: 'stage', data: { turn_id: T, stage: 'summarizing' }, delay: 320 });
  step({
    branch: 'approved', event: 'summary', delay: 700,
    data: () => ({
      turn_id: T,
      summary: `已完成本轮处置，服务已恢复。

【根因】
8080 端口被上一代进程 order-service-legacy（PID 10432）占用，order-service 启动时 Tomcat 绑定失败，1.6 秒后退出（server.log 第 7 行）。

【已执行】
- st_1 代码助手：读取 server.log，给出 3 条带行号的证据链，确认根因。
- st_2 代码助手（提权，经用户批准）：终止 PID 10432 并重启 order-service；/health 连续两次返回 200。
- st_3 代码助手（提权 + 需密钥，经用户批准）：服务账号口令已轮换并重新注册服务。该确认 requires_secret=true，实际使用的密钥引用：${live.secretRef || '（无）'}。
- st_4 搜索助手：检索到 3 条长期规避建议（端口配置化、升级前端口预检、优雅停机）。

【待你确认】
questions 中的第 2 条尚未处理：是否要把 order-service 改为开机自启并加入端口占用预检？如需要，我可以再开一个回合处理。

【附件说明】
crash-2026-06-11.png 未做 OCR（本机缺 rapidocr-onnxruntime），截图内容未纳入分析。`,
    }),
  });
  step({ id: 'done', branch: 'approved', event: 'done', delay: 300, data: { turn_id: T, stage: 'completed' } });

  /* --- 分支：闸门 1 被拒（什么都没执行） --- */
  step({
    branch: 'privilege-rejected', event: 'subtask', delay: 260,
    data: sub('st_2', { status: 'blocked', finished_at: iso(0), duration_s: 0.4, error: '用户拒绝了提权请求，未执行 Stop-Process / Restart-Service' }),
  });
  step({
    branch: 'privilege-rejected', event: 'subtask', delay: 320,
    data: sub('st_3', { status: 'skipped', finished_at: iso(0), error: '依赖 st_2 未完成，已跳过（口令轮换未执行）' }),
  });
  step({
    branch: 'privilege-rejected', event: 'subtask', delay: 320,
    data: sub('st_4', { status: 'skipped', finished_at: iso(0), error: '依赖 st_3 未完成，已跳过' }),
  });
  step({ branch: 'privilege-rejected', event: 'stage', data: { turn_id: T, stage: 'summarizing' }, delay: 260 });
  step({
    branch: 'privilege-rejected', event: 'summary', delay: 600,
    data: {
      turn_id: T,
      summary: '你拒绝了提权操作，因此未终止占用 8080 的旧进程（PID 10432），order-service 仍处于启动失败状态。\n\n已完成：st_1 定位到根因（端口被 order-service-legacy 占用）。\n未完成：st_2（结束旧进程并重启）、st_3（口令轮换）、st_4（依赖 st_3）。\n\n如需继续，请在下一回合允许该特权操作，或改为手工重启服务后让我复查 /health。',
    },
  });
  step({ branch: 'privilege-rejected', event: 'done', delay: 280, data: { turn_id: T, stage: 'failed' } });

  /* --- 分支：闸门 2 被拒（端口已修，但口令轮换未做） --- */
  step({
    branch: 'privilege-2-rejected', event: 'subtask', delay: 260,
    data: sub('st_3', { status: 'blocked', finished_at: iso(0), duration_s: 0.4, error: '用户拒绝了提权请求，未执行口令轮换与重新注册' }),
  });
  step({
    branch: 'privilege-2-rejected', event: 'subtask', delay: 320,
    data: sub('st_4', { status: 'skipped', finished_at: iso(0), error: '依赖 st_3 未完成，已跳过' }),
  });
  step({ branch: 'privilege-2-rejected', event: 'stage', data: { turn_id: T, stage: 'summarizing' }, delay: 260 });
  step({
    branch: 'privilege-2-rejected', event: 'summary', delay: 600,
    data: {
      turn_id: T,
      summary: '你拒绝了口令轮换（st_3），但 st_1/st_2 已完成：8080 端口已释放，order-service 已恢复并返回 200。\n\n未完成：st_3（口令轮换与重新注册）、st_4（依赖 st_3）。\n服务当前仍在用旧口令运行，建议在低峰期再处理口令轮换。',
    },
  });
  step({ branch: 'privilege-2-rejected', event: 'done', delay: 280, data: { turn_id: T, stage: 'failed' } });

  /* --- 分支：闸门 2 批准了但没补密钥引用（后端 fail closed） --- */
  step({
    branch: 'secret-missing', event: 'subtask', delay: 260,
    data: sub('st_3', {
      status: 'blocked', finished_at: iso(0), duration_s: 0.4,
      error: '命令含 {{secret}} 占位符但没有可用密钥引用（requires_secret=true），未执行口令轮换',
    }),
  });
  step({
    branch: 'secret-missing', event: 'subtask', delay: 320,
    data: sub('st_4', { status: 'skipped', finished_at: iso(0), error: '依赖 st_3 未完成，已跳过' }),
  });
  step({ branch: 'secret-missing', event: 'stage', data: { turn_id: T, stage: 'summarizing' }, delay: 260 });
  step({
    branch: 'secret-missing', event: 'summary', delay: 600,
    data: {
      turn_id: T,
      summary: '你批准了提权，但没有补填密钥引用，因此 st_3（口令轮换）未执行：该命令含 {{secret}} 占位符，而本次确认的 requires_secret=true、没有可用先例绑定引用，后端按 fail closed 拒绝执行。\n\n已完成：st_1 定位根因、st_2 恢复服务（/health 返回 200）。\n未完成：st_3（口令轮换）、st_4（依赖 st_3）。\n\n补救办法：先通过密钥库录入引用（POST /api/secrets），再重开一个回合；或下次在提权弹层的输入框里直接填写引用名。',
    },
  });
  step({ branch: 'secret-missing', event: 'done', delay: 280, data: { turn_id: T, stage: 'failed' } });

  /* --- 分支：直接取消计划 --- */
  step({ branch: 'plan-cancelled', event: 'done', delay: 200, data: { turn_id: T, stage: 'cancelled' } });

  return { steps, live, rebuildSubs };
}

export const REPLAY_ANCHORS = [
  'connect', 'extracting', 'plan-ready', 'plan', 'running', 'running-st2',
  'privilege', 'privilege-secret', 'done',
];
