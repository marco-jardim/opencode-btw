/** @jsxImportSource @opentui/solid */
import type { TuiPluginModule, TuiPlugin } from "@opencode-ai/plugin/tui";
import type { AssistantMessage, Message } from "@opencode-ai/sdk/v2";
import { createSignal, createEffect, Show, For, onCleanup } from "solid-js";
import { useKeyboard, useTerminalDimensions } from "@opentui/solid";

const tui: TuiPlugin = async (api) => {
  const [visible, setVisible] = createSignal(false);
  const [question, setQuestion] = createSignal("");
  const [parts, setParts] = createSignal<Array<{ text: string }>>([]);
  const [done, setDone] = createSignal(false);
  const [sessionID, setSessionID] = createSignal<string | null>(null);

  let pendingOp: Promise<void> = Promise.resolve();

  function reset() {
    setVisible(false);
    setQuestion("");
    setParts([]);
    setDone(false);
    setSessionID(null);
  }

  async function dismiss() {
    setVisible(false);
    const sid = sessionID();
    reset();
    if (sid) {
      try {
        await api.client.session.abort({ sessionID: sid }).catch(() => {});
        await api.client.session.delete({ sessionID: sid }).catch(() => {});
      } catch {}
    }
  }

  async function ask(q: string) {
    if (visible()) await dismiss();

    setVisible(true);
    setQuestion(q);
    setParts([]);
    setDone(false);
    setSessionID(null);

    try {
      const session = await api.client.session.create({});
      if (!session.data) {
        reset();
        return;
      }

      const sid = session.data.id;
      setSessionID(sid);

      await api.client.session.prompt({
        sessionID: sid,
        parts: [{ type: "text" as const, text: q }],
      });
    } catch {
      reset();
    }
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
        pendingOp = pendingOp.then(() => ask(args.trim()));
        return true;
      },
    },
  ]);

  api.slots.register({
    order: 200,
    slots: {
      session_above_prompt(_ctx, _props) {
        const theme = () => api.theme.current;
        const dims = useTerminalDimensions();

        // session container: paddingLeft=2 + paddingRight=2 = 4
        // our box: paddingLeft=1 + paddingRight=1 = 2
        // total padding: 6, plus 2 for border chars = 8
        const borderWidth = () => Math.max(20, (dims().width ?? 80) - 8);
        const borderTop = () =>
          "┌─ btw " + "─".repeat(Math.max(0, borderWidth() - 8)) + "┐";
        const borderBot = () =>
          "└" + "─".repeat(Math.max(0, borderWidth() - 2)) + "┘";

        createEffect(() => {
          const sid = sessionID();
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
            .map((p) => ({ text: String((p as any).text ?? "") }));

          setParts(textParts);

          const status = api.state.session.status(sid);
          if (!status || status.type === "idle") {
            setDone(true);
          }
        });

        useKeyboard((evt) => {
          if (!visible()) return;
          if (evt.ctrl && evt.name === "b") {
            evt.preventDefault();
            evt.stopPropagation();
            dismiss();
          }
        });

        return (
          <Show when={visible()}>
            <box flexShrink={0} paddingLeft={1} paddingRight={1} marginTop={1}>
              <text fg={theme().textMuted}>{borderTop()}</text>
              <box paddingLeft={2} paddingRight={2}>
                <text fg={theme().accent}>
                  <b>Q:</b> {question()}
                </text>
                <Show
                  when={parts().length > 0}
                  fallback={<text fg={theme().textMuted}>thinking...</text>}
                >
                  <text>{""}</text>
                  <For each={parts()}>
                    {(part) => <text fg={theme().text}>{part.text}</text>}
                  </For>
                </Show>
                <Show when={done()}>
                  <text>{""}</text>
                  <text fg={theme().textMuted}>press Ctrl+B to dismiss</text>
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

const plugin: TuiPluginModule = { id: "opencode-btw", tui };
export default plugin;
