#!/usr/bin/env node
// write_gate — Claude Code の PreToolUse フック（Write / Edit / NotebookEdit）。「要件を書き直してから製造する」を書き込みの瞬間に強制する。
// 正本は ~/.claude/brain/tools/trace/。ユーザー設定の PreToolUse に 1 本置けば、traceconfig.json のあるプロジェクトだけで効く。
//
//   {"hooks": {"PreToolUse": [{"matcher": "Write|Edit|NotebookEdit", "hooks": [{"type": "command", "command": "node \"$HOME/.claude/brain/tools/trace/write_gate.mjs\"", "timeout": 20}]}]}}
//
// 判定（書き込み先が traceconfig.json の source / tests の中のときだけ）:
//   通す: docs/spec.yaml に未コミットの変更がある（要件の書き直しが先に行われている）
//   通す: .trace-gate/work.json が {"reqs": ["REQ-xxx", …], "kind": "bugfix|feature|refactor", "note": "…"} を持ち、全 ID が spec.yaml に実在し withdrawn でない
//         （仕様は正しく実装が違うバグ修正など、要件を変えずに触る作業。何の要件のための書き込みかを先に宣言させる。**宣言を書くのは親だけ**。担当が自分で置いた宣言は門の迂回。Stop フックは宣言が残っていると止める）
//   止める（exit 2）: 上のどちらも無い。stderr に「先に docs/spec.yaml の要件を書き換える（新規は status: draft、次の番号は trace_check --next req）か、.trace-gate/work.json に対象の REQ を宣言する」
//   通す: spec.yaml・traceconfig.json・trace_ignore・.trace-gate/・docs/ 配下・source/tests の外（門の前提を書く操作は止めない）
//   通す: フック自身の内部エラー（壊れたフックでセッションを止めない）。判定は .trace-gate/log.jsonl に 1 行
export const VERSION = "1.3.0";

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

function readStdin() { try { return fs.readFileSync(0, "utf8"); } catch { return ""; } }
function log(dir, entry) { try { fs.mkdirSync(dir, { recursive: true }); fs.appendFileSync(path.join(dir, "log.jsonl"), JSON.stringify({ ts: new Date().toISOString(), gate: "write", ...entry }) + "\n"); } catch {} }
const asList = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
function globToRe(glob) {
  return new RegExp("^" + glob.split(/(\*\*\/?|\*|\?)/).map((p) => p === "**/" ? "(?:.*/)?" : p === "**" ? ".*" : p === "*" ? "[^/]*" : p === "?" ? "[^/]" : p.replace(/[.+^${}()|[\]\\]/g, "\\$&")).join("") + "$");
}
function inGroup(rel, g) {
  const dirs = asList(g.dirs).map((d) => d.replace(/\/+$/, "") + "/");
  const files = asList(g.files);
  const exts = asList(g.extensions);
  const excluded = asList(g.exclude).some((x) => globToRe(x).test(rel));
  if (excluded) return false;
  if (files.includes(rel)) return true;
  return dirs.some((d) => rel.startsWith(d)) && (exts.length === 0 || exts.some((e) => rel.endsWith(e)));
}
function specIds(specPath) {
  const ids = new Map();
  if (!fs.existsSync(specPath)) return ids;
  let cur = null;
  for (const raw of fs.readFileSync(specPath, "utf8").split(/\r?\n/)) {
    const m = raw.match(/^\s+-\s+id:\s*"?((?:REQ|UC)-\d{3})"?/);
    if (m) { cur = m[1]; ids.set(cur, "active"); continue; }
    const st = raw.match(/^\s+status:\s*"?(\w+)"?/);
    if (st && cur) ids.set(cur, st[1]);
  }
  return ids;
}

