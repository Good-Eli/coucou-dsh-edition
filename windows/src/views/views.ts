// Island views — DOM ports of IslandViewContent.swift. Paddings, font sizes,
// colours and wording are copied from the Swift views so both platforms read
// identically.

import { h, svg, clear, dot } from "./dom";
import { ICONS } from "./icons";
import { Ticker } from "./ticker";
import { State, type AgentTask } from "../core/state";
import { washRGBA, type IslandViewName, type Wash } from "../core/layout";
import { createMiniBot, pruneMiniBots } from "../mochi/minibots";
import { buildPrompt } from "./chat";
import { buildChoose, buildUpload, buildUploading } from "./upload";
import { renderIntegrationCard, type IntegrationCardHooks } from "./integrations";
import { highlightRow, listRows, openRow } from "./github";
import { pillDefinition, sessionSubtitle } from "../core/pills";
import {
  DSH_PILL_ID,
  Dsh,
  activeSession,
  busyDialogs,
  idleSummary,
  sessionFor,
  sessionHeading,
  usageLine,
  type DshSession,
} from "../core/dsh";
import { ageLabel } from "../core/plan";
import { isDshPill, sessionName } from "../island/dsh";
import {
  PlanCard, buildPlanPill, claudePillVisible, codexPillVisible, planCardOpen, refreshCodexPlanUsage,
} from "./usage";
import { buildDiffCard } from "./diff";
import { lastTextStep } from "../core/diff";
import { Bridge } from "../core/bridge";
import { buildRecap } from "./recap";
import { buildWardrobe } from "./wardrobe";
import { buildModel } from "./model";
import { buildSpend, spendPillVisible } from "./spend";
import { buildUpdate } from "./update";
import { buildWhatsNew } from "./whatsnew";
import { buildSpotifyCard, buildSpotifyPill, type SpotifyPillHost } from "./spotify";
import { SPOTIFY_ID } from "../core/spotify";
import { buildWhatsAppCard } from "./whatsapp";
import { WHATSAPP_ID } from "../core/whatsapp";
import { MAIL_ID } from "../core/mail";
import { buildMailCard } from "./mail";
import type { Outfit, OutfitSelection } from "../mochi/wardrobe";
import { language, t, tl, type Msg } from "../i18n/i18n";
import type { ViewCommand } from "../island/shortcuts";

export interface ViewActions {
  setView(v: IslandViewName): void;
  /** "Cancel" on a dropped file: forgets it and goes back home. */
  cancelDrop(): void;
  collapse(): void;
  /** Folds a waiting card to the compact island without answering it. */
  foldApproval(): void;
  setFocus(id: string): void;
  openTerminal(): void;
  /** The ↗ button: opens whatever the focused pill points at. */
  openTarget(): void;
  openUrl(url: string): void;
  decide(d: "allow" | "deny"): void;
  /** Answers the question Claude Code asked: question text → chosen label. */
  answer(answers: Record<string, string | string[]>): void;
  /** Hands the pending request back to the terminal. */
  answerInTerminal(): void;
  toggleSound(): void;
  setVolume(v: number): void;
  setAutoClose(seconds: number): void;
  openSettingsWindow(): void;
  blip(): void;
  /** Wardrobe click: keeps the outfit ("auto" and "none" included). */
  chooseOutfit(selection: OutfitSelection): void;
  /** Wardrobe hover: shows an outfit on Mochi without keeping it; null ends it. */
  previewOutfit(outfit: Outfit | null): void;
  /** The island takes the keyboard (a text field in a card) or gives it back. */
  keyboard(on: boolean): void;
  /** Something is being typed in a card: the island stays open until it is sent or cleared. */
  holdOpen(on: boolean): void;
  /** Opens the model picker for the DSH session on screen. */
  openModelPicker(): void;
  /** Switches one DSH session to another model of the catalog. */
  chooseDshModel(sessionId: string, provider: string, model: string): void;
  /** Switches the reasoning effort of one DSH session. */
  chooseDshEffort(sessionId: string, effort: string): void;
}

export interface ViewHost {
  el: HTMLElement;
  sync(): void;
  /** Called when the view becomes active, for views with a text field. */
  focus?(): void;
  /**
   * Called when the view appears on screen, for views that load something.
   *
   * Separate from `focus`: a text field wants the keyboard, a card wants its
   * data, and loading in the background would spend the provider's requests on
   * a card nobody opened.
   */
  activate?(): void;
  /** Called every frame while the view is on screen. True = needs another frame. */
  tick?(nowMs: number): boolean | void;
  /** Ctrl+O / Ctrl+E while the view is on screen (island/shortcuts.ts). */
  command?(command: ViewCommand): void;
}

// ── Shared pieces ─────────────────────────────────────────────────────────────

function card(wash: Wash, ...children: (Node | string)[]): HTMLElement {
  const el = h("div", { class: wash ? "card wash" : "card" }, ...children);
  if (wash) el.style.setProperty("--wash", washRGBA(wash));
  return el;
}

function btn(
  label: string | Msg,
  kind: "primary" | "secondary",
  onClick: () => void,
  kbd?: string,
): HTMLElement {
  return h(
    "button",
    { class: `btn ${kind}`, onclick: onClick },
    h("span", { text: label }),
    kbd ? h("span", { class: "kbd", text: kbd }) : null,
  );
}

/** AgentWho — coloured dot + task name + grey label. */
function agentWho(task: AgentTask | null, label: string): HTMLElement {
  const row = h("div", { class: "who-row" });
  if (task) {
    row.append(dot(task.color, 8), h("span", { class: "n", text: task.name }));
  }
  row.append(h("span", { text: label }));
  return row;
}

function stack(padLeft: number, padRight: number, ...children: Node[]): HTMLElement {
  const el = h("div", { class: "stack" }, ...children);
  el.style.padding = `4px ${padRight}px 4px ${padLeft}px`;
  return el;
}

// ── Header ────────────────────────────────────────────────────────────────────

