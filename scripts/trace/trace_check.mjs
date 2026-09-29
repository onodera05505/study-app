#!/usr/bin/env node
// trace_check — 仕様（docs/spec.yaml）⇔ コード（@implements）⇔ テスト（@verifies）の対応を機械で見る。
// 依存ゼロ（Node だけ）。正本は ~/.claude/brain/tools/trace/、各プロジェクトには複製が置かれる（版は下の VERSION）。
//
//   node trace_check.mjs [--root DIR] [--config traceconfig.json]   # 検査。1 件でも NG なら exit 1
//   node trace_check.mjs --index                                    # REQ ごとの実装・テストの所在（1 行 1 ID）
//   node trace_check.mjs --next req [--reserve N]                    # 次の空き ID（uc|req）。振った ID は再利用しない
//
// 見るもの（traceconfig.json の source / tests に掛かる）:
//   S1 spec.yaml の形: ID が UC-xxx / REQ-xxx の 3 桁、重複なし、status は draft|active|withdrawn、goal/description/acceptance が空でない
//   S2 要件がどの UC にも紐づかない／存在しない UC を参照している
//   S3 要件を 1 つも持たない UC
//   C1 active な要件に @implements が 1 つも無い
//   C2 active な要件に @verifies が 1 つも無い
//   C3 コードやテストが spec.yaml に無い ID、または withdrawn の ID を参照している
//   C4 公開関数・クラス・ルートに @implements が無い（source.public_patterns。除外は trace_ignore に理由つき）
//   C5 テストに @verifies が無い（tests.test_pattern。除外は trace_ignore に理由つき）
//   C6 trace_ignore の行に理由が無い／指す先が実在しない
// 失敗の行は [NG] で始め、AI がそのまま直せる具体さで書く。最後に「全N件の要件のうち、実装済みX件・テスト済みY件」。
export const VERSION = "1.0.0";

import fs from "node:fs";
import path from "node:path";

// ------------------------------------------------------------------ 引数
const argv = process.argv.slice(2);
const opt = { root: process.cwd(), config: "traceconfig.json", index: false, next: null, reserve: 1, quiet: false };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--root") opt.root = path.resolve(argv[++i]);
  else if (a === "--config") opt.config = argv[++i];
  else if (a === "--index") opt.index = true;
  else if (a === "--next") opt.next = argv[++i];
  else if (a === "--reserve") opt.reserve = Number(argv[++i]);
  else if (a === "--quiet") opt.quiet = true;
  else if (a === "--help" || a === "-h") { usage(); process.exit(0); }
  else { console.error(`不明な引数: ${a}`); usage(); process.exit(2); }
}
function usage() {
  console.error("usage: node trace_check.mjs [--root DIR] [--config traceconfig.json] [--index] [--next uc|req [--reserve N]]");
}

// ------------------------------------------------------------------ 設定
const configPath = path.resolve(opt.root, opt.config);
if (!fs.existsSync(configPath)) {
  console.error(`[NG] 設定が無い: ${path.relative(opt.root, configPath)}（テンプレートは ~/.claude/brain/tools/trace/traceconfig.template.json）`);
  process.exit(2);
}
const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
const specPath = path.resolve(opt.root, cfg.spec ?? "docs/spec.yaml");
const ignorePath = path.resolve(opt.root, cfg.ignore ?? "scripts/trace_ignore");
const idRe = { uc: /^UC-\d{3}$/, req: /^REQ-\d{3}$/ };
const implementsRe = new RegExp(cfg.implements_pattern ?? "@implements\\s+(REQ-\\d{3}(?:\\s*[,/]\\s*REQ-\\d{3})*)", "g");
const verifiesRe = new RegExp(cfg.verifies_pattern ?? "@verifies\\s+(REQ-\\d{3}(?:\\s*[,/]\\s*REQ-\\d{3})*)", "g");
const anyIdRe = /\b(?:REQ|UC)-\d{3}\b/g;
const STATUSES = new Set(["draft", "active", "withdrawn"]);
const asList = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
const rel = (p) => path.relative(opt.root, p).split(path.sep).join("/");

