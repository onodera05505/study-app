// @vitest-environment jsdom
/** 論点の画面の階層の道筋（src/client/pages/TopicDetail.tsx）。本物の React で描く。
 *
 *  対象は読み込み時に決まる（VITE_EXAM）ので、描くたびに差し替えて読み込み直す。
 *  資格対策とロードマップ型の対象の集合は登録簿（src/shared/targets.json の kind）だけから作る。
 *  階層の道筋は、用語集の語「階層の道筋」を名前（aria-label か aria-labelledby）に持つ要素で探す。 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import targets from "../../src/shared/targets.json";

type Over = Record<string, unknown>;

/** 用語集の語。画面の読み上げの名前に使う。 */
const PATH_NAME = "階層の道筋";
/** 道筋の起点の画面の名前（用語集の語）。 */
const ROOT_STOP = "単元の一覧";

const REGISTRY = targets as unknown as Record<string, { kind?: string }>;
const kindOf = (kind: string) =>
  Object.entries(REGISTRY)
    .filter(([id, v]) => !id.startsWith("_") && v && v.kind === kind)
    .map(([id]) => id);
const EXAM_TARGETS = kindOf("exam");
const ROADMAP_TARGETS = kindOf("roadmap");

/** 論点の値の変種。分野・単元・論点の名前は互いに含み合わない文字にする。 */
const TOPICS = [
  {
    id: 231,
    term: "LTV",
    field: "ストラテジ系",
    major: "企業と法務",
    middle: "事業の指標",
    middleNo: 4,
  },
  {
    id: 418,
    term: "公開鍵暗号方式",
    field: "テクノロジ系",
    major: "技術要素",
    middle: "セキュリティ",
    middleNo: 12,
  },
];

const detail = (t: (typeof TOPICS)[number], over: Over = {}) => ({
  topic: {
    id: t.id,
    term: t.term,
    subtitle: null,
    explanation: `${t.term} の短い説明の本文です。`,
    detail: null,
    questionCount: 0,
    frequencyTier: null,
    isNew: 0,
    status: 2,
    statusSource: "override",
    field: t.field,
    major: t.major,
    middle: t.middle,
    middleNo: t.middleNo,
    itemName: "小項目の名前",
    tier: null,
  },
  questions: [],
  prerequisites: [],
  siblings: [],
  nextTopic: null,
  neighbors: null,
  ...over,
});

function stubApi(body: Over) {
  vi.stubGlobal("fetch", async (raw: string, init?: RequestInit) => {
    const url = new URL(String(raw), "http://localhost");
    const method = init?.method ?? "GET";
    if (method === "PUT")
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ ok: true }),
      };
    if (url.pathname.endsWith("/glossary"))
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ glossary: [] }),
      };
    if (/\/topics\/\d+$/.test(url.pathname))
      return { ok: true, status: 200, text: async () => JSON.stringify(body) };
    return { ok: true, status: 200, text: async () => JSON.stringify({}) };
  });
}

/** 名前が「階層の道筋」の要素（aria-label か aria-labelledby で名付けたもの）を集める。 */
function pathElements(host: HTMLElement): HTMLElement[] {
  const all = [
    ...host.querySelectorAll<HTMLElement>("[aria-label], [aria-labelledby]"),
  ];
  return all.filter((el) => {
    if ((el.getAttribute("aria-label") ?? "").trim() === PATH_NAME) return true;
    const ids = (el.getAttribute("aria-labelledby") ?? "")
      .split(/\s+/)
      .filter(Boolean);
    const name = ids
      .map((id) => host.ownerDocument.getElementById(id)?.textContent ?? "")
      .join(" ")
      .trim();
    return name === PATH_NAME;
  });
}

/** 対象を差し替えて読み込み直し、論点の画面を描く。 */
async function drawFor(target: string, topicId: number) {
  vi.stubEnv("VITE_EXAM", target);
  vi.resetModules();
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { MemoryRouter, Route, Routes } = await import("react-router-dom");
  const { TopicDetail } = await import("../../src/client/pages/TopicDetail");
  const api = await import("../../src/client/lib/api");
  api.invalidateCached();
  const host = document.createElement("div");
  document.body.appendChild(host);
  const r = createRoot(host);
  await React.act(async () => {
    r.render(
      React.createElement(
        MemoryRouter,
        { initialEntries: [`/topics/${topicId}`] },
        React.createElement(
          Routes,
          null,
          React.createElement(Route, {
            path: "/topics/:id",
            element: React.createElement(TopicDetail),
          }),
          React.createElement(Route, {
            path: "/topics",
            element: React.createElement("div", null, "一覧"),
          }),
        ),
      ),
    );
  });
  return {
    host,
    text: () => host.textContent ?? "",
    close: async () => {
      await React.act(async () => r.unmount());
      host.remove();
    },
  };
}