export function buildHeader(actions: ViewActions): ViewHost {
  const tabHome = h("button", { class: "tab", title: tl("Overview"), onclick: () => go("overview") }, svg(ICONS.house, 17));
  const tabChat = h("button", { class: "tab", title: tl("Ask"), onclick: () => go("prompt") }, svg(ICONS.bubbleRound, 19));
  const tabDrop = h("button", { class: "tab", title: tl("Drop"), onclick: () => go("upload") }, svg(ICONS.plus, 16));

  // The gear is a toggle, like the wardrobe: pressing it while the settings are
  // open goes back to the view the island was on before, so the same button
  // both opens and closes them.
  const gearBtn = h(
    "button",
    {
      title: tl("Settings"),
      onclick: () => {
        actions.blip();
        if (State.view === "settings") actions.setView(State.defaultView());
        else actions.setView("settings");
      },
    },
    svg(ICONS.gearLine, 18, { stroke: 1.6 }),
  );
  const soundBtn = h("button", { title: tl("Mute"), onclick: () => actions.toggleSound() }, svg(ICONS.speakerLine, 18, { stroke: 1.6 }));
  // The spend card: today, the week, the month. Sits with the house / chat /
  // plus on the left, because it is about what DSH is doing, not about the app.
  const spendBtn = h(
    "button",
    {
      class: "tab spend-tab-btn",
      title: tl("PlusVibeAPI spend"),
      onclick: () => {
        actions.blip();
        if (State.view === "spend") actions.setView(State.defaultView());
        else actions.setView("spend");
      },
    },
    svg(ICONS.chart, 17),
  );
  // Folds back to the compact island now, without waiting for the timer (the
  // Mac's ✕). A card waiting for an answer keeps the island open: no ✕ then.
  const closeBtn = h("button", { class: "close", title: tl("Close"), onclick: () => actions.collapse() }, svg(ICONS.xmark, 17));
  // Plan usage pills (off by default): before the gear, Claude first, as on the Mac.
  const claudePill = buildPlanPill(false);
  const codexPill = buildPlanPill(true);
  const planPills = h("div", { class: "plan-pills" }, claudePill.el, codexPill.el);
  let codexShown = false;

  function go(v: IslandViewName) {
    actions.blip();
    actions.setView(v);
  }

  const el = h(
    "div",
    { id: "header" },
    // The spend card sits right after the house: it is about the work DSH is
    // doing, so it belongs with the tabs that switch what the island shows, and
    // it is one click away from the default view.
    h("div", { class: "tabs" }, tabHome, spendBtn, tabChat, tabDrop),
    h("div", { class: "header-actions" }, planPills, gearBtn, soundBtn, closeBtn),
  );
  const headerActions = el.lastElementChild as HTMLElement;

  return {
    el,
    sync() {
      const v = State.view;
      tabHome.classList.toggle("on", v === "overview" || v === "empty");
      tabChat.classList.toggle("on", v === "prompt");
      tabDrop.classList.toggle("on", v === "upload");
      // The spend card is only about DSH, so its button only exists while DSH is
      // live: a chart that opens onto "DSH is not connected" is worse than none.
      const spendable = spendPillVisible();
      spendBtn.style.display = spendable ? "" : "none";
      spendBtn.classList.toggle("on", spendable && v === "spend");
      gearBtn.classList.toggle("on", v === "settings");
      clear(gearBtn);
      gearBtn.append(v === "settings" ? svg(ICONS.gearFill, 18) : svg(ICONS.gearLine, 18, { stroke: 1.6 }));
      clear(soundBtn);
      soundBtn.append(svg(State.settings.soundEnabled ? ICONS.speakerLine : ICONS.speakerSlashLine, 18, { stroke: 1.6 }));
      closeBtn.style.display = State.pendingApproval ? "none" : "";
      syncPlanPills();
      el.style.opacity = v === "confused" ? "0" : "1";
    },
  };

  function syncPlanPills() {
    const claudeOn = claudePillVisible();
    const codexOn = codexPillVisible();
    claudePill.el.style.display = claudeOn ? "" : "none";
    codexPill.el.style.display = codexOn ? "" : "none";
    planPills.classList.toggle("on", claudeOn || codexOn);
    // Both pills: the right side tightens so it still clears the screen edge.
    headerActions.classList.toggle("both-plans", claudeOn && codexOn);
    if (claudeOn) claudePill.sync();
    if (codexOn) codexPill.sync();
    // Codex is asked when its pill comes into view (stale answers only).
    const shown = codexOn && State.mode === "expanded";
    if (shown && !codexShown) refreshCodexPlanUsage();
    codexShown = shown;
  }
}

// ── Overview ──────────────────────────────────────────────────────────────────