// ------------------------------------------------------------------ spec.yaml の読み取り（決めた形だけを読む手書きパーサ）
// 形: トップに `usecases:` と `requirements:`。項目は `- id: …` で始まり、`key: value` が続く。
// 値は "…" か '…' で囲むか素の文字列。`usecases: [UC-001, UC-002]` の行内リストだけを許す。
// `#` から行末はコメント（引用符の中は除く）。
function parseSpec(text, problems) {
  const uc = [], req = [];
  let section = null, cur = null;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = stripComment(raw);
    if (!line.trim()) continue;
    const indent = line.match(/^\s*/)[0].length;
    const t = line.trim();
    if (indent === 0) {
      cur = null;
      if (t === "usecases:") section = uc;
      else if (t === "requirements:") section = req;
      else { problems.push(`[NG] ${rel(specPath)}:${i + 1} 知らないトップの節: ${t}（usecases / requirements だけ）`); section = null; }
      continue;
    }
    if (!section) { problems.push(`[NG] ${rel(specPath)}:${i + 1} 節の外に行がある: ${t}`); continue; }
    if (t.startsWith("- ")) {
      cur = { _line: i + 1 };
      section.push(cur);
      assign(cur, t.slice(2), i + 1, problems);
      continue;
    }
    if (!cur) { problems.push(`[NG] ${rel(specPath)}:${i + 1} 項目（- id: …）の外に行がある: ${t}`); continue; }
    assign(cur, t, i + 1, problems);
  }
  return { uc, req };

  function assign(obj, kv, lineNo, problems) {
    const m = kv.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (!m) { problems.push(`[NG] ${rel(specPath)}:${lineNo} key: value の形でない: ${kv}`); return; }
    const key = m[1]; let val = m[2].trim();
    if (val.startsWith("[")) {
      if (!val.endsWith("]")) { problems.push(`[NG] ${rel(specPath)}:${lineNo} 行内リストが閉じていない: ${kv}`); return; }
      obj[key] = val.slice(1, -1).split(",").map((s) => unquote(s.trim())).filter(Boolean);
      return;
    }
    obj[key] = unquote(val);
  }
}
function stripComment(line) {
  let q = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === q) q = null; continue; }
    if (c === '"' || c === "'") q = c;
    else if (c === "#" && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i);
  }
  return line;
}
function unquote(s) {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return s.slice(1, -1);
  return s;
}

