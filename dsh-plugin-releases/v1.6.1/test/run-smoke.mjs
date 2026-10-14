/**
 * 冒烟测试 harness：真实运行时里 lib/index.js 的 @deepseek-ai/* 由 DSH loader 解析，
 * 直接在插件目录跑 node 会因为缺少宿主包而失败。这里把 lib/ + test/ 复制到临时目录，
 * 并在那里放一个 defineTool 直通桩（冒烟测试直接调 tool.execute，用不到真桩的校验），
 * 从而不改动插件目录、不遮蔽宿主真包。运行：node test/run-smoke.mjs
 */
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL("..", import.meta.url));
const root = mkdtempSync(join(tmpdir(), "byk-plugin-smoke-"));
mkdirSync(join(root, "lib"), { recursive: true });
mkdirSync(join(root, "test"), { recursive: true });
for (const f of readdirSync(join(here, "lib"))) {
  if (f.endsWith(".js") && !f.includes(".orig-")) copyFileSync(join(here, "lib", f), join(root, "lib", f));
}
copyFileSync(join(here, "package.json"), join(root, "package.json"));
copyFileSync(join(here, "test", "smoke.test.js"), join(root, "test", "smoke.test.js"));

const scope = join(root, "node_modules", "@deepseek-ai");
mkdirSync(scope, { recursive: true });
const stub = join(scope, "dsh-tools");
mkdirSync(stub, { recursive: true });
writeFileSync(join(stub, "package.json"), JSON.stringify({ name: "@deepseek-ai/dsh-tools", version: "0.0.0-teststub", type: "module", main: "index.js", exports: { ".": "./index.js" } }, null, 2));
writeFileSync(join(stub, "index.js"), [
  "// 测试桩：真 defineTool 会按 schema 校验参数并登记展示元数据；冒烟测试直接调 execute，故直通。",
  "export function defineTool(def) { return def; }",
  "export default { defineTool };",
  "",
].join("\n"));
// 用**真实复制**而不是 junction 链接：Windows 上 rmSync(recursive) 会顺着 junction 删进目标目录，
// 2026-10-06 曾因此在收尾清理时把 profile 里的 @deepseek-ai/schemastery 删空。复制进自己的临时目录最安全。
const hostScope = "C:/coding/DSH Home/profiles/desktop/node_modules/@deepseek-ai";
for (const pkg of ["schemastery", "cosmokit"]) {
  const from = join(hostScope, pkg);
  if (!existsSync(from)) {
    console.error("找不到依赖 " + pkg + "：" + from);
    process.exit(2);
  }
  cpSync(from, join(scope, pkg), { recursive: true, dereference: true });
}
if (!existsSync(join(scope, "schemastery", "package.json"))) {
  console.error("schemastery 复制不完整：" + join(scope, "schemastery"));
  process.exit(2);
}

const r = spawnSync(process.execPath, [join(root, "test", "smoke.test.js")], { cwd: root, stdio: "inherit", env: { ...process.env, BYK_ROOT: process.env.BYK_ROOT || "C:/Projects/byk" } });
rmSync(root, { recursive: true, force: true });
process.exit(r.status === null ? 1 : r.status);