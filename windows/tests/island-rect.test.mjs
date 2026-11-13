import test from "node:test";
import assert from "node:assert/strict";

/**
 * Where the panel sits inside its window, which the hit area and the
 * click-through region are built from.
 *
 * Mirrors `Island.applyGeometry`. The window is sized to the panel, so this is
 * usually zero — but it is what was wrong on the right-hand placements: a
 * rectangle centred in the window pointed at empty space, so clicks on the
 * island's right-hand half went through to the app behind it.
 */
const RIGHT_MODES = ["bottomRight", "taskbarRight", "topRight"];

function originX(mode, viewportW, panelW) {
  const centred = mode === "topCenter";
  const right = RIGHT_MODES.includes(mode);
  return centred ? (viewportW - panelW) / 2 : right ? Math.max(0, viewportW - panelW) : 0;
}

test("a right-hand placement puts the panel on the right of its window", () => {
  for (const mode of RIGHT_MODES) {
    assert.equal(originX(mode, 720, 720), 0, `${mode}: window sized to the panel`);
    // A window wider than the panel: the panel is pinned right, and the rect
    // has to say so.
    assert.equal(originX(mode, 720, 160), 560, `${mode}: the closed island sits right`);
  }
});

test("a left-hand placement puts the panel on the left", () => {
  for (const mode of ["bottomLeft", "taskbarLeft", "topLeft"]) {
    assert.equal(originX(mode, 720, 160), 0, `${mode} starts at the left edge`);
  }
});

test("only the middle of the top edge is centred", () => {
  assert.equal(originX("topCenter", 720, 160), 280);
});

test("the rect follows the side the panel is pinned to", () => {
  // The bug: every bottom placement used to report a centred rect, so on the
  // right half of the screen the hit area sat over the wrong pixels.
  const left = originX("bottomLeft", 1080, 160);
  const right = originX("bottomRight", 1080, 160);
  assert.notEqual(left, right, "left and right must not report the same box");
  assert.equal(left, 0);
  assert.equal(right, 920);
});
