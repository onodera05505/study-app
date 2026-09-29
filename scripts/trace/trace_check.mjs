#!/usr/bin/env node
// trace_check — 仕様書 ⇔ ユースケース ⇔ 要件 ⇔ コード ⇔ テスト の対応を機械で見る。
// 依存ゼロ（Node だけ）。正本は ~/.claude/brain/tools/trace/、各プロジェクトには複製が置かれる（版は下の VERSION）。
//
//   node trace_check.mjs [--root DIR] [--config traceconfig.json]   # 検査。1 件でも NG なら exit 1
//   node trace_check.mjs --index                                    # REQ ごとの UC/ステップ・実装・テストの所在（1 行 1 ID）
//   node trace_check.mjs --next uc|req [--reserve N]                # 次の空き ID。振った ID は再利用しない
//
// 層（traceconfig.json）:
//   仕様書      spec_document.file の見出し（## 4. … / ### 5.1 …）。規範的な節を spec_document.sections に列挙
//   ユースケース usecases（ディレクトリ）の UC-xxx.md。frontmatter（id・title・status・actor・source=節）と
//               本文の「## 前提条件」「## 基本の流れ」（1. 2. …）「## 例外の流れ」（E1. E2. …）「## 事後条件」
//   要件        spec の requirements。各 REQ は usecase（1 つ）と step（基本の番号か E 番号）を持つ
//   コード      @implements REQ-xxx（単位の直前）。1 つの REQ を実装する単位は max_units_per_req 以下（既定 1）
//   テスト      @verifies REQ-xxx（テストケースの直前）
//
// 見るもの:
//   S1 形: ID が UC-xxx / REQ-xxx の 3 桁、重複なし、status は draft|active|withdrawn、必須の欄が空でない。UC の id はファイル名と一致
//   S2 要件が usecase を持たない／存在しない UC を参照している／step が UC に無い／withdrawn の UC に active な要件
//   S3 active な UC のステップ（基本・例外）に要件が 1 つも無い（draft の UC は見ない）
//   S4 UC の source（仕様書の節）が仕様書に実在しない
//   S5 spec_document.sections の節に UC が 1 つも無い（仕様書の決まりがユースケースに落ちていない）
//   C1 active な要件に @implements が 1 つも無い
//   C2 active な要件に @verifies が 1 つも無い
//   C3 コードやテストが spec に無い ID、または withdrawn の ID を参照している
//   C4 公開関数・クラス・ルートに @implements が無い（source.public_patterns。除外は trace_ignore に理由つき）
//   C5 テストに @verifies が無い（tests.test_pattern。除外は trace_ignore に理由つき）
//   C6 trace_ignore の行に理由が無い／指す先が実在しない／使われていない
//   C7 1 つの要件を実装する単位が max_units_per_req を超える（要件が粗い。ステップを分けて細分化する）
// 失敗の行は [NG] で始め、AI がそのまま直せる具体さで書く。最後に「全N件の要件のうち、実装済みX件・テスト済みY件」。
export const VERSION = "2.0.0";

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
const ucDir = path.resolve(opt.root, cfg.usecases ?? "docs/usecases");
const ignorePath = path.resolve(opt.root, cfg.ignore ?? "scripts/trace_ignore");
const maxUnits = Number(cfg.max_units_per_req ?? 1);
const idRe = { uc: /^UC-\d{3}$/, req: /^REQ-\d{3}$/ };
const stepRe = /^(?:\d+|E\d+)$/;
const implementsRe = new RegExp(cfg.implements_pattern ?? "@implements\\s+(REQ-\\d{3}(?:\\s*[,/]\\s*REQ-\\d{3})*)", "g");
const verifiesRe = new RegExp(cfg.verifies_pattern ?? "@verifies\\s+(REQ-\\d{3}(?:\\s*[,/]\\s*REQ-\\d{3})*)", "g");
const STATUSES = new Set(["draft", "active", "withdrawn"]);
const asList = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
const rel = (p) => path.relative(opt.root, p).split(path.sep).join("/");
const normSection = (s) => String(s).replace(/^§\s*/, "").replace(/\.$/, "").trim();

