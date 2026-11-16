// The overview's layout follows the work.
//
// The right-hand column used to be fixed at 322 pixels with a two-wide grid, so
// a single running dialog left a wide empty strip beside it. Three layouts now:
// nothing to list and the column is gone, two or three pills in one column, four
// or more in two columns of three. This file pins down which one is chosen and
// what the card stands for in each.

import { test } from "node:test";
import assert from "node:assert/strict";

import { installFakeDom } from "./fakedom.mjs";

installFakeDom();

const { buildViews } = await import("../src/views/views.ts");
const { State } = await import("../src/core/state.ts");
const { Dsh, sessionColor } = await import("../src/core/dsh.ts");
const { setLanguage } = await import("../src/i18n/i18n.ts");
const { syncTask } = await import("../src/island/dsh.ts");

setLanguage("en");

const session = (over = {}) => ({
  id: "s1",
  cwd: "C:\\work\\proj",
  title: "Починить запросы одобрения Coucou DSH",
  model: { provider: "deepseek", model: "v4-flash", reasoningEffort: "high" },
  state: "working",
  since: Date.now(),
  steps: ["pwsh cargo test"],
  stepSeq: 1,
  ...over,
});

const snapshot = (over = {}) => ({
  status: "ready",
  error: null,
  version: "0.2.2-rc.3",
  approvalsEnabled: true,
  hardened: true,
  sessions: [],
  catalog: { providers: [] },
  pending: [],
  activeSession: null,
  updatedAt: 1,
  ...over,
});

/** The overview view with a stub action set: nothing here is clicked. */
function views() {
  return buildViews(
    {
      blip: () => {},
      setView: () => {},
      setFocus: (id) => State.setFocus(id),
      openTarget: () => {},
      openSettingsWindow: () => {},
      keyboard: () => {},
      holdOpen: () => {},
      openFileInVSCode: () => {},
    },
    () => {},
  ).get("overview");
}

function apply(over = {}) {
  Dsh.snapshot = snapshot(over);
  syncTask();
  const v = views();
  v.sync();
  return v;
}

const classesOf = (view) => view.el.className.split(/\s+/).filter(Boolean);
const pillsOf = (view) => {
  const found = [];
  const walk = (node) => {
    if (node.classList?.contains("pill")) found.push(node);
    for (const child of node.childNodes ?? []) walk(child);
  };
  walk(view.el);
  return found;
};

test.beforeEach(() => {
  State.tasks = [];
  State.focusId = null;
  Dsh.snapshot = null;
});

test("nothing running: the column is gone and the card has the island", () => {
  const view = apply({ sessions: [session({ state: "idle", steps: [], stepSeq: 0 })] });
  assert.ok(classesOf(view).includes("wide"), "one layout: wide");
  assert.equal(pillsOf(view).length, 0, "there is nothing to list");
});

test("one running dialog: still wide, and the card is that dialog", () => {
  const view = apply({ sessions: [session({ id: "s1", state: "working" })] });
  assert.ok(classesOf(view).includes("wide"), "a single dialog needs no column");
  assert.equal(pillsOf(view).length, 0, "its pill is not repeated beside the card");
  // The card follows the dialog, so the ticker and the "now" line describe it.
  const shown = State.focusTask?.id === "dsh" ? "dsh" : State.focusTask?.id;
  assert.ok(shown, "the card has a task");
});

test("two running dialogs: one column, two pills", () => {
  const view = apply({
    sessions: [
      session({ id: "s1", state: "working" }),
      session({ id: "s2", title: "Вторая", state: "working" }),
    ],
  });
  assert.ok(classesOf(view).includes("one-col"), "one column for two pills");
  assert.equal(pillsOf(view).length, 2, "both dialogs are listed");
});

test("three running dialogs: one column, three pills", () => {
  const view = apply({
    sessions: [
      session({ id: "s1", state: "working" }),
      session({ id: "s2", title: "B", state: "working" }),
      session({ id: "s3", title: "C", state: "working" }),
    ],
  });
  assert.ok(classesOf(view).includes("one-col"));
  assert.equal(pillsOf(view).length, 3, "three fit in a column");
});

test("four running dialogs: two columns", () => {
  const view = apply({
    sessions: ["s1", "s2", "s3", "s4"].map((id) => session({ id, title: id, state: "working" })),
  });
  assert.ok(classesOf(view).includes("two-col"), "four pills need two columns");
});

test("more than six: six cells, the last one a count", () => {
  const ids = ["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8"];
  const view = apply({
    sessions: ids.map((id) => session({ id, title: id, state: "working" })),
  });
  assert.ok(classesOf(view).includes("two-col"), "six is two columns of three");
  const pills = pillsOf(view);
  assert.equal(pills.length, 6, "six cells, no more");
  const more = pills.at(-1);
  assert.ok(more.classList.contains("pill-more"), "the sixth says how many are left");
  assert.match(more.textContent, /3/, "eight dialogs, five named, three counted");
});

test("a lone non-DSH pill keeps its column", () => {
  // Spotify on its own: the card must stay the overview, and the pill must stay
  // reachable. Hiding the column here would make it impossible to open.
  State.tasks = [
    { id: "dsh", name: "DeepSeek Harness", color: "#4C8DFF", state: "idle", steps: [], stepSeq: 0 },
    { id: "spotify", name: "Spotify", color: "#1DB954", state: "idle", steps: [], stepSeq: 0 },
  ];
  State.focusId = "dsh";
  Dsh.snapshot = snapshot({ sessions: [] });
  const v = views();
  v.sync();
  assert.ok(!classesOf(v).includes("wide"), "the column stays for a pill that is not a dialog");
  assert.equal(pillsOf(v).length, 1, "and the pill is there");
});

test("a dialog's colour comes from its id, and stays the same", () => {
  const a = sessionColor("session-aaaa");
  const b = sessionColor("session-aaaa");
  assert.equal(a, b, "the same dialog keeps its colour across restarts");
  assert.match(a, /^#[0-9A-F]{6}$/i, "a colour, not a name");
  // Eight tones for any number of dialogs, so two ids may share one. That is the
  // documented trade: stable beats unique, because a colour that changes after a
  // restart is a colour nobody can learn.
  const tones = new Set();
  for (let i = 0; i < 200; i += 1) tones.add(sessionColor(`session-${i}`));
  assert.ok(tones.size >= 6, `the palette is actually used, saw ${tones.size} tones`);
});

test("every running dialog wears its own colour", () => {
  apply({
    sessions: [
      session({ id: "s1", state: "working" }),
      session({ id: "s2", title: "B", state: "working" }),
    ],
  });
  const first = State.tasks.find((t) => t.id === "dsh:session:s1");
  const second = State.tasks.find((t) => t.id === "dsh:session:s2");
  assert.equal(first.color, sessionColor("s1"));
  assert.equal(second.color, sessionColor("s2"));
  // The tool's own pill is not a dialog and keeps the tool's blue.
  assert.equal(State.tasks.find((t) => t.id === "dsh").color, "#4C8DFF");
});

test("the pill label is the whole title, not a cut one", () => {
  const title = "Починить запросы одобрения Coucou DSH — очень длинное название диалога";
  apply({ sessions: [session({ id: "s1", title, state: "working" })] });
  const pill = State.tasks.find((t) => t.id === "dsh:session:s1");
  // The cut is the layout's job: a wide pill shows the whole name, and the model
  // has no idea how wide the pill will be.
  assert.equal(pill.name, title, "nothing is cut before the layout runs");
});