function buildOverview(actions: ViewActions): ViewHost {
  /** The diff open in the left card (a FileDiff id), as activeDiffId on macOS. */
  let activeDiffId: number | null = null;
  const closeDiff = () => {
    if (activeDiffId == null) return;
    activeDiffId = null;
    State.notify();
  };
  const ticker = new Ticker((diffId) => {
    actions.blip();
    activeDiffId = diffId;
    State.notify();
  });
  const who = h("div", { class: "who" });
  // The card's "now" line: what the agent says it is doing. Hidden for every
  // pill but DeepSeek Harness, whose card is the one that has a sentence to show.
  const nowBlock = h("div", { class: "saying" });
  nowBlock.style.display = "none";
  const tickerBody = h("div", { class: "card-body" }, who, nowBlock, ticker.el);

  // DeepSeek Harness at rest: the pill stays (it is where DSH lives in the list)
  // but there is no ticker to run, so the card answers the question a glance is
  // for — what ran last, how many windows are open, what today has cost.
  const idleWho = h("div", { class: "who stacked" });
  const idleHead = h("div", { class: "idle-head" });
  const idleLines = h("div", { class: "idle-lines" });
  const idleBody = h("div", { class: "card-body dsh-idle" }, idleWho, idleHead, idleLines);
  const leftBody = h("div", { class: "left-body" });
  const jump = h(
    "button",
    { class: "icon-btn jump", title: tl("Open"), onclick: () => actions.openTarget() },
    svg(ICONS.arrowUpRight, 12),
  );
  const left = card(null, leftBody, jump);
  const pills = h("div", { class: "pills" });
  const right = card(null, pills);
  // Opened from a plan pill in the header: stands in for the left card.
  const plan = new PlanCard();
  let planTimer: number | null = null;
  // Spotify's card and pill are kept and updated in place: the progress bar
  // runs on, and a slider being dragged must not be rebuilt under the pointer.
  const spotifyCard = buildSpotifyCard();
  let spotifyPill: SpotifyPillHost | null = null;
  // WhatsApp's card too: its reply field keeps the draft and the keyboard while messages arrive.
  // Mail's card too (classic Outlook): the search field keeps its text and the keyboard.
  const mailCard = buildMailCard({ keyboard: (on) => actions.keyboard(on) });
  const whatsappCard = buildWhatsAppCard({
    openSettings: () => actions.openSettingsWindow(),
    keyboard: (on) => actions.keyboard(on),
    holdOpen: (on) => actions.holdOpen(on),
  });

  const el = h("div", { class: "view overview" },
    h("div", { class: "left" }, left),
    h("div", { class: "right" }, right),
  );

  let pillIds = "";
  let detailOpen = false;
  let lastFocus: string | null = null;
  let mode: "ticker" | "card" | "plan" | "diff" | "spotify" | "whatsapp" | "mail" | "dshIdle" | null = null;
  let cardKey = "";
  /** The list row highlighted at the last sync, to scroll only when it moves. */
  let shownSelection: number | null = null;
  /** Which of the three overview layouts is on screen, so it is set only on change. */
  let layout: "" | "wide" | "one-col" | "two-col" = "";

  /**
   * The one pill the wide card stands in for, when there is exactly one.
   *
   * Only a dialog pill: with a single Spotify pill and nothing else, the card
   * must stay the overview, or the island would open on Spotify for no reason.
   */
  const onlyPill = (others: readonly AgentTask[]): AgentTask | null => {
    if (others.length !== 1) return null;
    const one = others[0];
    if (!isDshPill(one.id) || one.id === DSH_PILL_ID) return null;
    return one;
  };

  // Leaving the overview or folding the island closes the diff, as on macOS.
  State.subscribe(() => {
    if (activeDiffId != null && (State.view !== "overview" || State.mode !== "expanded")) {
      activeDiffId = null;
    }
  });
  // Escape steps back out of the diff before it closes the island.
  window.addEventListener(
    "keydown",
    (e) => {
      if (e.key !== "Escape" || activeDiffId == null || State.view !== "overview") return;
      e.stopImmediatePropagation();
      closeDiff();
    },
    true,
  );

  const hooks: IntegrationCardHooks = {
    get detailOpen() {
      return detailOpen;
    },
    openDetail() {
      detailOpen = true;
      cardKey = "";
      State.notify();
    },
    closeDetail() {
      detailOpen = false;
      cardKey = "";
      State.notify();
    },
    openSettings: () => actions.openSettingsWindow(),
  };

  /** The countdowns move every 30 s while a card is open, and only then. */
  function syncPlanTimer(open: boolean) {
    const stop = () => {
      if (planTimer != null) window.clearInterval(planTimer);
      planTimer = null;
    };
    if (!open) return stop();
    if (planTimer != null) return;
    planTimer = window.setInterval(() => {
      if (planCardOpen() && State.mode === "expanded") State.notify();
      else stop();
    }, 30_000);
  }

  return {
    el,
    tick(nowMs: number) {
      if (mode !== "ticker") return false;
      ticker.tick(nowMs);
      return ticker.animating;
    },
    command(command) {
      if (command === "openSelection") {
        // Ctrl+O: what a click on the highlighted row does.
        if (mode !== "card" || State.cardSelection == null) return;
        openRow(listRows(leftBody)[State.cardSelection]);
        return;
      }
      // Ctrl+E (⌘E, islandToggleDiff): closes the diff that is open, else
      // opens the focused pill's latest edit.
      if (activeDiffId != null) {
        closeDiff();
        return;
      }
      const task = State.focusTask;
      const diffs = task ? State.sessionDiffs.get(task.id) : undefined;
      const last = diffs?.[diffs.length - 1];
      if (last?.id == null) return;
      activeDiffId = last.id;
      State.notify();
    },
    sync() {
      const focus = State.focusTask;
      const allOthers = State.otherTasks;
      const only = onlyPill(allOthers);
      // With a single dialog running, the card is that dialog: the overview of
      // one thing is a worse answer than the thing itself. The column that would
      // hold its pill has nothing else to show, so it goes away and the card
      // takes the whole island.
      const substitute = only && focus?.id === DSH_PILL_ID ? only : null;
      const task = substitute ?? focus;
      // The column is hidden only when it has nothing to show. A lone Spotify
      // pill must still be there — hiding it would make it unreachable.
      const wide = allOthers.length === 0 || substitute != null;
      const others = wide ? [] : allOthers;

      if (task?.id !== lastFocus) {
        lastFocus = task?.id ?? null;
        detailOpen = false;
        activeDiffId = null;
        cardKey = "";
        mode = null;
      }

      // A workspace or agent pill with a live session keeps the ticker; every
      // other pill shows its own card, exactly like IntegrationCardView.
      const sessionActive = task != null && hasSessionTicker(task);

      const next = wide ? "wide" : allOthers.length <= 3 ? "one-col" : "two-col";
      if (next !== layout) {
        layout = next;
        el.classList.toggle("wide", next === "wide");
        el.classList.toggle("one-col", next === "one-col");
        el.classList.toggle("two-col", next === "two-col");
        cardKey = "";
      }

      const planOpen = planCardOpen();
      if (mode === "plan" && !planOpen) {
        mode = null;
        cardKey = "";
      }
      syncPlanTimer(planOpen);

      // A diff that has since been dropped (cap, expiry, session end) just closes.
      const diff = task && activeDiffId != null ? State.findDiff(task.id, activeDiffId) : null;
      if (!diff) activeDiffId = null;

      if (planOpen) {
        if (mode !== "plan") {
          clear(leftBody);
          leftBody.append(plan.el);
          mode = "plan";
        }
        plan.sync();
      } else if (task && diff) {
        const key = `diff~${task.id}~${diff.id}`;
        if (key !== cardKey) {
          cardKey = key;
          mode = "diff";
          clear(leftBody);
          leftBody.append(buildDiffCard(diff, {
            dismiss: () => {
              actions.blip();
              closeDiff();
            },
            open: (path) => void Bridge.openFileInVSCode(path),
          }));
        }
      } else if (task && task.id === DSH_PILL_ID) {
        // The tool's own pill is the overview: it says what is running now, or —
        // when nothing is — what ran last, how much is open, what today has cost.
        // Its name never changes and its card never becomes a ticker: that is
        // what makes the list readable. A dialog's own pill shows the ticker.
        if (mode !== "dshIdle") {
          clear(leftBody);
          leftBody.append(idleBody);
          mode = "dshIdle";
          cardKey = "";
        }
        syncOverviewCard(task, idleWho, idleHead, idleLines);
      } else if (task && sessionActive) {
        if (mode !== "ticker") {
          clear(leftBody);
          leftBody.append(tickerBody);
          mode = "ticker";
          cardKey = "";
        }
        clear(who);
        // Every DSH card — the tool's and each dialog's own — reads the same
        // way: the model as a caption, the dialog's name under it, and the
        // agent's sentence as "now".
        const dshCard = isDshPill(task.id);
        who.className = dshCard ? "who stacked" : "who";
        nowBlock.style.display = "none";
        if (dshCard) {
          // DeepSeek Harness: the card is about one dialog, so it names that
          // dialog and the model it runs instead of saying "Agent" and counting
          // identical lines. The model is the caption above the name, not
          // beside it: the name is the longest thing here and the jump button
          // eats the top-right corner, so the name gets the row underneath it
          // to itself. No colour dot either — the Mochi bot beside the card
          // already gives it a face.
          const session = sessionOfTask(task);
          const heading = sessionHeading(session);
          if (task.modelLine) who.append(h("span", { class: "tool", text: task.modelLine }));
          who.append(h("span", { class: "name", text: heading || task.name }));
          // "What is it doing right now", in the agent's own words. This is the
          // line that used to be a truncated shell command.
          const now = nowLine(task);
          if (now) {
            nowBlock.style.display = "";
            if (nowBlock.textContent !== now) nowBlock.textContent = now;
            nowBlock.classList.toggle("quiet", !task.sayLine);
          }
        } else {
          // The agent's name is already the pill's: the label says what kind of
          // pill it is, as on the Mac (PillDefinition.sessionSubtitle).
          who.append(
            dot(task.color, 7),
            h("span", { class: "name", text: task.name }),
            h("span", { class: "tool", text: t(sessionSubtitle(task.id)) }),
          );
          if (task.steps.length > 1) {
            who.append(h("span", {
              class: "count",
              text: `${Math.min(task.stepIndex + 1, task.steps.length)}/${task.steps.length}`,
            }));
          }
        }
        ticker.sync(task);
      } else if (task && task.id === SPOTIFY_ID) {
        // Its own card for every state: playing, idle, not installed.
        if (mode !== "spotify") {
          clear(leftBody);
          leftBody.append(spotifyCard.el);
          mode = "spotify";
          cardKey = "";
        }
        spotifyCard.sync();
      } else if (task && task.id === MAIL_ID) {
        if (mode !== "mail") {
          clear(leftBody);
          leftBody.append(mailCard.el);
          mode = "mail";
          cardKey = "";
        }
        mailCard.sync();
      } else if (task && task.id === WHATSAPP_ID) {
        // Its own card in every state: not linked, no message, conversations, one open.
        if (mode !== "whatsapp") {
          clear(leftBody);
          leftBody.append(whatsappCard.el);
          mode = "whatsapp";
          cardKey = "";
        }
        whatsappCard.sync();
      } else if (task) {
        const info = State.integrations[task.id];
        const key = [
          language(), task.id, task.color, detailOpen, task.state, task.steps.join("|"),
          info?.loaded, info?.error, info?.configured,
          JSON.stringify(info?.data ?? {}),
        ].join("~");
        if (key !== cardKey) {
          cardKey = key;
          mode = "card";
          clear(leftBody);
          leftBody.append(renderIntegrationCard(task, hooks));
        }
      }

      jump.style.display = detailOpen || mode === "plan" || mode === "diff" ? "none" : "";

      // Ctrl+↓ Ctrl+↑ walk the open GitHub list (cardItemCount / cardSelection).
      const rows = mode === "card" ? listRows(leftBody) : [];
      State.cardItemCount = rows.length;
      if (State.cardSelection != null && State.cardSelection >= rows.length) State.cardSelection = null;
      highlightRow(rows, State.cardSelection, State.cardSelection !== shownSelection);
      shownSelection = State.cardSelection;

      // Six pills is two columns of three, which is what the card has room for.
      // A seventh becomes "and N more" in the sixth cell rather than a row that
      // would be cut off at the card's edge.
      const MAX_PILLS = 6;
      const shown = others.length > MAX_PILLS ? others.slice(0, MAX_PILLS - 1) : others;
      const extra = others.length - shown.length;
      const pillKey = [
        ...shown.map((t) => `${t.id}:${t.color}:${t.pillBadge ?? ""}`),
        `+${extra}`,
      ].join("|");
      if (pillKey !== pillIds) {
        pillIds = pillKey;
        clear(pills);
        spotifyPill = null;
        for (const t of shown) {
          if (t.id === SPOTIFY_ID) {
            spotifyPill = buildSpotifyPill(t, () => actions.setFocus(t.id));
            pills.append(spotifyPill.el);
          } else {
            pills.append(buildPill(t, actions));
          }
        }
        if (extra > 0) {
          pills.append(
            h("div", {
              class: "pill pill-more",
              text: t("and {count} more", { count: extra }),
            }),
          );
        }
        pruneMiniBots();
      }
      spotifyPill?.sync();
    },
  };
}