function main() {
  const raw = readStdin();
  let input = {};
  try { input = raw.trim() ? JSON.parse(raw) : {}; } catch { return 0; }
  if (!["Write", "Edit", "NotebookEdit"].includes(input.tool_name ?? "")) return 0;
  const root = input.cwd ?? process.cwd();
  const cfgPath = path.join(root, "traceconfig.json");
  if (!fs.existsSync(cfgPath)) return 0;
  const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  // 原本 harness の PJ（apm.yml か .harness/ があり、traceconfig にこの門のスキーマ spec_document が無い）は自前の gate-hook を持つので何もしない。印だけでは skip しない
  if ((fs.existsSync(path.join(root, "apm.yml")) || fs.existsSync(path.join(root, ".harness"))) && !cfg.spec_document) return 0;
  const target = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
  if (!target) return 0;
  const rel = path.relative(root, path.resolve(root, target)).split(path.sep).join("/");
  if (rel.startsWith("..")) return 0; // プロジェクトの外
  const stateDir = path.join(root, ".trace-gate");
  const spec = cfg.spec ?? "docs/spec.yaml";
  // 門の前提を書く操作は止めない
  // 宣言そのものを Write/Edit で置くのは止める（親が Bash で置く。Bash を持たない担当が自分で宣言して門を迂回した事例）
  if (rel === ".trace-gate/work.json") { console.error("[write-gate] .trace-gate/work.json は担当が置くものではありません（門の迂回）。宣言は親が作業単位ごとに置き、終わったら消す。要件を変える作業なら先に spec を書き換える"); log(stateDir, { decision: "block", reason: "declaration-by-tool", file: rel }); return 2; }
  if (rel === spec || rel === "traceconfig.json" || rel === (cfg.ignore ?? "scripts/trace_ignore") || rel.startsWith(".trace-gate/") || rel.startsWith("docs/")) return 0;
  const gated = [...asList(cfg.source), ...asList(cfg.tests)].some((g) => inGroup(rel, g));
  if (!gated) return 0;

  // 1) 要件の書き直しが先に行われているか（spec.yaml に未コミットの差分）
  const diff = spawnSync("git", ["status", "--porcelain", "--", spec], { cwd: root, encoding: "utf8" });
  const specChanged = (diff.stdout ?? "").trim().length > 0;
  if (specChanged) { log(stateDir, { decision: "pass", reason: "spec-changed", file: rel }); return 0; }

  // 2) 要件を変えない作業の宣言（対象の REQ を名指し）
  const workPath = path.join(stateDir, "work.json");
  if (fs.existsSync(workPath)) {
    try {
      const work = JSON.parse(fs.readFileSync(workPath, "utf8"));
      const ids = specIds(path.join(root, spec));
      const reqs = asList(work.reqs);
      const bad = reqs.filter((r) => !ids.has(r) || ids.get(r) === "withdrawn");
      if (reqs.length && bad.length === 0) { log(stateDir, { decision: "pass", reason: "declared", file: rel, reqs }); return 0; }
      console.error(`[write-gate] .trace-gate/work.json の reqs が spec.yaml に無い（または withdrawn）: ${bad.join(", ") || "(空)"}`);
      log(stateDir, { decision: "block", reason: "bad-declaration", file: rel, bad });
      return 2;
    } catch (e) {
      console.error(`[write-gate] .trace-gate/work.json が読めない: ${e.message}`);
      return 2;
    }
  }
  console.error(
    `[write-gate] ${rel} への書き込みを止めました。仕様書 → ユースケース → 要件 を書き直してから製造・テスト設計を始めます。\n` +
    `  1) 要求が挙動を変える／足すなら、先に ユースケース（docs/usecases/UC-xxx.md）の流れを書き直し、${spec} の要件（usecase・step 付き。新規は status: draft。次の番号は bash scripts/trace_check --next req）を書き換える。${spec} に差分があれば通ります\n` +
    `  2) 要件は正しく実装だけを直す（バグ修正・整理）なら、.trace-gate/work.json に {"reqs": ["REQ-xxx"], "kind": "bugfix", "note": "何を直すか"} を書いて対象の要件を宣言する（存在する ID だけ通ります）\n` +
    `  どちらも無い書き込みは「要件に無いコード」なので誤りです（本人の決定 2026-09-29）`,
  );
  log(stateDir, { decision: "block", reason: "no-spec-change", file: rel });
  return 2;
}

try { process.exit(main()); } catch (e) { console.log(`[write-gate] 内部エラー（通す）: ${e.message}`); process.exit(0); }
