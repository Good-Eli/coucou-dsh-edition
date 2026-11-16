// The spend card: today, the week and the month, from PlusVibeAPI's own records.
//
// This is the island's answer to "сколько я потратил" without leaving the island.
// Every figure comes from the provider — the account is billed by PlusVibeAPI,
// so a locally tallied number would only ever be an estimate. When the provider
// cannot be read, the card says so: a zero would be a claim nobody made.

import { h } from "./dom";
import { rubles, compactTokens, Dsh, type SpendStats, type SpendTotals } from "../core/dsh";
import { Spend, refreshSpend } from "../island/dsh";
import { State } from "../core/state";
import { t } from "../i18n/i18n";
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

export function buildSpend(actions: ViewActions): ViewHost {
  const tabs = h("div", { class: "spend-tabs" });
  const body = h("div", { class: "spend-body" });
  const foot = h("div", { class: "spend-foot" });
  const el = h(
    "div",
    { class: "view spend" },
    h("div", { class: "card" }, h("div", { class: "stack spend-stack" }, tabs, body, foot)),
  );

  let drawnKey = "";

  /** One figure with its caption: the number is what the eye should land on. */
  const figure = (value: string, caption: string, big = false) =>
    h(
      "div",
      { class: big ? "spend-figure big" : "spend-figure" },
      h("span", { class: "v", text: value }),
      h("span", { class: "c", text: caption }),
    );

  const totalsFor = (stats: SpendStats, period: Period): SpendTotals => stats[period];

  const buildTabs = () => {
    tabs.replaceChildren();
    for (const period of PERIODS) {
      const button = h("button", {
        class: Spend.period === period ? "spend-tab on" : "spend-tab",
        text: periodLabel(period),
        onclick: () => {
          if (Spend.period === period) return;
          Spend.period = period;
          actions.blip();
          State.notify();
        },
      });
      tabs.append(button);
    }
  };

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

    const stats = Spend.stats;
    const totals = totalsFor(stats, Spend.period);
    const since = stats.since?.[Spend.period] ?? "";
    const periodName = periodLabel(Spend.period).toLowerCase();

    body.append(
      h(
        "div",
        { class: "spend-figures" },
        figure(rubles(totals.rub), t("Spent"), true),
        figure(compactTokens(totals.tokens), t("Tokens")),
        figure(count(totals.requests), t("Requests")),
      ),
    );
    body.append(
      h("div", {
        class: "spend-since",
        // "с 1 ноября" / "since 10 Nov" — the window is named, not assumed.
        text: since ? `${t("Since")} ${since}` : periodName,
      }),
    );
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
      const key = [
        Spend.period,
        Spend.loading,
        Spend.error ?? "",
        Spend.stats ? JSON.stringify(Spend.stats) : "",
      ].join("~");
      if (key === drawnKey) return;
      drawnKey = key;
      buildTabs();
      buildBody();
      buildFoot();
    },
  };
}

// Imported late to avoid a cycle: state.ts → views → state.ts is fine, but
// keeping it at the bottom makes the dependency obvious.

/** The button in the island's header: a chart, shown only while DSH is live. */
export function spendPillVisible(): boolean {
  return !!Dsh.snapshot && Dsh.snapshot.status === "ready";
}
