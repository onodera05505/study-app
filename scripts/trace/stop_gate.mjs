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
// commands.system（遅い層。E2E など）は Stop では回さない。pre-push／CI が回す（.githooks の型を参照）。無いなら遅い層は無い
// 記録: <root>/.trace-gate/log.jsonl（判定 1 行）と state.json（最終合格の指紋・回数）。.gitignore に .trace-gate/ を足す
export const VERSION = "1.5.0";

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

/** 原本 harness の PJ か。印（apm.yml か .harness/）があり、かつ traceconfig がこの門のスキーマ（spec_document）を持たないとき true。 */
export function isHarnessProject(root, cfg) {
  const marked = fs.existsSync(path.join(root, "apm.yml")) || fs.existsSync(path.join(root, ".harness"));
  return marked && !cfg.spec_document;
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
  // 原本 harness（tsay-dev/harness）を入れた PJ は同名の traceconfig.json を別のスキーマで持ち、門も自前（gate-hook／stop-gate）。
  // 二重に走って旧スキーマを誤読しないよう、harness の印（apm.yml か .harness/）があり、かつこの門のスキーマ（spec_document）が無いときだけ何もしない。
  // 印だけでは skip しない（brain の型を入れた PJ に apm.yml を置いても門は外れない）
  if (isHarnessProject(root, cfg)) { console.log("[stop-gate] 原本 harness の PJ（apm.yml／.harness/ があり traceconfig に spec_document が無い）。この門は何もしない"); return 0; }
  const stateDir = path.join(root, ".trace-gate");
  // 複製が古いままでないか（正本 ~/.claude/brain/tools/trace/ の VERSION と比べる。正本が無い環境＝CI では見ない）
  try {
    const central = path.join(process.env.HOME ?? "", ".claude", "brain", "tools", "trace");
    if (fs.existsSync(central)) {
      const ver = (f) => (fs.readFileSync(f, "utf8").match(/export const VERSION = "([^"]+)"/) ?? [])[1] ?? "0";
      const cmpVer = (a, b) => { const x = a.split(".").map(Number), y = b.split(".").map(Number); for (let i = 0; i < 3; i++) { if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0) ? -1 : 1; } return 0; };
      const older = (a, b) => cmpVer(a, b) < 0;
      const stale = ["trace_check.mjs", "stop_gate.mjs", "write_gate.mjs"].filter((n) => fs.existsSync(path.join(root, "scripts", "trace", n)) && older(ver(path.join(root, "scripts", "trace", n)), ver(path.join(central, n))));
      if (stale.length) {
        console.error(`[stop-gate] 複製が正本より古い: ${stale.join(", ")}（cp ~/.claude/brain/tools/trace/{${stale.join(",")}} scripts/trace/ で更新する。検査の条件が古いまま通っている恐れ）`);
        log(stateDir, { decision: "block", reason: "stale-copy", stale });
        return 2;
      }
    }
  } catch {}
  // 書き込みの宣言（.trace-gate/work.json）が残ったまま終わらない: 宣言は作業単位ごとに親が置き、終わったら消す（残ると以後の書き込みが素通りする）
  if (fs.existsSync(path.join(stateDir, "work.json"))) {
    console.error(`[stop-gate] .trace-gate/work.json（書き込みの宣言）が残っています。作業単位が終わったら消してください（残すと以後の src/tests への書き込みが宣言なしで通る）。宣言は親だけが書く`);
    log(stateDir, { decision: "block", reason: "work-declaration-left" });
    return 2;
  }
  const cmd = cfg.commands?.test;
  if (!cmd) { console.log("[stop-gate] traceconfig.json の commands.test が未宣言。検査は行われていない"); log(stateDir, { decision: "skip", reason: "no-command" }); return 0; }
  // 緩和の検知: commands.test から trace_check が外れていたら止める（導入中の「一時緩和」がそのまま残るのを防ぐ。本人の許可があるなら relax_until: "YYYY-MM-DD" を traceconfig.json に書く）
  // npm test / pnpm test / yarn test のときは package.json の scripts.test まで辿って見る
  let effective = cmd;
  const viaPkg = cmd.match(/^\s*(?:npm|pnpm|yarn)\s+(?:run\s+)?test\b/);
  if (viaPkg) { try { effective += " " + (JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).scripts?.test ?? ""); } catch {} }
  if (!/trace_check/.test(effective)) {
    const until = cfg.relax_until ? new Date(cfg.relax_until) : null;
    const today = new Date().toISOString().slice(0, 10);
    if (!until || Number.isNaN(until.getTime()) || today > cfg.relax_until) {
      console.error(`[stop-gate] traceconfig.json の commands.test に trace_check が含まれていません（門が緩和されたまま）。"node scripts/trace/trace_check.mjs && <単体テスト>" に戻してください。本人が期限つきで緩和を許可したときだけ、traceconfig.json に "relax_until": "YYYY-MM-DD" を書く（期限を過ぎると止まる）`);
      log(stateDir, { decision: "block", reason: "relaxed-gate", cmd });
      return 2;
    }
    console.log(`[stop-gate] 門の緩和中（本人許可。期限 ${cfg.relax_until}）: ${cmd}`);
  }

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