// ------------------------------------------------------------------ ファイル走査
function walk(dir, exts, exclude, out) {
  if (!fs.existsSync(dir)) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    const r = rel(p);
    if (ent.name === "node_modules" || ent.name === ".git" || ent.name === "dist") continue;
    if (exclude.some((g) => globMatch(g, r))) continue;
    if (ent.isDirectory()) walk(p, exts, exclude, out);
    else if (exts.some((e) => ent.name.endsWith(e))) out.push(p);
  }
  return out;
}
function globMatch(glob, p) {
  // 最小の glob: ** / * / ? だけ。プロジェクト相対のパスに当てる
  const re = "^" + glob.split(/(\*\*\/?|\*|\?)/).map((part) => {
    if (part === "**/" ) return "(?:.*/)?";
    if (part === "**") return ".*";
    if (part === "*") return "[^/]*";
    if (part === "?") return "[^/]";
    return part.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }).join("") + "$";
  return new RegExp(re).test(p);
}
function groupFiles(group) {
  const files = [];
  for (const d of asList(group.dirs)) walk(path.resolve(opt.root, d), asList(group.extensions), asList(group.exclude), files);
  for (const f of asList(group.files)) { const p = path.resolve(opt.root, f); if (fs.existsSync(p)) files.push(p); }
  return [...new Set(files)];
}
const COMMENT_LINE = /^\s*(\/\/|\/\*|\*|#|"""|''')/;
const CLOSE_COMMENT = /\*\/\s*$/;
/** 単位（関数・テスト）の直前の注釈窓: 上へ空行とコメント行を辿り、その中の注釈を集める。同じ行の末尾コメントも見る。 */
function tagsAbove(lines, idx, re, lookback) {
  const found = [];
  const scan = (s) => { re.lastIndex = 0; let m; while ((m = re.exec(s))) found.push(...splitIds(m[1])); };
  scan(lines[idx].replace(/^.*?(\/\/|#)/, (x, c) => c)); // 同じ行の末尾コメントだけ（本体の文字列は見ない）
  let j = idx - 1, n = 0;
  while (j >= 0 && n < lookback) {
    const l = lines[j];
    if (!l.trim()) { j--; continue; }
    if (COMMENT_LINE.test(l) || CLOSE_COMMENT.test(l)) { scan(l); j--; n++; continue; }
    break;
  }
  return found;
}
function splitIds(s) { return s.split(/\s*[,/]\s*/).map((x) => x.trim()).filter(Boolean); }

// ------------------------------------------------------------------ trace_ignore
// 1 行 1 件: `<パス>` か `<パス>::<名前>`、その後に ` — 理由`。# はコメント。理由が無い行は NG。
function loadIgnore(problems) {
  const entries = [];
  if (!fs.existsSync(ignorePath)) return entries;
  fs.readFileSync(ignorePath, "utf8").split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    const m = line.match(/^(\S+?)(?:::(\S+))?\s+—\s+(.+)$/);
    if (!m) { problems.push(`[NG] ${rel(ignorePath)}:${i + 1} 形が違う（「<パス>[::<名前>] — 理由」。理由は必須）: ${line}`); return; }
    const target = path.resolve(opt.root, m[1]);
    if (!fs.existsSync(target)) problems.push(`[NG] ${rel(ignorePath)}:${i + 1} 指す先が無い: ${m[1]}`);
    entries.push({ file: m[1], name: m[2] ?? null, reason: m[3], line: i + 1, used: false });
  });
  return entries;
}
function ignored(entries, file, name) {
  for (const e of entries) {
    if (e.file !== file) continue;
    if (e.name == null || e.name === name) { e.used = true; return true; }
  }
  return false;
}

// ------------------------------------------------------------------ 本体
function main() {
  const problems = [];
  if (!fs.existsSync(specPath)) { console.error(`[NG] 仕様ファイルが無い: ${rel(specPath)}`); return 1; }
  const spec = parseSpec(fs.readFileSync(specPath, "utf8"), problems);

  // S1 形
  const ucIds = new Map(), reqIds = new Map();
  for (const u of spec.uc) {
    if (!idRe.uc.test(u.id ?? "")) problems.push(`[NG] ${rel(specPath)}:${u._line} UC の id が UC-xxx（3 桁）でない: ${u.id}`);
    else if (ucIds.has(u.id)) problems.push(`[NG] ${rel(specPath)}:${u._line} ${u.id} が重複している（一度振った ID は再利用しない）`);
    else ucIds.set(u.id, u);
    if (!u.goal) problems.push(`[NG] ${rel(specPath)}:${u._line} ${u.id}: goal が空`);
    u.status = u.status ?? "active";
    if (!STATUSES.has(u.status)) problems.push(`[NG] ${rel(specPath)}:${u._line} ${u.id}: status は draft|active|withdrawn（今: ${u.status}）`);
  }
  for (const r of spec.req) {
    if (!idRe.req.test(r.id ?? "")) problems.push(`[NG] ${rel(specPath)}:${r._line} REQ の id が REQ-xxx（3 桁）でない: ${r.id}`);
    else if (reqIds.has(r.id)) { problems.push(`[NG] ${rel(specPath)}:${r._line} ${r.id} が重複している（一度振った ID は再利用しない）`); r._dup = true; }
    else reqIds.set(r.id, r);
    if (!r.description) problems.push(`[NG] ${rel(specPath)}:${r._line} ${r.id}: description が空`);
    if (!r.acceptance) problems.push(`[NG] ${rel(specPath)}:${r._line} ${r.id}: acceptance が空`);
    r.status = r.status ?? "active";
    if (!STATUSES.has(r.status)) problems.push(`[NG] ${rel(specPath)}:${r._line} ${r.id}: status は draft|active|withdrawn（今: ${r.status}）`);
    r.usecases = asList(r.usecases);
  }
  // S2 / S3
  const ucUsed = new Map([...ucIds.keys()].map((k) => [k, 0]));
  for (const r of spec.req) {
    if (r.usecases.length === 0) problems.push(`[NG] ${r.id}: どの UC にも紐づいていません（usecases: [UC-xxx] を書く）`);
    for (const u of r.usecases) {
      if (!ucIds.has(u)) problems.push(`[NG] ${r.id}: 存在しない UC を参照しています（${u}）`);
      else if (r.status !== "withdrawn") ucUsed.set(u, ucUsed.get(u) + 1);
    }
  }
  for (const [u, n] of ucUsed) if (n === 0 && ucIds.get(u).status !== "withdrawn") problems.push(`[NG] ${u}: 要件を 1 つも持ちません（REQ の usecases に ${u} を足すか、UC を withdrawn にする）`);

  // 走査
  const ignore = loadIgnore(problems);
  const impl = new Map(), veri = new Map(); // REQ → [{file,line,name}]
  const refs = []; // すべての ID 参照（C3 用）
  const addRef = (map, id, where) => { if (!map.has(id)) map.set(id, []); map.get(id).push(where); };

  for (const g of asList(cfg.source)) {
    const publics = asList(g.public_patterns).map((p) => ({ re: new RegExp(p.pattern), kind: p.kind ?? "unit" }));
    const lookback = g.tag_lookback ?? 6;
    for (const f of groupFiles(g)) {
      const lines = fs.readFileSync(f, "utf8").split(/\r?\n/);
      lines.forEach((l, i) => {
        implementsRe.lastIndex = 0; let m;
        while ((m = implementsRe.exec(l))) for (const id of splitIds(m[1])) { addRef(impl, id, { file: rel(f), line: i + 1 }); refs.push({ id, file: rel(f), line: i + 1, tag: "@implements" }); }
        for (const p of publics) {
          const pm = l.match(p.re);
          if (!pm) continue;
          const name = pm[1] ?? l.trim();
          if (tagsAbove(lines, i, implementsRe, lookback).length === 0 && !ignored(ignore, rel(f), name))
            problems.push(`[NG] ${rel(f)}:${i + 1} ${name}${p.kind === "route" ? "" : "()"}: @implements タグがありません（実現する REQ-xxx を直前のコメントに書く。対象外なら ${rel(ignorePath)} に理由つきで）`);
        }
      });
    }
  }
  for (const g of asList(cfg.tests)) {
    const testRe = g.test_pattern ? new RegExp(g.test_pattern) : null;
    const lookback = g.tag_lookback ?? 6;
    for (const f of groupFiles(g)) {
      const lines = fs.readFileSync(f, "utf8").split(/\r?\n/);
      lines.forEach((l, i) => {
        verifiesRe.lastIndex = 0; let m;
        while ((m = verifiesRe.exec(l))) for (const id of splitIds(m[1])) { addRef(veri, id, { file: rel(f), line: i + 1 }); refs.push({ id, file: rel(f), line: i + 1, tag: "@verifies" }); }
        if (testRe) {
          const tm = l.match(testRe);
          if (tm) {
            const name = tm[1] ?? l.trim();
            if (tagsAbove(lines, i, verifiesRe, lookback).length === 0 && !ignored(ignore, rel(f), name))
              problems.push(`[NG] ${rel(f)}:${i + 1} テスト「${name}」に @verifies タグがありません（確かめる REQ-xxx を直前のコメントに書く）`);
          }
        }
      });
    }
  }

  // C3 参照先の実在
  for (const x of refs) {
    const r = reqIds.get(x.id);
    if (!r) problems.push(`[NG] ${x.file}:${x.line} が存在しない ID ${x.id} を参照しています（${x.tag}）`);
    else if (r.status === "withdrawn") problems.push(`[NG] ${x.file}:${x.line} が withdrawn の ${x.id} を参照しています（タグを外すか要件を戻す）`);
  }
  // C1 / C2（active だけ）
  let implemented = 0, tested = 0, active = 0;
  for (const r of spec.req) {
    if (r.status !== "active" || r._dup) continue;
    active++;
    const hasI = impl.has(r.id), hasV = veri.has(r.id);
    if (hasI) implemented++; else problems.push(`[NG] ${r.id}: 実装がありません（@implements ${r.id} が見つかりません）: ${r.description}`);
    if (hasV) tested++; else problems.push(`[NG] ${r.id}: テストがありません（@verifies ${r.id} が見つかりません）: ${r.acceptance}`);
  }
  // C6 使われていない ignore
  for (const e of ignore) if (!e.used) problems.push(`[NG] ${rel(ignorePath)}:${e.line} 使われていない除外（指す先にタグが付いたか名前が変わった）: ${e.file}${e.name ? "::" + e.name : ""}`);

  if (opt.index) {
    for (const r of spec.req) {
      const I = (impl.get(r.id) ?? []).map((w) => `${w.file}:${w.line}`).join(" ") || "-";
      const V = (veri.get(r.id) ?? []).map((w) => `${w.file}:${w.line}`).join(" ") || "-";
      console.log(`${r.id}\t${r.status}\t${r.usecases.join(",")}\timpl: ${I}\ttest: ${V}`);
    }
    return 0;
  }
  const uniq = [...new Set(problems)];
  for (const p of uniq) console.log(p);
  const drafts = spec.req.filter((r) => r.status === "draft").length, withdrawn = spec.req.filter((r) => r.status === "withdrawn").length;
  console.log(`全${active}件の要件のうち、実装済み${implemented}件・テスト済み${tested}件（UC ${ucIds.size}、draft ${drafts}、withdrawn ${withdrawn}）${uniq.length ? `。NG ${uniq.length} 件` : "。問題なし"}`);
  return uniq.length ? 1 : 0;
}

function nextId(kind) {
  const problems = [];
  const spec = fs.existsSync(specPath) ? parseSpec(fs.readFileSync(specPath, "utf8"), problems) : { uc: [], req: [] };
  const prefix = kind === "uc" ? "UC" : "REQ";
  const items = kind === "uc" ? spec.uc : spec.req;
  const resPath = path.resolve(opt.root, ".trace-reservations.json");
  const res = fs.existsSync(resPath) ? JSON.parse(fs.readFileSync(resPath, "utf8")) : {};
  const nums = [...items.map((x) => x.id), ...(res[prefix] ?? [])].map((id) => Number(String(id).split("-")[1])).filter((n) => !Number.isNaN(n));
  let max = nums.length ? Math.max(...nums) : 0;
  const out = [];
  for (let i = 0; i < opt.reserve; i++) { max++; out.push(`${prefix}-${String(max).padStart(3, "0")}`); }
  res[prefix] = [...(res[prefix] ?? []), ...out];
  fs.writeFileSync(resPath, JSON.stringify(res, null, 2) + "\n");
  for (const id of out) console.log(id);
  return 0;
}

if (opt.next) {
  if (!["uc", "req"].includes(opt.next)) { console.error("--next は uc か req"); process.exit(2); }
  process.exit(nextId(opt.next));
}
process.exit(main());
