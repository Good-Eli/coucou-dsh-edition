// Settings → DeepSeek Harness: install the bridge, or take it out.
//
// The bridge is a plugin the DSH host loads. Installing it writes the modules
// and adds one entry to the DSH profile; DSH picks it up the next time it
// starts. Nothing here touches any other part of that profile, and every change
// keeps a dated backup beside it.
import { Bridge } from "../core/bridge";
import { h } from "../views/dom";
import { t } from "../i18n/i18n";

interface PluginStatus {
  installed: boolean;
  profile: string | null;
  pluginDir: string;
  connected: boolean;
  problem: string | null;
}

export function dshBridgeSection(): HTMLElement {
  const badge = h("span", { class: "status-badge" });
  const detail = h("div", { class: "hint" });
  // Both buttons say what they do. Unlabelled they were two blank rectangles,
  // and the harmless-looking one on the right was the one that switched the
  // bridge off — which reads as "the approvals stopped working" and gives no
  // hint that a click caused it.
  const install = h("button", { class: "primary", text: t("Install the bridge") });
  const remove = h("button", { text: t("Remove the bridge") });
  const actions = h("div", { class: "row" }, install, remove);
  let busy = false;
  // Removing the bridge stops every approval from reaching the island, so it
  // takes two clicks: the first only asks.
  let confirming = false;
  let confirmTimer: number | null = null;

  const disarm = () => {
    if (confirmTimer !== null) clearTimeout(confirmTimer);
    confirmTimer = null;
    confirming = false;
    remove.textContent = t("Remove the bridge");
    remove.classList.remove("danger");
  };

  const onRemove = () => {
    if (!confirming) {
      // Ask first, and say what is lost: this is the difference between a
      // button that tidies up and a button that quietly disables approvals.
      confirming = true;
      remove.textContent = t("Approvals stop working. Remove anyway?");
      remove.classList.add("danger");
      confirmTimer = window.setTimeout(disarm, 6000);
      return;
    }
    disarm();
    void act(false);
  };

  install.onclick = () => void act(true);
  remove.onclick = onRemove;

  function paint(s: PluginStatus | null) {
    if (!s) {
      badge.textContent = t("Unknown");
      badge.className = "status-badge off";
      install.style.display = "";
      remove.style.display = "none";
      return;
    }
    if (s.connected) {
      badge.textContent = t("Connected");
      badge.className = "status-badge on";
    } else if (s.installed) {
      badge.textContent = t("Installed, DSH not running");
      badge.className = "status-badge off";
    } else {
      badge.textContent = t("Not installed");
      badge.className = "status-badge off";
    }
    // A missing profile is not something a button can fix, so say what is
    // wrong instead of offering an action that will fail.
    if (s.problem) {
      detail.textContent = s.problem;
      actions.style.display = "none";
      return;
    }
    actions.style.display = "";
    install.style.display = s.installed ? "none" : "";
    remove.style.display = s.installed ? "" : "none";
    detail.textContent = s.installed
      ? t("Restart DeepSeek Harness to load the bridge.")
      : t("Without it, DSH asks for permissions in its own window.");
  }

  async function act(want: boolean) {
    if (busy) return;
    busy = true;
    install.disabled = true;
    remove.disabled = true;
    try {
      const s = want ? await Bridge.dshPluginInstall() : await Bridge.dshPluginRemove();
      paint(s as PluginStatus);
    } catch (error) {
      // Never claim success: a failed edit says so, and the badge keeps the
      // state it actually had.
      detail.textContent = String(error);
    } finally {
      busy = false;
      install.disabled = false;
      remove.disabled = false;
    }
  }

  void Bridge.dshPluginStatus()
    .then((s) => paint(s))
    .catch(() => paint(null));

  return h(
    "div",
    { class: "section" },
    h("h2", { text: t("DeepSeek Harness") }),
    h(
      "div",
      { class: "settings-row" },
      badge,
      h("div", { class: "grow" }, h("span", { text: t("Coucou bridge") }), detail),
      actions,
    ),
  );
}
