// A stand-in for the object Tauri injects into the webview. The island talks to
// Rust through it, so the tests see every command the island sends and can fire
// the events Rust would emit — through the real bridge, with no source changes.

/** Every command the island invoked, oldest first: [name, args]. */
export const calls = [];

const listeners = new Map();
const replies = new Map();

/**
 * What a command answers. Without one a command answers null, which is what
 * most of them return; a command whose answer the island uses needs this.
 */
export function reply(cmd, value) {
  replies.set(cmd, value);
}

/** Forgets every stubbed answer. */
export function clearReplies() {
  replies.clear();
}

export const internals = {
  transformCallback: (callback) => callback,
  invoke: async (cmd, args) => {
    if (cmd === "plugin:event|listen") {
      listeners.set(args.event, args.handler);
      return listeners.size;
    }
    calls.push([cmd, args]);
    if (!replies.has(cmd)) return null;
    const value = replies.get(cmd);
    return typeof value === "function" ? value(args) : value;
  },
};

/** Fires an event the way the Rust side would. */
export function emit(event, payload) {
  const handler = listeners.get(event);
  if (!handler) throw new Error(`nothing listens to "${event}"`);
  handler({ event, id: 0, payload });
}

/** The commands invoked under one name, as a list of their arguments. */
export function sent(cmd) {
  return calls.filter(([name]) => name === cmd).map(([, args]) => args);
}
