// Settings → DeepSeek Harness: the bridge section.
//
// These are structural checks rather than a render: the section is built from
// real Bridge calls, so it cannot be mounted here. They cover the one thing that
// went wrong for real — a button with no text on it. Two blank rectangles came
// up next to each other, and the one on the right switched the bridge off: every
// approval then fell back to DSH's own window, which reads as "the buttons are
// gone" with nothing to point at.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../src/settings/dsh.ts", import.meta.url), "utf8");

/** Every `h("button", { ... })` in the file, as its options text. */
function buttons() {
  const out = [];
  const re = /h\("button",\s*\{([\s\S]*?)\}\)/g;
  for (const match of source.matchAll(re)) out.push(match[1]);
  return out;
}

test("every button in the DSH section says something", () => {
  const found = buttons();
  assert.ok(found.length >= 2, "the section has an install and a remove button");
  for (const options of found) {
    assert.match(
      options,
      /text:\s*t\(/,
      `a button has no label: {${options.trim()}}`,
    );
  }
});

test("removing the bridge takes two clicks and says what it costs", () => {
  // One click used to be enough, and the button was blank.
  assert.match(source, /confirming/, "the remove button remembers being asked once");
  assert.match(
    source,
    /Approvals stop working\. Remove anyway\?/,
    "the second click names the consequence",
  );
});

test("the section says what the bridge is for, not only where it lives", () => {
  // The old text showed a folder path to someone deciding whether to remove it.
  assert.match(source, /Without it, DSH asks for permissions in its own window\./);
});

test("the buttons use the page's own classes", () => {
  // `btn` is not a class in settings.css: it left the buttons unstyled.
  for (const options of buttons()) {
    assert.ok(
      !/\bbtn\b/.test(options),
      `class "btn" does not exist on the settings page: {${options.trim()}}`,
    );
  }
});