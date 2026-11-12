/**
 * The island's corner radii, per edge.
 *
 * The panel is a card docked to one edge of the screen: the corners that meet
 * that edge are square, so it reads as attached rather than floating, and the
 * free corners are rounded. Which of the free corners gets the larger radius
 * follows the side it is anchored to, so the left and right placements are not
 * the same shape.
 *
 * CSS order is top-left, top-right, bottom-right, bottom-left.
 */

/** How much larger the free corner facing the anchored side is. */
const OUTER = 1.6;

export function cornerRadius(mode: string, radius: number): string {
  // A spring can be mid-flight or, after a resize, not a number at all; a
  // negative or NaN radius would be dropped by the browser and leave the panel
  // square, so both settle on 0.
  const base = Number.isFinite(radius) ? Math.max(0, Math.round(radius)) : 0;
  const outer = Math.max(base, Math.round(base * OUTER));

  switch (mode) {
    // Hanging from the bottom of the screen, or sitting on the taskbar: the
    // bottom edge is attached, so both bottom corners are square.
    case "bottomRight":
    case "taskbarRight":
      return `${px(base)} ${px(outer)} 0 0`;
    case "topLeft":
      return `0 0 ${px(base)} ${px(outer)}`;
    case "topRight":
      return `0 0 ${px(outer)} ${px(base)}`;
    // The middle of the top edge has no side to favour.
    case "topCenter":
      return `0 0 ${px(base)} ${px(base)}`;
    case "bottomLeft":
    case "taskbarLeft":
    default:
      return `${px(outer)} ${px(base)} 0 0`;
  }
}

/** A bare `0` for a square corner, so the value reads as one. */
function px(value: number): string {
  return value === 0 ? "0" : `${value}px`;
}

/** True when the panel grows upwards, so its attached edge is the bottom one. */
export function growsUp(mode: string): boolean {
  return mode !== "topCenter" && mode !== "topLeft" && mode !== "topRight";
}