/**
 * The session a card is about: the pill's own dialog, or the focused one.
 *
 * A dialog pill names its session in its id, so the card follows the pill the
 * person clicked rather than whichever session happens to be busiest.
 */
export function sessionOfTask(task: AgentTask): DshSession | null {
  const id = task.sessionId;
  const found = id ? sessionFor(Dsh.snapshot, id) : null;
  return found ?? activeSession(Dsh.snapshot);
}

/**
 * The tool's own card: the overview of everything DeepSeek Harness is doing.
 *
 * "Idle" on its own is a dead end, and a ticker on the tool's pill made the list
 * unreadable — the same pill was sometimes "DeepSeek Harness" and sometimes a
 * dialog's name. So this card is always the same thing:
 *
 * - while dialogs are running, who they are and what each is doing right now;
 * - when nothing runs, what ran last and how it ended;
 * - and in both cases how many windows are open, how many subagents are working
 *   inside them, and what today has cost.
 *
 * Every line comes from what DSH and the provider already reported.
 */
export function syncOverviewCard(
  task: AgentTask,
  who: HTMLElement,
  head: HTMLElement,
  lines: HTMLElement,
) {
  const summary = idleSummary(Dsh.snapshot);
  const busy = busyDialogs(Dsh.snapshot);
  clear(who);
  if (task.modelLine) who.append(h("span", { class: "tool", text: task.modelLine }));
  who.append(h("span", { class: "name", text: task.name }));

  clear(lines);
  const row = (text: string, quiet = false) =>
    lines.append(h("div", { class: quiet ? "idle-line quiet" : "idle-line", text }));

  if (busy.length > 0) {
    // What is running, in the same order the pills are in: waiting first.
    head.textContent = busy.length === 1 ? t("One dialog is working") : t("Dialogs are working");
    // Two dialogs at most: the card is a glance, and a third name would push the
    // summary underneath out of sight. Each gets two rows — the name, then what
    // it is doing — because one row made both of them half a word long.
    for (const session of busy.slice(0, 2)) {
      const name = sessionName(session) || t("Untitled dialog");
      const waiting = (Dsh.snapshot?.pending ?? []).some((p) => p.sessionId === session.id);
      const said = session.say?.trim();
      const doing = waiting
        ? said
          ? `${t("Waiting…")} · ${said}`
          : t("Waiting…")
        : said || stateWord(session.state);
      row(name);
      row(doing, true);
    }
    if (busy.length > 2) row(t("and {count} more", { count: busy.length - 2 }), true);
  } else if (summary?.lastTitle) {
    // Nothing is running: what ran last, how it ended and when, and its words.
    head.textContent = t("Resting");
    const age = summary.lastAt ? ageLabel(summary.lastAt) : "";
    const state = summary.lastState === "error" ? t("failed") : t("finished");
    row(`${summary.lastTitle} · ${state}${age ? ` ${age}` : ""}`);
    if (summary.lastLine) row(summary.lastLine, true);
  } else {
    head.textContent = t("Resting");
    row(t("Nothing has run yet in this session."), true);
  }

  // The summary is one line, not two: the card has room for a glance, and the
  // count of windows and today's spend belong on the same row.
  const parts = [t("Open: {count}", { count: summary?.dialogs ?? 0 })];
  if (summary?.subagents) parts.push(t("Subagents: {count}", { count: summary.subagents }));
  const spent = usageLine(Dsh.snapshot?.usage);
  if (spent) parts.push(`${t("Today")}: ${spent}`);
  row(parts.join(" · "), true);
}

