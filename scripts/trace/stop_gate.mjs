#!/usr/bin/env node
// stop_gate — Claude Code の Stop フック。作業ディレクトリに traceconfig.json があれば commands.test を回し、
// 落ちたら exit 2 で停止を止め、失敗の末尾を stderr で Claude に返す（続けて直させる）。
// 正本は ~/.claude/brain/tools/trace/。ユーザー設定（~/.claude/settings.json）の Stop に 1 本置けば全プロジェクトに効く。
//
//   {"hooks": {"Stop": [{"type": "command", "command": "node \"$HOME/.claude/brain/tools/trace/stop_gate.mjs\"", "timeout": 900}]}}
//
// 通す（exit 0）: traceconfig.json が無い／Stop 以外のイベント／木が前回の合格から変わっていない／
//               連続で --max-rounds 回止めても失敗が減らない（人に返す）／フック自身の内部エラー（壊れたフックでセッションを止めない）
// 止める（exit 2）: commands.test が 0 以外か timeout
// 記録: <root>/.trace-gate/log.jsonl（判定 1 行）と state.json（最終合格の指紋・回数）。.gitignore に .trace-gate/ を足す
export const VERSION = "1.0.0";

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const opt = { maxRounds: 2, timeout: 600, tail: 25, force: false };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--max-rounds") opt.maxRounds = Number(args[++i]);
  else if (a === "--timeout") opt.timeout = Number(args[++i]);
  else if (a === "--tail") opt.tail = Number(args[++i]);
  else if (a === "--force") opt.force = true;
  else { console.error(`stop_gate: 不明な引数 ${a}`); process.exit(2); }
}

function readStdin() {
  try { return fs.readFileSync(0, "utf8"); } catch { return ""; }
}
function log(dir, entry) {
  try { fs.mkdirSync(dir, { recursive: true }); fs.appendFileSync(path.join(dir, "log.jsonl"), JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n"); } catch {}
}
function fingerprint(root) {
  const git = (a) => spawnSync("git", a, { cwd: root, encoding: "utf8" }).stdout ?? "";
  const h = crypto.createHash("sha1");
  h.update(git(["rev-parse", "HEAD"]));
  h.update(git(["status", "--porcelain"]).split("\n").filter((l) => !l.includes(".trace-gate/")).join("\n"));
  h.update(git(["diff", "HEAD", "--", ".", ":(exclude).trace-gate"]));
  return h.digest("hex");
}

function main() {
  const raw = readStdin();
  let input = {};
  try { input = raw.trim() ? JSON.parse(raw) : {}; } catch { console.log("[stop-gate] stdin が JSON でない。通す"); return 0; }
  if (input.hook_event_name && input.hook_event_name !== "Stop") return 0;
  const root = input.cwd ?? process.cwd();
  const cfgPath = path.join(root, "traceconfig.json");
  if (!fs.existsSync(cfgPath)) return 0; // この仕組みを入れていないプロジェクト。何もしない
  const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  const cmd = cfg.commands?.test;
  const stateDir = path.join(root, ".trace-gate");
  if (!cmd) { console.log("[stop-gate] traceconfig.json の commands.test が未宣言。検査は行われていない"); log(stateDir, { decision: "skip", reason: "no-command" }); return 0; }

  let state = {};
  try { state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8")); } catch {}
  const session = input.session_id ?? "?";
  if (state.session !== session) state = { session, rounds: 0, lastFailures: null, lastPass: state.lastPass ?? null };

  const fp = fingerprint(root);
  if (!opt.force && state.lastPass && state.lastPass.fingerprint === fp) {
    console.log(`[stop-gate] 変更なし（最終合格 ${state.lastPass.ts}）。通す`);
    log(stateDir, { decision: "pass", reason: "unchanged", session });
    return 0;
  }

  const t0 = Date.now();
  const r = spawnSync("bash", ["-lc", cmd], { cwd: root, encoding: "utf8", timeout: opt.timeout * 1000, maxBuffer: 64 * 1024 * 1024 });
  const out = (r.stdout ?? "") + (r.stderr ?? "");
  const timedOut = r.error && r.error.code === "ETIMEDOUT";
  const ok = !timedOut && r.status === 0;
  const secs = ((Date.now() - t0) / 1000).toFixed(1);

  if (ok) {
    state.rounds = 0; state.lastFailures = null; state.lastPass = { fingerprint: fp, ts: new Date().toISOString() };
    save(stateDir, state);
    console.log(`[stop-gate] ${cmd} → 合格（${secs} 秒）`);
    log(stateDir, { decision: "pass", reason: "green", session, secs });
    return 0;
  }

  const lines = out.split("\n").filter((l) => l.trim());
  const failures = lines.filter((l) => l.startsWith("[NG]") || /FAIL|✘|Error|error/.test(l));
  const failKey = failures.slice(0, 200).join("\n");
  const shrank = state.lastFailures == null || failures.length < state.lastFailures.length;
  state.rounds = (state.rounds ?? 0) + 1;
  const stuck = state.lastFailures != null && !shrank && state.rounds >= 2;
  state.lastFailures = failures;
  save(stateDir, state);

  if (input.stop_hook_active && (state.rounds > opt.maxRounds || stuck)) {
    console.log(`[stop-gate] 非収束: ${state.rounds} 回止めても失敗が減らない。人に返す（残り ${failures.length} 件）`);
    log(stateDir, { decision: "release", reason: stuck ? "non-decreasing" : "max-rounds", session, failures: failures.length });
    state.rounds = 0; save(stateDir, state);
    return 0;
  }
  const tail = lines.slice(-opt.tail).join("\n");
  console.error(`[stop-gate] ${timedOut ? `timeout ${opt.timeout} 秒` : `exit ${r.status}`}: ${cmd}\n作業完了の条件は「${cmd} が全部通ること」です。次の失敗を直してから終えてください（${failures.length} 件）。\n${tail}`);
  log(stateDir, { decision: "block", reason: timedOut ? "timeout" : "red", session, failures: failures.length, secs });
  return 2;
}
function save(dir, state) { try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify(state, null, 2)); } catch {} }

try { process.exit(main()); } catch (e) { console.log(`[stop-gate] 内部エラー（通す）: ${e.message}`); process.exit(0); }
