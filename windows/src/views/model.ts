// The model picker: what DSH is running, and what it could run next.
//
// Everything here comes from the catalog DSH published — no model names are
// written down in this app, and a model that reports no reasoning efforts
// offers none. The header shows the selection the host confirmed, never the
// one that was asked for.

import { h } from "./dom";
import {
  Dsh,
  activeSession,
  choiceFor,
  effortsFor,
  modelChoices,
  selectionLine,
  type DshSession,
} from "../core/dsh";
import { DshConfig } from "../island/dsh";
import { language, t } from "../i18n/i18n";
import type { ViewActions, ViewHost } from "./views";

/** "Provider default" — the bridge reads an empty value as "no effort set". */
const DEFAULT_EFFORT = "";

export function buildModel(actions: ViewActions): ViewHost {
  const who = h("div", { class: "model-who" });
  const note = h("div", { class: "model-note" });
  const models = h("div", { class: "model-list" });
  const efforts = h("div", { class: "model-efforts" });

  const el = h(
    "div",
    { class: "view model" },
    h(
      "div",
      { class: "card" },
      h(
        "div",
        { class: "stack model-stack" },
        who,
        models,
        h("div", { class: "model-efforts-head", text: t("Reasoning effort") }),
        efforts,
        note,
      ),
    ),
  );

  // Rows are rebuilt only when what they would show changes: a click that
  // lands between a mouse-down and a mouse-up must not be swallowed.
  let modelsKey = "";
  let effortsKey = "";
  let drawnNote = "";

  const session = (): DshSession | null => activeSession(Dsh.snapshot);

  const buildModels = (current: DshSession | null) => {
    const catalog = Dsh.snapshot?.catalog;
    const choices = modelChoices(catalog);
    const selected = current?.model;
    const key = JSON.stringify([
      language(),
      choices.map((c) => [c.provider, c.model, c.name, c.efforts.map((e) => e.id)]),
      selected?.provider,
      selected?.model,
    ]);
    if (key === modelsKey) return;
    modelsKey = key;
    models.replaceChildren();

    if (choices.length === 0) {
      models.append(h("div", { class: "model-empty", text: t("No models reported by DSH") }));
      return;
    }

    for (const choice of choices) {
      const isCurrent = selected?.provider === choice.provider && selected?.model === choice.model;
      const row = h(
        "button",
        { class: `model-row${isCurrent ? " on" : ""}` },
        h("span", { class: "model-name", text: choice.name }),
        h("span", { class: "model-provider", text: choice.providerName }),
      );
      row.addEventListener("click", () => {
        if (!current) return;
        actions.chooseDshModel(current.id, choice.provider, choice.model);
      });
      models.append(row);
    }
  };

  const buildEfforts = (current: DshSession | null) => {
    const catalog = Dsh.snapshot?.catalog;
    const selection = current?.model ?? null;
    // Only this model's own efforts: the list belongs to the model, not to the
    // provider and certainly not to a guess.
    const available = effortsFor(catalog, selection);
    const chosen = selection?.reasoningEffort ?? DEFAULT_EFFORT;
    const key = JSON.stringify([language(), available.map((e) => [e.id, e.name]), chosen]);
    if (key === effortsKey) return;
    effortsKey = key;
    efforts.replaceChildren();

    if (available.length === 0) {
      efforts.append(h("div", { class: "model-empty", text: t("This model has no reasoning effort") }));
      return;
    }

    // "Provider default" is always offered: it is how a model with a default
    // effort is put back to whatever its provider decides.
    const options = [{ id: DEFAULT_EFFORT, name: t("Provider default") }, ...available];
    for (const option of options) {
      const isCurrent = chosen === option.id;
      const row = h(
        "button",
        { class: `model-chip${isCurrent ? " on" : ""}`, text: option.name },
      );
      row.addEventListener("click", () => {
        if (!current) return;
        actions.chooseDshEffort(current.id, option.id);
      });
      efforts.append(row);
    }
  };

  return {
    el,
    sync() {
      const current = session();
      const catalog = Dsh.snapshot?.catalog;
      const choice = choiceFor(catalog, current?.model);

      who.textContent = current ? selectionLine(catalog, current.model) : t("No active session");

      // The note is the honest part: a change made while a turn runs belongs to
      // the next request, and DSH's own projection says so too.
      const text = DshConfig.error
        ? DshConfig.error
        : DshConfig.pending
          ? t("Applying…")
          : DshConfig.appliesNext && current?.state && current.state !== "idle" && current.state !== "finished"
            ? t("Applies to the next request")
            : choice && choice.efforts.length === 0
              ? t("This model has no reasoning effort")
              : "";
      if (text !== drawnNote) {
        drawnNote = text;
        note.textContent = text;
        note.classList.toggle("bad", Boolean(DshConfig.error));
      }

      buildModels(current);
      buildEfforts(current);
    },
  };
}