// ------------------------------------------------------------------ 共通: `key: value` 行の読み取り（決めた形だけを読む手書きパーサ）
// 値は "…" か '…' で囲むか素の文字列。`[a, b]` の行内リストだけを許す。`#` から行末はコメント（引用符の中は除く）。
function assign(obj, kv, where, problems) {
  const m = kv.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
  if (!m) { problems.push(`[NG] ${where} key: value の形でない: ${kv}`); return; }
  const key = m[1]; let val = m[2].trim();
  if (val.startsWith("[")) {
    if (!val.endsWith("]")) { problems.push(`[NG] ${where} 行内リストが閉じていない: ${kv}`); return; }
    obj[key] = val.slice(1, -1).split(",").map((s) => unquote(s.trim())).filter(Boolean);
    return;
  }
  obj[key] = unquote(val);
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

// ------------------------------------------------------------------ 要件（spec.yaml）: トップは `requirements:` だけ。項目は `- id: …` で始まる
function parseSpec(text, problems) {
  const req = [];
  let section = null, cur = null;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = stripComment(lines[i]);
    if (!line.trim()) continue;
    const indent = line.match(/^\s*/)[0].length;
    const t = line.trim();
    const where = `${rel(specPath)}:${i + 1}`;
    if (indent === 0) {
      cur = null;
      if (t === "requirements:") section = req;
      else if (t === "usecases:") { problems.push(`[NG] ${where} usecases: の節は廃止。ユースケースは ${rel(ucDir)}/UC-xxx.md の書類に書く（frontmatter と 基本の流れ／例外の流れ）`); section = null; }
      else { problems.push(`[NG] ${where} 知らないトップの節: ${t}（requirements だけ）`); section = null; }
      continue;
    }
    if (!section) { problems.push(`[NG] ${where} 節の外に行がある: ${t}`); continue; }
    if (t.startsWith("- ")) { cur = { _line: i + 1 }; section.push(cur); assign(cur, t.slice(2), where, problems); continue; }
    if (!cur) { problems.push(`[NG] ${where} 項目（- id: …）の外に行がある: ${t}`); continue; }
    assign(cur, t, where, problems);
  }
  return req;
}

