import type { TuiPluginModule, TuiPlugin } from "@opencode-ai/plugin/tui";
import type { AssistantMessage, Message } from "@opencode-ai/sdk/v2";
import { createSignal, createEffect, Show, For, onCleanup } from "solid-js";
import { useKeyHandler, useTerminalDimensions } from "@opentui/solid";

interface BtwState {
  visible: boolean;
  sessionID: string | null;
  question: string;
  parts: Array<{ type: string; text?: string }>;
  done: boolean;
}

const tui: TuiPlugin = async (api) => {
  const [state, setState] = createSignal<BtwState>({
    visible: false,
    sessionID: null,
    question: "",
    parts: [],
    done: false,
  });

  let pendingOp: Promise<void> = Promise.resolve();

  async function dismiss() {
    const s = state();
    if (s.sessionID) {
      try {
        if (!s.done) {
          await api.client.session.abort({ sessionID: s.sessionID });
        }
        await api.client.session.delete({ sessionID: s.sessionID });
      } catch {
        // best effort
      }
    }
    setState({
      visible: false,
      sessionID: null,
      question: "",
      parts: [],
      done: false,
    });
  }

  function safeDismiss() {
    pendingOp = pendingOp.then(() => dismiss());
    return pendingOp;
  }

  async function ask(question: string) {
    if (state().visible) await dismiss();

    setState({
      visible: true,
      sessionID: null,
      question,
      parts: [],
      done: false,
    });

    try {
      const session = await api.client.session.create({});
      if (!session.data) {
        setState((s) => ({ ...s, visible: false }));
        return;
      }

      const sessionID = session.data.id;
      setState((s) => ({ ...s, sessionID }));

      await api.client.session.prompt({
        sessionID,
        parts: [{ type: "text" as const, text: question }],
      });
    } catch {
      setState((s) => ({ ...s, visible: false }));
    }
  }

  function safeAsk(question: string) {
    pendingOp = pendingOp.then(() => ask(question));
    return pendingOp;
  }

  api.command.register(() => [
    {
      title: "/btw — Ask a quick question",
      value: "btw",
      description: "Ask a quick question without interrupting your session",
      category: "General",
      hidden: true,
      slash: { name: "btw" },
      onSlashSubmit(args: string) {
        if (!args.trim()) return false;
        const route = api.route.current;
        if (route.name !== "session" || !route.params) return false;
        safeAsk(args.trim());
        return true;
      },
    },
  ]);

  api.slots.register({
    order: 200,
    slots: {
      session_above_prompt(_ctx, _props) {
        const theme = () => api.theme.current;
        const s = state;
        const dims = useTerminalDimensions();
        const borderWidth = () =>
          Math.max(20, Math.min(60, (dims().width ?? 80) - 4));
        const borderTop = () =>
          "┌─ btw " + "─".repeat(Math.max(0, borderWidth() - 8)) + "┐";
        const borderBot = () =>
          "└" + "─".repeat(Math.max(0, borderWidth() - 2)) + "┘";

        createEffect(() => {
          const sid = s().sessionID;
          if (!sid) return;

          const msgs = api.state.session.messages(sid);
          if (!msgs) return;

          const last = [...msgs]
            .reverse()
            .find(
              (m: Message): m is AssistantMessage => m.role === "assistant",
            );
          if (!last) return;

          const msgParts = api.state.part(last.id);
          if (!msgParts) return;

          const textParts = [...msgParts]
            .filter((p) => p.type === "text" && "text" in p)
            .map((p) => ({
              type: "text" as const,
              text: String((p as any).text ?? ""),
            }));

          setState((prev) => ({ ...prev, parts: textParts }));

          const status = api.state.session.status(sid);
          if (!status || status.type === "idle") {
            setState((prev) => ({ ...prev, done: true }));
          }
        });

        onCleanup(() => {
          dismiss();
        });

        useKeyHandler((evt) => {
          if (evt.defaultPrevented) return;
          if (!s().visible) return;
          if (evt.name === "escape") {
            evt.stopPropagation();
            safeDismiss();
          }
        });

        return (
          <Show when={s().visible}>
            <box flexShrink={0} paddingLeft={1} paddingRight={1} marginTop={1}>
              <text fg={theme().textMuted}>{borderTop()}</text>
              <box paddingLeft={2} paddingRight={2}>
                <text fg={theme().accent}>
                  <b>Q:</b> {s().question}
                </text>
                <Show
                  when={s().parts.length > 0}
                  fallback={<text fg={theme().textMuted}>thinking...</text>}
                >
                  <text>{""}</text>
                  <For each={s().parts}>
                    {(part) => <text fg={theme().text}>{part.text ?? ""}</text>}
                  </For>
                </Show>
                <Show when={s().done}>
                  <text>{""}</text>
                  <text fg={theme().textMuted}>press Esc to dismiss</text>
                </Show>
              </box>
              <text fg={theme().textMuted}>{borderBot()}</text>
            </box>
          </Show>
        );
      },
    },
  });
};

const plugin: TuiPluginModule = { tui };
export default plugin;
