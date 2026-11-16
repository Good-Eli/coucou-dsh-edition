// The spend card: today, the week and the month, all on one page.
//
// This is the island's answer to "сколько я потратил" without leaving the island.
// Every figure comes from PlusVibeAPI — the account is billed by the provider,
// so a locally tallied number would only ever be an estimate. When it cannot be
// read, the card says so: a zero would be a claim nobody made.
//
// One page, no tabs: three periods side by side is the whole point of a glance,
// and switching between them hides two thirds of the answer.

import { h } from "./dom";
import { rubles, compactTokens, Dsh, type SpendStats, type SpendTotals } from "../core/dsh";
import { Spend, refreshSpend } from "../island/dsh";
import { language, t } from "../i18n/i18n";
import type { ViewActions, ViewHost } from "./views";

type Period = "day" | "week" | "month";

const PERIODS: Period[] = ["day", "week", "month"];

/** The label each period is shown under. */
function periodLabel(period: Period): string {
  switch (period) {
    case "day":
      return t("Today");
    case "week":
      return t("Week");
    case "month":
      return t("Month");
  }
}

/** "1 234" — a request count reads better with its thousands separated. */
function count(n: number): string {
  return Math.max(0, Math.round(n)).toLocaleString();
}

/**
 * "16 нояб." from a `2026-11-16` day key.
 *
 * The provider names the window with a bare date; a person reads a date, not an
 * ISO string. The locale does the formatting, so the order of day and month
 * follows the language rather than the wire.
 */
function shortDay(iso: string): string {
  if (!iso) return "";
  const at = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(at.getTime())) return iso;
  try {
    return at.toLocaleDateString(language(), { day: "numeric", month: "short" });
  } catch {
    return iso;
  }
}

export function buildSpend(actions: ViewActions): ViewHost {
  const body = h("div", { class: "spend-body" });
  const foot = h("div", { class: "spend-foot" });
  const el = h(
    "div",
    { class: "view spend" },
    h("div", { class: "card" }, h("div", { class: "stack spend-stack" }, body, foot)),
  );

  let drawnKey = "";

  /**
   * One period's column: its name, its roubles, and the two smaller figures.
   *
   * The roubles lead because that is the question; tokens and requests are the
   * "why", one size down and labelled rather than declined. "Токены 291,9M" is
   * right in every language and for every number — "291,9M токены" is not.
   */
  const column = (period: Period, totals: SpendTotals, since: string) =>
    h(
      "div",
      { class: "spend-col" },
      h("div", { class: "spend-col-head" },
        h("span", { class: "spend-col-name", text: periodLabel(period) }),
        since ? h("span", { class: "spend-col-since", text: shortDay(since) }) : null,
      ),
      h("div", { class: "spend-col-main", text: rubles(totals.rub) }),
      h("div", { class: "spend-col-sub" },
        h("span", { class: "k", text: t("Tokens") }),
        h("span", { class: "v", text: compactTokens(totals.tokens) }),
        h("span", { class: "k", text: t("Requests") }),
        h("span", { class: "v", text: count(totals.requests) }),
      ),
    );

  const buildBody = () => {
    body.replaceChildren();
    if (Spend.loading && !Spend.stats) {
      body.append(h("div", { class: "spend-note", text: t("Reading the provider's records…") }));
      return;
    }
    if (!Spend.stats) {
      // Nothing to show and nothing on its way: say why, and offer to ask again.
      body.append(
        h("div", { class: "spend-note", text: Spend.error ?? t("No figures are available") }),
      );
      return;
    }

    const stats: SpendStats = Spend.stats;
    body.append(
      h(
        "div",
        { class: "spend-grid" },
        ...PERIODS.map((period) => column(period, stats[period], stats.since?.[period] ?? "")),
      ),
    );
    if (stats.truncated) {
      // The provider had more history than was read: the month is partial, and
      // saying so is better than a number that looks complete.
      body.append(h("div", { class: "spend-note", text: t("The month's history was longer than one read.") }));
    }
    // What the month works out to per day. It is the same figures divided by the
    // days elapsed, so it costs nothing to read and answers "is this normal?",
    // which the three totals alone do not.
    const perDay = averagePerDay(stats);
    if (perDay != null) {
      body.append(
        h("div", {
          class: "spend-avg",
          text: t("Average per day: {amount}", { amount: rubles(perDay) }),
        }),
      );
    }
  };

  const buildFoot = () => {
    foot.replaceChildren();
    const when = Spend.loading
      ? t("Refreshing…")
      : Spend.stats
        ? t("PlusVibeAPI's own records")
        : t("PlusVibeAPI could not be read");
    foot.append(h("span", { class: "spend-src", text: when }));
    const again = h("button", {
      class: "spend-again",
      text: t("Refresh"),
      onclick: () => {
        actions.blip();
        refreshSpend(true);
      },
    });
    foot.append(again);
  };

  return {
    el,
    activate() {
      // Opening the card is what asks for the figures: a background poll of a
      // month of history would cost the account requests nobody asked for.
      refreshSpend();
    },
    sync() {
      const key = [Spend.loading, Spend.error ?? "", Spend.stats ? JSON.stringify(Spend.stats) : ""].join("~");
      if (key === drawnKey) return;
      drawnKey = key;
      buildBody();
      buildFoot();
    },
  };
}

/**
 * The month's spend divided by the days it covers, or null when it cannot be.
 *
 * "Average" means the calendar month so far: the provider's month window starts
 * on the 1st, so the divisor is today's date. A month with no rows has no
 * average — a zero would be a claim nobody made, the same rule the totals follow.
 */
export function averagePerDay(stats: SpendStats, now = new Date()): number | null {
  const rub = Number(stats.month?.rub);
  if (!Number.isFinite(rub) || rub <= 0) return null;
  const since = stats.since?.month ?? "";
  const start = since ? new Date(`${since}T00:00:00`) : null;
  // Both ends count: the 1st to the 11th is eleven days of spend, not ten.
  const days =
    start && !Number.isNaN(start.getTime())
      ? Math.max(1, Math.floor((now.getTime() - start.getTime()) / 86_400_000) + 1)
      : now.getDate();
  return rub / Math.max(1, days);
}

/** The button in the island's header: a chart, shown only while DSH is live. */
export function spendPillVisible(): boolean {
  return !!Dsh.snapshot && Dsh.snapshot.status === "ready";
}