/** One word for a session's state, for the overview's list. */
function stateWord(state: string | null | undefined): string {
  switch (state) {
    case "working":
      return t("Working…");
    case "thinking":
      return t("Thinking…");
    case "error":
      return t("The turn failed");
    default:
      return t("Waiting…");
  }
}

/**
 * The card's "now" line: what the session is doing, in words rather than a
 * truncated command.
 *
 * The agent's own sentence wins — "Добавлю тест на утечку — иначе она вернётся"
 * is what a person wants to read, while `cd 'C:\LocalAI\…'` is not. Without one
 * (a turn that has not spoken yet) the state says what it can, and the last
 * action fills the gap while it works. Nothing is invented for a finished turn:
 * the ticker below already holds what it did.
 */
export function nowLine(task: AgentTask): string | null {
  const said = task.sayLine?.trim();
  if (said) return said;
  switch (task.state) {
    case "thinking":
      return t("Thinking…");
    case "working": {
      const last = task.steps.at(-1)?.trim();
      return last || t("Working…");
    }
    case "error":
      return t("The turn failed");
    default:
      return null;
  }
}

/**
 * IntegrationCardView.agentSessionActive: a workspace tool or an agent — or
 * any other tagged agent — with something going on.
 */export function hasSessionTicker(task: AgentTask): boolean {
  // A pill made for an agent's session (Gemini CLI, Codex… not declared) only
  // exists while that session does: it keeps the ticker from the first event.
  if (task.source === "agent" && !task.isIntegration) return true;
  const category = pillDefinition(task.id)?.category;
  const isSession = category === "workspace" || category === "agent" ||
    (category == null && task.id.startsWith("agent_"));
  return isSession && (task.state !== "idle" || task.steps.length > 0);
}

