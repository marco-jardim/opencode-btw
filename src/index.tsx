import type { TuiPluginModule, TuiPlugin } from "@opencode-ai/plugin/tui";
import { createSignal, Show, For } from "solid-js";
import { useKeyboard } from "@opentui/solid";

interface BtwState {
  visible: boolean;
  sessionID: string | null;
  question: string;
  parts: Array<{ type: string; text?: string }>;
  done: boolean;
}

const BORDER_TOP = "┌─ btw ─────────────────────────────────────────────┐";
const BORDER_BOT = "└───────────────────────────────────────────────────┘";

const tui: TuiPlugin = async (api) => {
  const [state, setState] = createSignal<BtwState>({
    visible: false,
    sessionID: null,
    question: "",
    parts: [],
    done: false,
  });

  let pollTimer: ReturnType<typeof setInterval> | null = null;

  function cleanup() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  async function dismiss() {
    const s = state();
    cleanup();
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

  async function ask(question: string, parentSessionID: string) {
    if (state().visible) await dismiss();

    setState({
      visible: true,
      sessionID: null,
      question,
      parts: [],
      done: false,
    });

    try {
      const session = await api.client.session.create({
        parentID: parentSessionID,
      });
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

      pollTimer = setInterval(() => {
        const msgs = api.state.session.messages(sessionID);
        if (!msgs) return;
        const last = [...msgs]
          .reverse()
          .find((m: any) => m.role === "assistant");
        if (!last) return;

        const msgParts = api.state.part(last.id);
        if (!msgParts) return;

        const textParts = [...msgParts]
          .filter((p: any) => p.type === "text" && p.text)
          .map((p: any) => ({ type: "text", text: p.text as string }));

        setState((s) => ({ ...s, parts: textParts }));

        const status = api.state.session.status(sessionID);
        if (!status || status.type === "idle") {
          setState((s) => ({ ...s, done: true }));
          cleanup();
        }
      }, 200);
    } catch {
      setState((s) => ({ ...s, visible: false }));
    }
  }

  api.command.register(() => [
    {
      title: "/btw — Ask a quick question",
      value: "btw",
      description: "Ask a quick question without interrupting your session",
      category: "General",
      slash: { name: "btw" },
      onSlashSubmit(args: string) {
        if (!args.trim()) return false;
        const route = api.route.current;
        if (route.name !== "session" || !route.params) return false;
        const sessionID = route.params.sessionID as string;
        ask(args.trim(), sessionID);
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

        useKeyboard((evt) => {
          if (!s().visible) return;
          if (evt.name === "escape") {
            evt.stopPropagation();
            dismiss();
          }
        });

        return (
          <Show when={s().visible}>
            <box flexShrink={0} paddingLeft={1} paddingRight={1} marginTop={1}>
              <text fg={theme().textMuted}>{BORDER_TOP}</text>
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
              <text fg={theme().textMuted}>{BORDER_BOT}</text>
            </box>
          </Show>
        );
      },
    },
  });
};

const plugin: TuiPluginModule = { tui };
export default plugin;