beforeAll(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("資格対策の論点の画面の階層の道筋（UC-002）", () => {
  // 対象が無ければ下の検査が 1 本も作られず空振りになる
  if (!EXAM_TARGETS.length) throw new Error("登録簿に資格対策の対象が無い");

  const cases = EXAM_TARGETS.flatMap((target) =>
    TOPICS.map((t) => ({ target, t })),
  );

  for (const { target, t } of cases) {
    // @covers REQ-423#path-from-unit-list-to-topic
    it(`${target} で「${t.term}」を選ぶと、教材とともに単元の一覧→分野→単元→論点の道筋が出る`, async () => {
      localStorage.clear();
      stubApi(detail(t));
      const v = await drawFor(target, t.id);
      expect(
        v.text(),
        "教材が描けていない（この検査は空振りになる）",
      ).toContain(`${t.term} の短い説明の本文です。`);
      const paths = pathElements(v.host);
      expect(paths.length, `名前が「${PATH_NAME}」の要素が 1 つでない`).toBe(1);
      const s = paths[0].textContent ?? "";
      const stops = [ROOT_STOP, t.field, t.middle, t.term];
      const at = stops.map((w) => s.indexOf(w));
      stops.forEach((w, i) =>
        expect(
          at[i],
          `道筋に「${w}」が無い（道筋の文字: ${s}）`,
        ).toBeGreaterThanOrEqual(0),
      );
      for (let i = 1; i < stops.length; i++)
        expect(
          at[i],
          `道筋で「${stops[i - 1]}」の後に「${stops[i]}」が来ていない（道筋の文字: ${s}）`,
        ).toBeGreaterThan(at[i - 1]);
      // 選んでいない論点の分野・単元を道筋に出さない
      for (const other of TOPICS.filter((o) => o.id !== t.id)) {
        expect(
          s,
          `選んでいない論点の分野「${other.field}」が道筋にある`,
        ).not.toContain(other.field);
        expect(
          s,
          `選んでいない論点の単元「${other.middle}」が道筋にある`,
        ).not.toContain(other.middle);
      }
      await v.close();
    });
  }
});

describe("ロードマップ型の論点の画面の階層の道筋（UC-009）", () => {
  // 対象が無ければ下の検査が 1 本も作られず空振りになる
  if (!ROADMAP_TARGETS.length)
    throw new Error("登録簿にロードマップ型の対象が無い");

  const t = {
    id: 231,
    term: "単位の名前",
    field: "道筋に出うる分野",
    major: "大項目",
    middle: "道筋に出うる単元",
    middleNo: 4,
  };

  for (const target of ROADMAP_TARGETS) {
    // @covers REQ-424#no-path-on-roadmap
    it(`${target} の論点の画面に、分野と単元を経る階層の道筋を出さない`, async () => {
      localStorage.clear();
      stubApi(
        detail(t, {
          topic: { ...detail(t).topic, status: null, statusSource: null },
          neighbors: {
            prev: { id: 230, term: "前の単位の名前" },
            next: { id: 232, term: "次の単位の名前" },
          },
        }),
      );
      const v = await drawFor(target, t.id);
      expect(
        v.text(),
        "教材が描けていない（この検査は空振りになる）",
      ).toContain(`${t.term} の短い説明の本文です。`);
      expect(
        pathElements(v.host).length,
        `名前が「${PATH_NAME}」の要素がある`,
      ).toBe(0);
      expect(v.text(), `道筋の起点「${ROOT_STOP}」が出ている`).not.toContain(
        ROOT_STOP,
      );
      expect(v.text(), `道筋の段の分野「${t.field}」が出ている`).not.toContain(
        t.field,
      );
      expect(v.text(), `道筋の段の単元「${t.middle}」が出ている`).not.toContain(
        t.middle,
      );
      await v.close();
    });
  }
});