function buildPill(task: AgentTask, actions: ViewActions): HTMLElement {
  const label = task.id === "integration_claude" ? pillDefinition(task.id)!.name : task.name;
  const canvas = createMiniBot(task, 24);
  const pill = h(
    "div",
    { class: "pill", onclick: () => actions.setFocus(task.id) },
    canvas,
    h("span", { class: "lbl", text: label }),
  );
  // The label is cut by the layout, never by the model, so a wide pill shows the
  // whole name. When it still does not fit, the full one is a hover away.
  pill.title = label;
  pill.style.borderColor = `${task.color}24`;
  pill.addEventListener("mouseenter", () => {
    pill.style.background = `${task.color}2e`;
    pill.style.borderColor = `${task.color}8c`;
    pill.style.boxShadow = `0 2px 10px ${task.color}59`;
    (pill.querySelector(".lbl") as HTMLElement).style.color = lighten(task.color, 0.3);
  });
  pill.addEventListener("mouseleave", () => {
    pill.style.background = "";
    pill.style.borderColor = `${task.color}24`;
    pill.style.boxShadow = "";
    (pill.querySelector(".lbl") as HTMLElement).style.color = "";
  });

  if (task.pillBadge) {
    const colors = { approval: "#F5A524", finished: "#22C55E", error: "#F4505E" } as const;
    const icons = { approval: ICONS.bang, finished: ICONS.check, error: ICONS.xmark } as const;
    const inner = h("i", { style: `background:${colors[task.pillBadge]}` }, svg(icons[task.pillBadge], 6, { stroke: task.pillBadge === "finished" ? 3 : 0 }));
    const badge = h("div", { class: "pill-badge" }, inner);
    badge.style.boxShadow = `0 0 4px ${colors[task.pillBadge]}99`;
    pill.append(badge);
  }
  return pill;
}

