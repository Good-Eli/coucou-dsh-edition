import test from "node:test";
import assert from "node:assert/strict";

import { cornerRadius, growsUp } from "../src/core/corners.ts";

// CSS order: top-left, top-right, bottom-right, bottom-left.

test("the corners that meet the docked edge are square", () => {
  // Hanging from the bottom of the screen: both bottom corners are square.
  for (const mode of ["bottomLeft", "bottomRight", "taskbarLeft", "taskbarRight"]) {
    const [, , br, bl] = cornerRadius(mode, 14).split(" ").map((v) => parseFloat(v));
    assert.equal(br, 0, `${mode} bottom-right must be square`);
    assert.equal(bl, 0, `${mode} bottom-left must be square`);
  }
  // The top edge: both top corners are square.
  for (const mode of ["topLeft", "topRight", "topCenter"]) {
    const [tl, tr] = cornerRadius(mode, 14).split(" ").map((v) => parseFloat(v));
    assert.equal(tl, 0, `${mode} top-left must be square`);
    assert.equal(tr, 0, `${mode} top-right must be square`);
  }
});

test("the free corners are rounded", () => {
  const [tl, tr] = cornerRadius("bottomLeft", 14).split(" ").map((v) => parseFloat(v));
  assert.ok(tl > 0 && tr > 0, "a bottom placement still has rounded top corners");
  const [, , br, bl] = cornerRadius("topCenter", 14).split(" ").map((v) => parseFloat(v));
  assert.ok(br > 0 && bl > 0, "a top placement still has rounded bottom corners");
});

test("left and right are not the same shape", () => {
  // The free corner on the anchored side is the larger one, so the two sides
  // of the same edge are mirror images rather than identical.
  const left = cornerRadius("bottomLeft", 14);
  const right = cornerRadius("bottomRight", 14);
  assert.notEqual(left, right, "bottomLeft and bottomRight must differ");

  const [ltl, ltr] = left.split(" ").map((v) => parseFloat(v));
  const [rtl, rtr] = right.split(" ").map((v) => parseFloat(v));
  assert.ok(ltl > ltr, "bottomLeft rounds its left corner more");
  assert.ok(rtr > rtl, "bottomRight rounds its right corner more");

  // The same holds on the top edge, where the rounded corners are the lower ones.
  const topLeft = cornerRadius("topLeft", 14).split(" ").map((v) => parseFloat(v));
  const topRight = cornerRadius("topRight", 14).split(" ").map((v) => parseFloat(v));
  assert.ok(topLeft[3] > topLeft[2], "topLeft rounds its left corner more");
  assert.ok(topRight[2] > topRight[3], "topRight rounds its right corner more");
});

test("the middle of the top edge favours neither side", () => {
  const [, , br, bl] = cornerRadius("topCenter", 14).split(" ").map((v) => parseFloat(v));
  assert.equal(br, bl, "no side to prefer");
});

test("the taskbar edge mirrors the screen bottom", () => {
  // Sitting on the taskbar and hanging from the screen bottom are the same
  // shape: only the y position differs, which the geometry handles.
  assert.equal(cornerRadius("taskbarLeft", 14), cornerRadius("bottomLeft", 14));
  assert.equal(cornerRadius("taskbarRight", 14), cornerRadius("bottomRight", 14));
});

test("the animated radius drives the corners", () => {
  // The radius spring still owns the rounded corners, so the island keeps
  // rounding as it grows and folds.
  assert.equal(cornerRadius("topCenter", 0), "0 0 0 0");
  assert.equal(cornerRadius("topCenter", 10), "0 0 10px 10px");
  const wide = cornerRadius("bottomLeft", 20);
  assert.ok(wide.includes("20px"), "the base radius is used as given");
});

test("a nonsense radius never produces a negative corner", () => {
  assert.equal(cornerRadius("topCenter", -5), "0 0 0 0");
  assert.equal(cornerRadius("bottomLeft", Number.NaN), "0 0 0 0");
});

test("an unknown mode falls back to the default corner shape", () => {
  assert.equal(cornerRadius("nonsense", 14), cornerRadius("bottomLeft", 14));
});

test("only the top edge grows downwards", () => {
  assert.equal(growsUp("bottomLeft"), true);
  assert.equal(growsUp("taskbarRight"), true);
  assert.equal(growsUp("topCenter"), false);
  assert.equal(growsUp("topLeft"), false);
});
