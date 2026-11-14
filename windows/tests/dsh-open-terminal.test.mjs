// "Open terminal" on a DeepSeek Harness pill.
//
// DSH is a window of its own, with no terminal and no folder the user expects
// to be opened in an editor. The button used to fall through to the generic
// path, which opened the session's folder in VS Code: the user asked for the
// thing running the session and got an editor instead.
//
// These are structural checks: the island's action table needs a live DOM and a
// Tauri bridge, so what is verified is that the DSH branch is there and comes
// before the fallback, in both places the action is wired.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

/** The body of one function/arrow in a source file, by its opening text. */
function bodyAfter(source, opening) {
  const start = source.indexOf(opening);
  assert.notEqual(start, -1, `could not find ${opening}`);
  return source.slice(start, start + 900);
}

test("the island's Open terminal brings DSH's window forward", () => {
  const source = read("../src/island/island.ts");
  const body = bodyAfter(source, "openTerminal: () => {");
  assert.match(body, /Bridge\.dshOpenWindow\(\)/, "the DSH branch must be there");
  // The generic path opens VS Code; it must stay the last resort.
  const dsh = body.indexOf("Bridge.dshOpenWindow()");
  const generic = body.indexOf("Bridge.openSession(");
  assert.ok(dsh >= 0 && generic > dsh, "the DSH branch comes before the fallback");
});

test("the Jump to terminal shortcut does the same", () => {
  const source = read("../src/island/shortcuts.ts");
  const body = bodyAfter(source, 'case "jumpToTerminal":');
  assert.match(body, /Bridge\.dshOpenWindow\(\)/);
  const dsh = body.indexOf("Bridge.dshOpenWindow()");
  const generic = body.indexOf("Bridge.openSession(");
  assert.ok(dsh >= 0 && generic > dsh, "the DSH branch comes before the fallback");
});

test("the finished card does not offer a terminal DSH does not have", () => {
  const source = read("../src/views/views.ts");
  assert.match(source, /Open DeepSeek Harness/, "the button is renamed for DSH");
});