// ------------------------------------------------------------------ ユースケース（docs/usecases/UC-xxx.md）
const UC_SECTIONS = ["前提条件", "基本の流れ", "例外の流れ", "事後条件"];
function parseUsecases(problems) {
  const list = [];
  if (!fs.existsSync(ucDir)) { problems.push(`[NG] ユースケースのディレクトリが無い: ${rel(ucDir)}（UC-xxx.md を置く。型は ~/.claude/brain/tools/trace/usecase.template.md）`); return list; }
  for (const name of fs.readdirSync(ucDir).sort()) {
    if (!name.endsWith(".md")) continue;
    const file = path.join(ucDir, name);
    const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
    const uc = { _file: rel(file), _name: name.replace(/\.md$/, ""), steps: new Map(), sections: new Set() };
    list.push(uc);
    let i = 0;
    if (lines[0]?.trim() !== "---") { problems.push(`[NG] ${uc._file}:1 先頭が frontmatter（---）でない`); continue; }
    for (i = 1; i < lines.length && lines[i].trim() !== "---"; i++) {
      const line = stripComment(lines[i]); if (!line.trim()) continue;
      assign(uc, line.trim(), `${uc._file}:${i + 1}`, problems);
    }
    if (i >= lines.length) { problems.push(`[NG] ${uc._file} frontmatter が閉じていない（--- が 1 つ）`); continue; }
    let cur = null;
    for (i = i + 1; i < lines.length; i++) {
      const l = lines[i];
      const h = l.match(/^##\s+(.+?)\s*$/);
      if (h) { cur = h[1]; uc.sections.add(cur); if (!UC_SECTIONS.includes(cur)) problems.push(`[NG] ${uc._file}:${i + 1} 知らない見出し「${cur}」（${UC_SECTIONS.join("／")} だけ）`); continue; }
      if (cur === "基本の流れ") {
        const m = l.match(/^(\d+)\.\s+(.+)$/);
        if (m) { const k = m[1]; if (uc.steps.has(k)) problems.push(`[NG] ${uc._file}:${i + 1} ステップ ${k} が重複`); uc.steps.set(k, { text: m[2], line: i + 1 }); }
        else if (l.trim() && !/^\s+/.test(l)) problems.push(`[NG] ${uc._file}:${i + 1} 基本の流れの行は「N. 文」の形（続きの行は字下げ）: ${l.trim()}`);
      } else if (cur === "例外の流れ") {
        const m = l.match(/^(E\d+)\.\s+(.+)$/);
        if (m) { const k = m[1]; if (uc.steps.has(k)) problems.push(`[NG] ${uc._file}:${i + 1} ステップ ${k} が重複`); uc.steps.set(k, { text: m[2], line: i + 1 }); }
        else if (l.trim() && !/^\s+/.test(l) && !/^-\s*(なし|無し)/.test(l.trim())) problems.push(`[NG] ${uc._file}:${i + 1} 例外の流れの行は「E1. 文」の形（無ければ「- なし」）: ${l.trim()}`);
      }
    }
  }
  return list;
}

// ------------------------------------------------------------------ 仕様書の節（見出し番号）
function specDocumentSections(problems) {
  const sd = cfg.spec_document;
  if (!sd || !sd.file) { problems.push(`[NG] traceconfig.json に spec_document.file（仕様書）が無い。UC の source が指す書類を登録する`); return { headings: new Set(), normative: [] }; }
  const file = path.resolve(opt.root, sd.file);
  if (!fs.existsSync(file)) { problems.push(`[NG] 仕様書が無い: ${sd.file}`); return { headings: new Set(), normative: [] }; }
  const headings = new Set();
  for (const l of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = l.match(/^#{1,6}\s+(\d+(?:\.\d+)*)\.?\s/);
    if (m) headings.add(m[1]);
  }
  const normative = asList(sd.sections).map(normSection);
  if (normative.length === 0) problems.push(`[NG] traceconfig.json の spec_document.sections が空（規範的な節の番号を列挙する。例 ["4", "5.1"]）`);
  for (const s of normative) if (!headings.has(s)) problems.push(`[NG] traceconfig.json の spec_document.sections に仕様書に無い節がある: §${s}（${sd.file} の見出し番号と合わせる）`);
  return { headings, normative, file: sd.file };
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
  const re = "^" + glob.split(/(\*\*\/?|\*|\?)/).map((part) => {
    if (part === "**/") return "(?:.*/)?";
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
  scan(lines[idx].replace(/^.*?(\/\/|#)/, (x, c) => c));
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
  const doc = specDocumentSections(problems);
  const ucs = parseUsecases(problems);
  const reqs = parseSpec(fs.readFileSync(specPath, "utf8"), problems);

  // S1 形（UC）
  const ucIds = new Map();
  for (const u of ucs) {
    const w = u._file;
    if (!idRe.uc.test(u.id ?? "")) problems.push(`[NG] ${w} frontmatter の id が UC-xxx（3 桁）でない: ${u.id}`);
    else if (u.id !== u._name) problems.push(`[NG] ${w} id（${u.id}）とファイル名（${u._name}.md）が違う`);
    else if (ucIds.has(u.id)) problems.push(`[NG] ${w} ${u.id} が重複している（一度振った ID は再利用しない）`);
    else ucIds.set(u.id, u);
    if (!u.title) problems.push(`[NG] ${w} ${u.id}: title が空（誰が何をできる、の 1 文）`);
    if (!u.actor) problems.push(`[NG] ${w} ${u.id}: actor が空（利用者／管理者／運用者 など）`);
    u.status = u.status ?? "active";
    if (!STATUSES.has(u.status)) problems.push(`[NG] ${w} ${u.id}: status は draft|active|withdrawn（今: ${u.status}）`);
    u.source = asList(u.source).map(normSection);
    if (u.source.length === 0) problems.push(`[NG] ${w} ${u.id}: source が空（仕様書の節番号。例 source: [4, 15]）`);
    for (const s of UC_SECTIONS) if (!u.sections.has(s)) problems.push(`[NG] ${w} ${u.id}: 見出し「## ${s}」が無い`);
    if (![...u.steps.keys()].some((k) => /^\d+$/.test(k)) && u.status !== "withdrawn") problems.push(`[NG] ${w} ${u.id}: 基本の流れにステップ（1. …）が 1 つも無い`);
    // S4
    for (const s of u.source) if (doc.headings.size && !doc.headings.has(s)) problems.push(`[NG] ${w} ${u.id}: source の節 §${s} が仕様書（${doc.file}）に無い（見出し番号と合わせるか、仕様書に節を書く）`);
  }
  // S5
  for (const s of doc.normative) {
    if (!doc.headings.has(s)) continue;
    if (!ucs.some((u) => u.source.includes(s) && u.status !== "withdrawn")) problems.push(`[NG] 仕様書 §${s} を source に持つユースケースが無い（節の決まりを UC に落とす。未実装なら status: draft の UC を書く）`);
  }

  // S1 形（REQ）・S2
  const reqIds = new Map();
  const stepUsed = new Map(); // "UC-xxx#step" → n
  for (const r of reqs) {
    const w = `${rel(specPath)}:${r._line}`;
    if (!idRe.req.test(r.id ?? "")) problems.push(`[NG] ${w} REQ の id が REQ-xxx（3 桁）でない: ${r.id}`);
    else if (reqIds.has(r.id)) { problems.push(`[NG] ${w} ${r.id} が重複している（一度振った ID は再利用しない）`); r._dup = true; }
    else reqIds.set(r.id, r);
    if (!r.description) problems.push(`[NG] ${w} ${r.id}: description が空`);
    if (!r.acceptance) problems.push(`[NG] ${w} ${r.id}: acceptance が空`);
    r.status = r.status ?? "active";
    if (!STATUSES.has(r.status)) problems.push(`[NG] ${w} ${r.id}: status は draft|active|withdrawn（今: ${r.status}）`);
    if (r.usecases !== undefined) problems.push(`[NG] ${w} ${r.id}: usecases（複数）は廃止。usecase: UC-xxx と step: n（基本の番号か E1）に書く。複数の UC に掛かるなら要件を分ける`);
    if (Array.isArray(r.usecase)) problems.push(`[NG] ${w} ${r.id}: usecase は 1 つ（リストにしない。複数の UC に掛かるなら要件を分ける）`);
    const uc = typeof r.usecase === "string" ? r.usecase : null;
    const step = r.step == null ? null : String(r.step);
    if (!uc) problems.push(`[NG] ${w} ${r.id}: usecase が無い（usecase: UC-xxx）`);
    else if (!ucIds.has(uc)) problems.push(`[NG] ${w} ${r.id}: 存在しない UC を参照している（${uc}）`);
    if (step == null) problems.push(`[NG] ${w} ${r.id}: step が無い（UC の基本の流れの番号か E 番号。1 要件 1 ステップ）`);
    else if (!stepRe.test(step)) problems.push(`[NG] ${w} ${r.id}: step は 数字 か E数字（今: ${step}）`);
    else if (uc && ucIds.has(uc)) {
      const u = ucIds.get(uc);
      if (!u.steps.has(step)) problems.push(`[NG] ${w} ${r.id}: ${uc} にステップ ${step} が無い（${u._file} の流れに書くか、step を直す）`);
      else {
        if (r.status !== "withdrawn") stepUsed.set(`${uc}#${step}`, (stepUsed.get(`${uc}#${step}`) ?? 0) + 1);
        if (u.status === "withdrawn" && r.status !== "withdrawn") problems.push(`[NG] ${w} ${r.id}: withdrawn の ${uc} に active/draft の要件がある`);
      }
    }
  }
  // S3
  for (const u of ucIds.values()) {
    if (u.status !== "active") continue;
    for (const [k, s] of u.steps) if (!stepUsed.get(`${u.id}#${k}`)) problems.push(`[NG] ${u._file}:${s.line} ${u.id} ステップ ${k}「${s.text}」に要件が無い（spec に usecase: ${u.id}, step: ${k} の REQ を書く。細分化して 1 か所のコードに対応させる）`);
  }

  // 走査
  const ignore = loadIgnore(problems);
  const impl = new Map(), veri = new Map();
  const refs = [];
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
            problems.push(`[NG] ${rel(f)}:${i + 1} ${name}${p.kind === "route" ? "" : "()"}: @implements タグがありません（実現する REQ-xxx を直前のコメントに書く。どの要件にも当たらないなら、要件を書くか、この単位を消す）`);
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

  // C3
  for (const x of refs) {
    const r = reqIds.get(x.id);
    if (!r) problems.push(`[NG] ${x.file}:${x.line} が存在しない ID ${x.id} を参照しています（${x.tag}）`);
    else if (r.status === "withdrawn") problems.push(`[NG] ${x.file}:${x.line} が withdrawn の ${x.id} を参照しています（タグを外すか要件を戻す）`);
  }
  // C1 / C2 / C7（active だけ）
  let implemented = 0, tested = 0, active = 0;
  for (const r of reqs) {
    if (r.status !== "active" || r._dup) continue;
    active++;
    const I = impl.get(r.id) ?? [], V = veri.get(r.id) ?? [];
    if (I.length) implemented++; else problems.push(`[NG] ${r.id}: 実装がありません（@implements ${r.id} が見つかりません）: ${r.description}`);
    if (V.length) tested++; else problems.push(`[NG] ${r.id}: テストがありません（@verifies ${r.id} が見つかりません）: ${r.acceptance}`);
    if (I.length > maxUnits) problems.push(`[NG] ${r.id}: 実装が ${I.length} か所にある（上限 ${maxUnits}: ${I.map((w) => `${w.file}:${w.line}`).join(" ")}）。要件が粗い。ステップを分けて、1 か所のコードに対応する要件へ細分化する`);
  }
  // C6
  for (const e of ignore) if (!e.used) problems.push(`[NG] ${rel(ignorePath)}:${e.line} 使われていない除外（指す先にタグが付いたか名前が変わった）: ${e.file}${e.name ? "::" + e.name : ""}`);

  if (opt.index) {
    for (const r of reqs) {
      const I = (impl.get(r.id) ?? []).map((w) => `${w.file}:${w.line}`).join(" ") || "-";
      const V = (veri.get(r.id) ?? []).map((w) => `${w.file}:${w.line}`).join(" ") || "-";
      console.log(`${r.id}\t${r.status}\t${r.usecase ?? "-"}#${r.step ?? "-"}\timpl: ${I}\ttest: ${V}`);
    }
    return 0;
  }
  const uniq = [...new Set(problems)];
  for (const p of uniq) console.log(p);
  const drafts = reqs.filter((r) => r.status === "draft").length, withdrawn = reqs.filter((r) => r.status === "withdrawn").length;
  const ucActive = ucs.filter((u) => u.status === "active").length, ucDraft = ucs.filter((u) => u.status === "draft").length;
  const covered = doc.normative.filter((s) => ucs.some((u) => u.source.includes(s) && u.status !== "withdrawn")).length;
  console.log(`全${active}件の要件のうち、実装済み${implemented}件・テスト済み${tested}件（仕様書の節 ${covered}/${doc.normative.length} に UC、UC active ${ucActive}・draft ${ucDraft}、要件 draft ${drafts}・withdrawn ${withdrawn}）${uniq.length ? `。NG ${uniq.length} 件` : "。問題なし"}`);
  return uniq.length ? 1 : 0;
}

function nextId(kind) {
  const problems = [];
  const prefix = kind === "uc" ? "UC" : "REQ";
  const ids = kind === "uc"
    ? (fs.existsSync(ucDir) ? fs.readdirSync(ucDir).filter((n) => n.endsWith(".md")).map((n) => n.replace(/\.md$/, "")) : [])
    : (fs.existsSync(specPath) ? parseSpec(fs.readFileSync(specPath, "utf8"), problems).map((x) => x.id) : []);
  const resPath = path.resolve(opt.root, ".trace-reservations.json");
  const res = fs.existsSync(resPath) ? JSON.parse(fs.readFileSync(resPath, "utf8")) : {};
  const nums = [...ids, ...(res[prefix] ?? [])].map((id) => Number(String(id).split("-")[1])).filter((n) => !Number.isNaN(n));
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
