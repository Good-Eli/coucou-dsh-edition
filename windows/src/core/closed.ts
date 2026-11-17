// The closed island: what stays at the top of the screen once the island is
// folded all the way, where a Mac has its notch. A PC has no notch to hide
// behind, so instead of vanishing (which left nothing to find it by) the
// island keeps a small black shape there, with one thing in it: Mochi (what a
// Mac shows on a screen without a notch), the time, the date and the time, the
// Claude plan's usage, what plays, or nothing at all.
// "hidden" keeps the old behaviour: nothing shows, the top edge wakes it.
// No DOM here: the island draws what this returns.

import { dominantPct, planColor, type PlanUsage } from "./plan";

export type ClosedIsland = "mochi" | "time" | "datetime" | "claude" | "usage" | "music" | "empty" | "hidden";

export const CLOSED_ISLANDS: readonly ClosedIsland[] = ["mochi", "time", "datetime", "claude", "usage", "music", "empty", "hidden"];

/** A value this build doesn't know (written by a newer one) reads as the default. */
export function closedIsland(value: unknown): ClosedIsland {
  return CLOSED_ISLANDS.includes(value as ClosedIsland) ? (value as ClosedIsland) : "mochi";
}

/** The closed island's size where there is nothing but Mochi, in CSS px: the
 *  Mac's resting island on a screen without a notch (IslandScreenGeometry). */
export const CLOSED_H = 24;
export const CLOSED_MIN_W = 80;
/** Mochi in it, as on that Mac: centred, a little smaller than the island is tall. */
export const CLOSED_BOT_D = 18;
/** Widest: a long song title is cut, the island doesn't run across the screen. */
export const CLOSED_MAX_W = 280;
/** Room on each side of the text. */
export const CLOSED_PAD = 16;

export interface ClosedContent {
  text: string;
  /** A coloured dot before the text (the plan's gauge colour). */
  dot: string | null;
  /** A note before the text (what plays). */
  note: boolean;
}

export interface ClosedInputs {
  now: Date;
  /** The interface's language, for the date and the time. */
  locale?: string;
  planUsage: PlanUsage | null;
  /**
   * Today's PlusVibeAPI spend, already formatted ("55M / 33,41 ₽"), or null
   * while the provider has not answered. Formatted by the caller so this file
   * stays free of the bridge's types; null shows nothing rather than a zero the
   * provider never reported.
   */
  usage: string | null;
  /** The song playing, if one plays on a declared music pill. */
  music: { title: string; artist: string } | null;
}

function time(now: Date, locale?: string): string {
  return now.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
}

/**
 * What the closed island shows, or null when it shows nothing (the empty
 * shape, or no island at all). The Claude usage and the music fall back to
 * the time while there is nothing to show, so the island is never blank by
 * surprise.
 */
export function closedContent(style: ClosedIsland, input: ClosedInputs): ClosedContent | null {
  const plain = (text: string): ClosedContent => ({ text, dot: null, note: false });
  switch (style) {
    case "hidden":
    case "empty":
    case "mochi":
      return null;
    case "time":
      return plain(time(input.now, input.locale));
    case "datetime": {
      const date = input.now.toLocaleDateString(input.locale, { weekday: "short", day: "numeric", month: "short" });
      return plain(`${date}  ${time(input.now, input.locale)}`);
    }
    case "claude": {
      const pct = dominantPct(input.planUsage, input.now.getTime());
      if (pct == null) return plain(time(input.now, input.locale));
      return { text: `Claude ${Math.round(pct)}%`, dot: planColor(pct), note: false };
    }
    case "usage": {
      // Today's spend, and nothing else: no date and no clock beside it. With
      // no figure from the provider the island keeps its empty shape — a zero
      // here would be a claim nobody made.
      return input.usage ? plain(input.usage) : null;
    }
    case "music": {
      const m = input.music;
      if (!m || !m.title) return plain(time(input.now, input.locale));
      return { text: m.artist ? `${m.title} · ${m.artist}` : m.title, dot: null, note: true };
    }
  }
}

/**
 * A hair of slack, in CSS px.
 *
 * The width handed to the window is a whole number, so a line whose true width is
 * 88.4 gets an island that is 0.4 px too narrow — and `#island-closed .text`
 * ellipsises on *any* overflow, so those four tenths replaced the "₽" with "…".
 * That is why the island sometimes looked too small for no visible reason: it
 * depended on the fractional part of the text's width, which changes with the
 * digits. Half a pixel is enough to cover it and invisible in a 24-pixel island.
 */
export const CLOSED_SLACK = 0.5;

/**
 * The closed island's width for a text `textWidth` px wide (0 for none).
 *
 * `textWidth` must be the *fractional* width, measured with
 * `getBoundingClientRect` — not `scrollWidth`, which rounds to a whole pixel and
 * loses the fraction this function then cannot know to add back.
 */
export function closedWidth(textWidth: number, extras = 0): number {
  if (!(textWidth > 0)) return CLOSED_MIN_W;
  const w = Math.ceil(textWidth + extras + CLOSED_PAD * 2 + CLOSED_SLACK);
  return Math.max(CLOSED_MIN_W, Math.min(CLOSED_MAX_W, w));
}