function lighten(hex: string, amount: number): string {
  const v = parseInt(hex.replace("#", ""), 16);
  const c = [(v >> 16) & 255, (v >> 8) & 255, v & 255].map((x) =>
    Math.min(255, Math.round(x + amount * 255)),
  );
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

// ── Empty ─────────────────────────────────────────────────────────────────────

function buildEmpty(actions: ViewActions): ViewHost {
  const body = h(
    "div",
    { class: "stack", style: "padding:0 18px 0 118px;flex-direction:row;align-items:center;gap:16px" },
    h(
      "div",
      { style: "display:flex;flex-direction:column;gap:5px" },
      h("div", { class: "title", text: tl("Nothing running right now.") }),
      h("div", { class: "sub", text: tl("Drop a file or window, or ask me anything.") }),
    ),
    h("div", { class: "grow" }),
    btn(tl("Ask Claude"), "primary", () => actions.setView("prompt")),
  );
  return { el: h("div", { class: "view" }, card(null, body)), sync() {} };
}

// ── Approval ──────────────────────────────────────────────────────────────────

/** How long a fresh permission card ignores clicks on its buttons. */
const CLICK_GUARD_MS = 600;

/**
 * The ⌃ in the corner of a waiting card: folds the island to its compact size
 * and leaves the request waiting — nothing is answered (Mac #290). Opening the
 * island again brings the card back.
 */
function foldButton(actions: ViewActions): HTMLElement {
  return h(
    "button",
    { class: "icon-btn fold", title: tl("Later — keep it waiting"), onclick: () => actions.foldApproval() },
    svg(ICONS.chevronUp, 8, { stroke: 2.4 }),
  );
}

function buildApproval(actions: ViewActions): ViewHost {
  const who = h("div");
  const code = h("div", { class: "code" });
  // The files a request touches, one per line. Empty (and hidden) for the
  // relay's cards, which show everything in the single code line.
  const files = h("div", { class: "code dsh-files" });
  // How long DSH will keep the question open. Display only: reaching zero
  // answers nothing — the host hands the request to its own prompt.
  const countdown = h("span", { class: "approval-countdown" });
  const cardNote = h("div", { class: "approval-note" });
  const row = h("div", { class: "actions" });
  const el = h("div", { class: "view" },
    card("amber", stack(116, 16, who, code, files, row, cardNote, countdown), foldButton(actions)));
  let rowKey = "";
  // The card pops up under a cursor that was busy with something else: a click
  // meant for the window underneath must not land on Allow. Clicks in the first
  // moments after a new request appears are ignored.
  let shownFor: string | null = null;
  let shownAt = 0;
  let countdownTimer: number | null = null;
  let drawnNote = "";
  const guarded = (d: "allow" | "deny") => () => {
    if (performance.now() - shownAt < CLICK_GUARD_MS) return;
    actions.decide(d);
  };
  const guardedTerminal = () => {
    if (performance.now() - shownAt < CLICK_GUARD_MS) return;
    actions.answerInTerminal();
  };
  /** Redraws the remaining time. It never answers anything. */
  const tickCountdown = () => {
    const expiresAt = State.pendingApproval?.expiresAt ?? null;
    if (!expiresAt) {
      countdown.style.display = "none";
      return;
    }
    countdown.style.display = "";
    const left = Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
    countdown.textContent = left > 0 ? `${left}s` : "";
    countdown.classList.toggle("soon", left <= 10);
  };
  return {
    el,
    sync() {
      const req = State.pendingApproval?.requestId ?? null;
      if (req !== shownFor) {
        shownFor = req;
        shownAt = performance.now();
        // One timer per card, not one per sync: sync runs on every notify.
        if (countdownTimer !== null) clearInterval(countdownTimer);
        countdownTimer = req ? window.setInterval(tickCountdown, 1000) : null;
      }
      tickCountdown();
      clear(who);
      who.append(agentWho(State.focusTask, t("needs permission")));
      // The whole point of approving here rather than in the terminal: this line
      // is the command, the file path or the URL being authorised, not just the
      // name of the tool asking.
      code.textContent = State.pendingApproval?.command || State.pendingApproval?.tool || "…";
      const touched = State.pendingApproval?.files ?? [];
      files.style.display = touched.length ? "" : "none";
      // One line: the card is the island's height, so the list truncates and
      // the whole of it stays in the tooltip.
      files.textContent = touched.join("  ·  ");
      files.title = touched.join("\n");
      // "Open DSH" that could not raise a window says so here, and the request
      // stays on the card rather than going somewhere invisible.
      const note = State.pendingApproval?.note ?? "";
      if (note !== drawnNote) {
        drawnNote = note;
        cardNote.textContent = note;
        cardNote.style.display = note ? "" : "none";
      }
      // The buttons are built once per kind of request. Rebuilding them between
      // a mouse-down and a mouse-up would swallow the click, and there is
      // nothing else to vary: "Always" is gone until the remembered-rules list
      // exists to back it.
      const key = State.pendingApproval?.source === "dsh" ? "dsh" : "hook";
      if (rowKey === key) return;
      rowKey = key;
      clear(row);
      row.append(
        btn(tl("Deny"), "secondary", guarded("deny"), "N"),
        btn(tl("Allow"), "primary", guarded("allow"), "Y"),
        // DSH's own prompt is the third answer: the question goes back to the
        // app that asked it, unanswered.
        ...(key === "dsh"
          ? [btn(tl("Open DSH"), "secondary", guardedTerminal, "O")]
          : []),
      );
    },
  };
}

// ── Question ──────────────────────────────────────────────────────────────────

function buildQuestion(actions: ViewActions): ViewHost {
  const who = h("div");
  const title = h("div", { class: "title question-text" });
  const row = h("div", { class: "actions options" });
  const fold = foldButton(actions);
  const el = h("div", { class: "view" }, card("cyan", stack(116, 16, who, title, row), fold));

  // Where we are in the request on screen: which question, what is answered so
  // far, and what is ticked in a pick-several question.
  let requestId = "";
  let index = 0;
  let answers: Record<string, string | string[]> = {};
  let picked = new Set<string>();
  // The buttons are only rebuilt when what they show changes: rebuilding them
  // between a mouse-down and a mouse-up would swallow the click.
  let rowKey = "";

  const next = (question: string, answer: string | string[], total: number) => {
    answers[question] = answer;
    picked = new Set();
    index += 1;
    if (index >= total) actions.answer(answers);
    else State.notify();
  };

  return {
    el,
    sync() {
      const questions = State.pendingApproval?.questions;
      clear(who);
      // Only a request that is waiting can be folded away and come back.
      fold.style.display = State.pendingApproval ? "" : "none";

      // A question that arrived as a notification has nothing to pick from.
      if (!questions) {
        who.append(agentWho(State.focusTask, t("is asking a question")));
        const task = State.focusTask;
        title.textContent = (task && lastTextStep(task.steps)) ?? t("Claude needs an answer.");
        if (rowKey !== "terminal") {
          rowKey = "terminal";
          clear(row);
          row.append(h("div", { class: "sub", text: tl("Answer it in your terminal.") }));
        }
        return;
      }

      if (State.pendingApproval!.requestId !== requestId) {
        requestId = State.pendingApproval!.requestId;
        index = 0;
        answers = {};
        picked = new Set();
      }
      const q = questions[Math.min(index, questions.length - 1)];
      const asking = questions.length > 1
        ? t("is asking ({index} of {total})", { index: index + 1, total: questions.length })
        : t("is asking");
      who.append(agentWho(State.focusTask, asking));
      title.textContent = q.question;
      title.title = q.question;

      const key = `${requestId}:${index}:${[...picked].join("|")}`;
      if (rowKey === key) return;
      rowKey = key;
      clear(row);
      for (const option of q.options) {
        const on = picked.has(option.label);
        const button = btn(option.label, on ? "primary" : "secondary", () => {
          if (!q.multiSelect) {
            next(q.question, option.label, questions.length);
            return;
          }
          if (on) picked.delete(option.label);
          else picked.add(option.label);
          State.notify();
        });
        if (option.description) button.title = option.description;
        row.append(button);
      }
      if (q.multiSelect) {
        const done = btn(tl("Done"), "primary", () => {
          if (picked.size > 0) next(q.question, [...picked], questions.length);
        });
        if (picked.size === 0) done.classList.add("off");
        row.append(done);
      }
      row.append(
        h("button", {
          class: "link-btn",
          style: "color:#8e939c",
          text: tl("Answer in terminal"),
          onclick: () => actions.answerInTerminal(),
        }),
      );
    },
  };
}

// ── Error ─────────────────────────────────────────────────────────────────────

function buildError(actions: ViewActions): ViewHost {
  const who = h("div");
  const title = h("div", { class: "title" });
  const detail = h("div", { class: "detail" });
  const row = h("div", { class: "actions" },
    btn(tl("Retry"), "primary", () => actions.setView(State.defaultView())),
    btn(tl("Open in n8n"), "secondary", () => actions.openUrl("")),
  );
  const el = h("div", { class: "view" }, card("red", stack(116, 16, who, title, detail, row)));
  return {
    el,
    sync() {
      const task = State.focusTask;
      clear(who);
      // agentWho already shows an agent's name: its label is just the kind.
      const whoLabel = task?.source === "n8n" ? "n8n" : task?.source === "agent" ? t("Agent") : "Claude Code";
      who.append(agentWho(task, whoLabel));
      title.textContent = task?.source === "n8n" ? t("Workflow stopped.") : t("Session stopped on an error.");
      detail.textContent = (task && lastTextStep(task.steps)) ?? t("No detail available.");
    },
  };
}

// ── Finished ──────────────────────────────────────────────────────────────────

function buildFinished(actions: ViewActions): ViewHost {
  const who = h("div");
  const title = h("div", { class: "title one-line" });
  const open = btn(tl("Open terminal"), "primary", () => actions.openTerminal());
  const row = h("div", { class: "actions" },
    open,
    btn(tl("OK"), "secondary", () => actions.collapse()),
  );
  const el = h("div", { class: "view" }, card("green", stack(116, 16, who, title, row)));
  return {
    el,
    sync() {
      clear(who);
      const agent = State.focusTask?.source === "agent";
      who.append(agentWho(State.focusTask, agent ? t("finished") : t("Claude Code finished")));
      // The final message, else the last step that is not a diff (FinishedView).
      const task = State.focusTask;
      title.textContent = task?.finalLine || (task && lastTextStep(task.steps)) || t("Session finished");
      // Sessions from the Claude desktop app live there, not in a terminal; DSH
      // is a window of its own. Saying "Open terminal" for either would send
      // the user looking for something that does not exist.
      const label =
        task?.id === "agent_claude-desktop"
          ? t("Open Claude")
          : task?.id === "dsh"
            ? t("Open DeepSeek Harness")
            : t("Open terminal");
      const span = open.firstElementChild as HTMLElement;
      if (span.textContent !== label) span.textContent = label;
    },
  };
}

// ── Confused ──────────────────────────────────────────────────────────────────

function buildConfused(): ViewHost {
  const body = h(
    "div",
    { class: "stack", style: "padding:0 18px 0 128px" },
    h("div", { class: "title", text: tl("Too many hits at once.") }),
    h("div", { class: "sub", text: tl("Give me a sec — back to work in three seconds.") }),
  );
  return { el: h("div", { class: "view" }, card("pink", body)), sync() {} };
}

// ── Note ──────────────────────────────────────────────────────────────────────

function buildNote(): ViewHost {
  const title = h("div", { class: "title" });
  const el = h("div", { class: "view" }, card(null, h("div", { class: "stack", style: "padding:0 18px 0 98px" }, title)));
  return {
    el,
    sync() {
      title.textContent = State.noteMessage ?? "";
    },
  };
}

// ── In-island settings ────────────────────────────────────────────────────────

function buildSettings(actions: ViewActions): ViewHost {
  const soundSwitch = h("button", { class: "switch", onclick: () => actions.toggleSound() });
  const volume = h("input", {
    type: "range", min: "0", max: "0.2", step: "0.005",
    oninput: (e: Event) => actions.setVolume(Number((e.target as HTMLInputElement).value)),
  }) as HTMLInputElement;
  const autoLabel = h("span", {});
  const segButtons = [10, 15, 30].map((s) =>
    h("button", { onclick: () => actions.setAutoClose(s) }, `${s}s`),
  );
  const claudeBadge = h("span", { class: "status-badge" });
  const apiBadge = h("span", { class: "status-badge" });

  const rows = h(
    "div",
    { class: "settings-rows" },
    h("div", { class: "settings-row" }, soundSwitch, h("span", { text: tl("Sound") }), volume),
    h(
      "div",
      { class: "settings-row" },
      svg(ICONS.timer, 12),
      autoLabel,
      h("div", { class: "seg" }, ...segButtons),
    ),
    h(
      "div",
      { class: "settings-row", style: "gap:14px" },
      claudeBadge,
      apiBadge,
      h("div", { class: "grow" }),
      h("button", {
        class: "link-btn",
        style: "color:#8e939c;font-size:11.5px",
        text: tl("Settings…"),
        onclick: () => actions.openSettingsWindow(),
      }),
    ),
  );

  const el = h("div", { class: "view" },
    card(null, h("div", { class: "stack", style: "padding:14px 16px 14px 84px" }, rows)));

  return {
    el,
    sync() {
      const s = State.settings;
      soundSwitch.classList.toggle("on", s.soundEnabled);
      volume.value = String(s.soundVolume);
      volume.style.opacity = s.soundEnabled ? "1" : "0.4";
      autoLabel.textContent = t("Auto-close · {seconds}s", { seconds: Math.round(s.autoCloseInterval) });
      segButtons.forEach((b, i) => b.classList.toggle("on", s.autoCloseInterval === [10, 15, 30][i]));
      clear(claudeBadge);
      claudeBadge.append(
        dot(s.hooksInstalled ? "#22C55E" : "#F4505E", 6),
        h("span", { text: "Claude Code" }),
      );
      clear(apiBadge);
      apiBadge.append(dot("#F4505E", 6), h("span", { text: "API" }));
    },
  };
}

// ── Placeholders filled in later stages ───────────────────────────────────────

function buildPlaceholder(title: Msg, sub: string): ViewHost {
  const body = h(
    "div",
    { class: "stack", style: "padding:0 18px 0 118px" },
    h("div", { class: "title", text: title }),
    h("div", { class: "sub", text: sub }),
  );
  return { el: h("div", { class: "view" }, card(null, body)), sync() {} };
}

// ── Registry ──────────────────────────────────────────────────────────────────

export function buildViews(
  actions: ViewActions,
  onChatHeightChange: () => void,
): Map<IslandViewName, ViewHost> {
  const map = new Map<IslandViewName, ViewHost>();
  map.set("overview", buildOverview(actions));
  map.set("empty", buildEmpty(actions));
  map.set("approval", buildApproval(actions));
  map.set("question", buildQuestion(actions));
  map.set("error", buildError(actions));
  map.set("finished", buildFinished(actions));
  map.set("confused", buildConfused());
  map.set("note", buildNote());
  map.set("settings", buildSettings(actions));
  map.set("prompt", buildPrompt(onChatHeightChange));
  map.set("upload", buildUpload());
  map.set("uploading", buildUploading());
  map.set("choose", buildChoose(actions));
  map.set("recap", buildRecap(actions));
  map.set("wardrobe", buildWardrobe(actions));
  map.set("model", buildModel(actions));
  map.set("spend", buildSpend(actions));
  map.set("update", buildUpdate());
  map.set("whatsNew", buildWhatsNew());
  // Not in the Windows v1: sending a file by email, window attach + web result.
  map.set("mail", buildPlaceholder(tl("Sending by email isn't in this version."), ""));
  map.set("searching", buildPlaceholder(tl("Claude is searching…"), ""));
  map.set("result", buildPlaceholder(tl("Result"), ""));
  return map;
}
