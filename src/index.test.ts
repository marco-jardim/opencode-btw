import { describe, expect, test, beforeEach, mock } from "bun:test";
import { mock as mockModule } from "bun:test";

// ── mock opentui/solid JSX runtime and hooks before importing plugin ────────

// @ts-ignore - mock module
await mock.module("@opentui/solid/jsx-dev-runtime", () => ({
  jsxDEV: (_tag: any, props: any) => ({ tag: _tag, props }),
  Fragment: "Fragment",
}));

// @ts-ignore
await mock.module("@opentui/solid", () => ({
  useKeyboard: () => {},
  useTerminalDimensions: () => () => ({ width: 120, height: 40 }),
}));

// @ts-ignore - mock solid-js reactive primitives
const signals: Map<number, any> = new Map();
let signalId = 0;

await mock.module("solid-js", () => ({
  createSignal: (initial: any) => {
    const id = signalId++;
    signals.set(id, initial);
    return [
      () => signals.get(id),
      (v: any) => {
        signals.set(id, typeof v === "function" ? v(signals.get(id)) : v);
      },
    ];
  },
  createEffect: (_fn: any) => {},
  Show: (props: any) => props.children,
  For: (props: any) => props.children,
  onCleanup: (_fn: any) => {},
}));

// ── now import the plugin (mocks are active) ────────────────────────────────

const pluginModule = await import("./index.tsx");
const plugin = pluginModule.default;

// ── mock api builder ────────────────────────────────────────────────────────

type MockSession = {
  id: string;
  created: boolean;
  prompted: boolean;
  aborted: boolean;
  deleted: boolean;
};

type MockMessage = { id: string; role: string };

function createMockApi(
  overrides: {
    route?: { name: string; params?: Record<string, string> };
    createFails?: boolean;
    createReturnsNoData?: boolean;
    promptFails?: boolean;
    mainSessionMessages?: MockMessage[];
    partData?: Record<string, Array<{ type: string; text?: string }>>;
  } = {},
) {
  const sessions: MockSession[] = [];
  const registeredCommands: any[] = [];
  const registeredSlots: any[] = [];

  const api = {
    command: {
      register: (cb: () => any[]) => {
        registeredCommands.push(...cb());
      },
    },
    slots: {
      register: (plugin: any) => {
        registeredSlots.push(plugin);
        return "mock-slot-id";
      },
    },
    client: {
      session: {
        create: mock(async () => {
          if (overrides.createFails) throw new Error("create failed");
          if (overrides.createReturnsNoData) return { data: null };
          const session: MockSession = {
            id: `session-${sessions.length + 1}`,
            created: true,
            prompted: false,
            aborted: false,
            deleted: false,
          };
          sessions.push(session);
          return { data: { id: session.id } };
        }),
        prompt: mock(async (opts: any) => {
          if (overrides.promptFails) throw new Error("prompt failed");
          const s = sessions.find((s) => s.id === opts.sessionID);
          if (s) s.prompted = true;
        }),
        abort: mock(async (opts: any) => {
          const s = sessions.find((s) => s.id === opts.sessionID);
          if (s) s.aborted = true;
        }),
        delete: mock(async (opts: any) => {
          const s = sessions.find((s) => s.id === opts.sessionID);
          if (s) s.deleted = true;
        }),
      },
    },
    state: {
      session: {
        messages: (sid: string) => {
          if (sid === "main-session")
            return overrides.mainSessionMessages ?? [];
          return [];
        },
        status: () => undefined,
      },
      part: (msgId: string) => {
        if (overrides.partData?.[msgId]) return overrides.partData[msgId];
        return [];
      },
    },
    theme: {
      current: {
        accent: "#0078f0",
        text: "#e6e6e6",
        textMuted: "#787878",
      },
    },
    route: {
      current: overrides.route ?? {
        name: "session",
        params: { sessionID: "main-session" },
      },
    },
    _sessions: sessions,
    _commands: registeredCommands,
    _slots: registeredSlots,
  };

  return api;
}

async function setupPlugin(
  apiOverrides: Parameters<typeof createMockApi>[0] = {},
) {
  // Reset signal state for each setup
  signals.clear();
  signalId = 0;

  const api = createMockApi(apiOverrides);
  await plugin.tui(api as any);

  const btwCommand = api._commands.find((c: any) => c.value === "btw");
  return { api, btwCommand };
}

// ── module export tests ─────────────────────────────────────────────────────

describe("module exports", () => {
  test("exports default with id and tui", () => {
    expect(plugin).toBeDefined();
    expect(plugin.id).toBe("opencode-btw");
    expect(typeof plugin.tui).toBe("function");
  });

  test("id matches package name", async () => {
    const pkg = await Bun.file("./package.json").json();
    expect(plugin.id).toBe(pkg.name);
  });
});

// ── command registration ────────────────────────────────────────────────────

describe("command registration", () => {
  test("registers btw and dismiss commands", async () => {
    const { api } = await setupPlugin();
    expect(api._commands.length).toBe(2);
    expect(api._commands.find((c: any) => c.value === "btw")).toBeDefined();
    expect(api._commands.find((c: any) => c.value === "btw.dismiss")).toBeDefined();
  });

  test("registers /btw with correct metadata", async () => {
    const { btwCommand } = await setupPlugin();
    expect(btwCommand).toBeDefined();
    expect(btwCommand.value).toBe("btw");
    expect(btwCommand.slash).toEqual({ name: "btw" });
    expect(btwCommand.hidden).toBe(true);
    expect(btwCommand.category).toBe("General");
    expect(btwCommand.title).toContain("/btw");
    expect(btwCommand.description).toBeTruthy();
  });

  test("has onSlashSubmit, not onSelect", async () => {
    const { btwCommand } = await setupPlugin();
    expect(typeof btwCommand.onSlashSubmit).toBe("function");
    expect(btwCommand.onSelect).toBeUndefined();
  });
});

// ── slot registration ───────────────────────────────────────────────────────

describe("slot registration", () => {
  test("registers session_above_prompt slot with order 200", async () => {
    const { api } = await setupPlugin();
    expect(api._slots.length).toBe(1);
    expect(api._slots[0].order).toBe(200);
    expect(typeof api._slots[0].slots.session_above_prompt).toBe("function");
  });
});

// ── onSlashSubmit input validation ──────────────────────────────────────────

describe("onSlashSubmit input validation", () => {
  test("rejects empty string", async () => {
    const { btwCommand } = await setupPlugin();
    expect(btwCommand.onSlashSubmit("")).toBe(false);
  });

  test("rejects whitespace-only", async () => {
    const { btwCommand } = await setupPlugin();
    expect(btwCommand.onSlashSubmit("   ")).toBe(false);
    expect(btwCommand.onSlashSubmit("\t\n")).toBe(false);
  });

  test("rejects when not on session route", async () => {
    const { btwCommand } = await setupPlugin({ route: { name: "home" } });
    expect(btwCommand.onSlashSubmit("test")).toBe(false);
  });

  test("rejects when session route has no params", async () => {
    const { btwCommand } = await setupPlugin({ route: { name: "session" } });
    expect(btwCommand.onSlashSubmit("test")).toBe(false);
  });

  test("accepts valid args on session route", async () => {
    const { btwCommand } = await setupPlugin();
    expect(btwCommand.onSlashSubmit("test question")).toBe(true);
  });
});

// ── session lifecycle ───────────────────────────────────────────────────────

describe("session lifecycle", () => {
  test("creates a new session on ask", async () => {
    const { btwCommand, api } = await setupPlugin();
    btwCommand.onSlashSubmit("what is typescript");
    await new Promise((r) => setTimeout(r, 50));

    expect(api.client.session.create).toHaveBeenCalledTimes(1);
    expect(api._sessions.length).toBe(1);
    expect(api._sessions[0].created).toBe(true);
  });

  test("sends prompt with correct content", async () => {
    const { btwCommand, api } = await setupPlugin();
    btwCommand.onSlashSubmit("what is typescript");
    await new Promise((r) => setTimeout(r, 50));

    expect(api.client.session.prompt).toHaveBeenCalledTimes(1);
    const call = api.client.session.prompt.mock.calls[0];
    expect(call[0].sessionID).toBe("session-1");
    expect(call[0].parts).toEqual([
      { type: "text", text: "Question: what is typescript" },
    ]);
  });

  test("trims whitespace from question", async () => {
    const { btwCommand, api } = await setupPlugin();
    btwCommand.onSlashSubmit("  hello world  ");
    await new Promise((r) => setTimeout(r, 50));

    const call = api.client.session.prompt.mock.calls[0];
    expect(call[0].parts[0].text).toBe("Question: hello world");
  });

  test("resets on session.create failure", async () => {
    const { btwCommand, api } = await setupPlugin({ createFails: true });
    btwCommand.onSlashSubmit("test");
    await new Promise((r) => setTimeout(r, 50));

    expect(api.client.session.create).toHaveBeenCalled();
    expect(api.client.session.prompt).not.toHaveBeenCalled();
  });

  test("resets on session.create returning no data", async () => {
    const { btwCommand, api } = await setupPlugin({
      createReturnsNoData: true,
    });
    btwCommand.onSlashSubmit("test");
    await new Promise((r) => setTimeout(r, 50));

    expect(api.client.session.create).toHaveBeenCalled();
    expect(api.client.session.prompt).not.toHaveBeenCalled();
  });

  test("resets on session.prompt failure", async () => {
    const { btwCommand, api } = await setupPlugin({ promptFails: true });
    btwCommand.onSlashSubmit("test");
    await new Promise((r) => setTimeout(r, 50));

    expect(api.client.session.create).toHaveBeenCalled();
    expect(api._sessions[0].created).toBe(true);
    expect(api.client.session.prompt).toHaveBeenCalled();
  });
});

// ── sequential invocations ──────────────────────────────────────────────────

describe("sequential invocations", () => {
  test("second call dismisses first session", async () => {
    const { btwCommand, api } = await setupPlugin();

    btwCommand.onSlashSubmit("first");
    await new Promise((r) => setTimeout(r, 50));
    expect(api._sessions.length).toBe(1);

    btwCommand.onSlashSubmit("second");
    await new Promise((r) => setTimeout(r, 100));

    expect(api._sessions[0].deleted).toBe(true);
    expect(api._sessions.length).toBe(2);
    expect(api._sessions[1].prompted).toBe(true);
  });

  test("rapid calls are serialized", async () => {
    const { btwCommand, api } = await setupPlugin();

    btwCommand.onSlashSubmit("first");
    btwCommand.onSlashSubmit("second");
    btwCommand.onSlashSubmit("third");

    await new Promise((r) => setTimeout(r, 300));

    expect(api._sessions.length).toBe(3);
    const lastCall =
      api.client.session.prompt.mock.calls[
        api.client.session.prompt.mock.calls.length - 1
      ];
    expect(lastCall[0].parts[0].text).toBe("Question: third");
  });
});

// ── error resilience ────────────────────────────────────────────────────────

describe("error resilience", () => {
  test("dismiss survives abort failure", async () => {
    const { btwCommand, api } = await setupPlugin();
    btwCommand.onSlashSubmit("first");
    await new Promise((r) => setTimeout(r, 50));

    api.client.session.abort.mockImplementation(async () => {
      throw new Error("network error");
    });

    btwCommand.onSlashSubmit("second");
    await new Promise((r) => setTimeout(r, 100));

    expect(api._sessions.length).toBe(2);
  });

  test("dismiss survives delete failure", async () => {
    const { btwCommand, api } = await setupPlugin();
    btwCommand.onSlashSubmit("first");
    await new Promise((r) => setTimeout(r, 50));

    api.client.session.delete.mockImplementation(async () => {
      throw new Error("network error");
    });

    btwCommand.onSlashSubmit("second");
    await new Promise((r) => setTimeout(r, 100));

    expect(api._sessions.length).toBe(2);
  });
});

// ── edge cases ──────────────────────────────────────────────────────────────

describe("edge cases", () => {
  test("handles special characters", async () => {
    const { btwCommand, api } = await setupPlugin();
    btwCommand.onSlashSubmit('what is "TypeScript" & how <does> it work?');
    await new Promise((r) => setTimeout(r, 50));

    const call = api.client.session.prompt.mock.calls[0];
    expect(call[0].parts[0].text).toBe(
      'Question: what is "TypeScript" & how <does> it work?',
    );
  });

  test("handles unicode", async () => {
    const { btwCommand, api } = await setupPlugin();
    btwCommand.onSlashSubmit("o que é programação funcional? 🤔");
    await new Promise((r) => setTimeout(r, 50));

    const call = api.client.session.prompt.mock.calls[0];
    expect(call[0].parts[0].text).toBe(
      "Question: o que é programação funcional? 🤔",
    );
  });

  test("handles 10k char question", async () => {
    const { btwCommand, api } = await setupPlugin();
    const longQ = "a".repeat(10000);
    btwCommand.onSlashSubmit(longQ);
    await new Promise((r) => setTimeout(r, 50));

    const call = api.client.session.prompt.mock.calls[0];
    expect(call[0].parts[0].text).toBe("Question: " + longQ);
  });

  test("preserves newlines in question body", async () => {
    const { btwCommand, api } = await setupPlugin();
    btwCommand.onSlashSubmit("line one\nline two");
    await new Promise((r) => setTimeout(r, 50));

    const call = api.client.session.prompt.mock.calls[0];
    expect(call[0].parts[0].text).toBe("Question: line one\nline two");
  });
});

// ── package.json validation ─────────────────────────────────────────────────

describe("package.json", () => {
  let pkg: any;

  beforeEach(async () => {
    pkg = await Bun.file("./package.json").json();
  });

  test("has ./tui export", () => {
    expect(pkg.exports["./tui"]).toBeDefined();
  });

  test("./tui and . point to the same file", () => {
    expect(pkg.exports["./tui"]).toBe(pkg.exports["."]);
  });

  test("has required peer dependencies", () => {
    expect(pkg.peerDependencies["@opencode-ai/plugin"]).toBeDefined();
    expect(pkg.peerDependencies["@opencode-ai/sdk"]).toBeDefined();
    expect(pkg.peerDependencies["@opentui/solid"]).toBeDefined();
    expect(pkg.peerDependencies["solid-js"]).toBeDefined();
  });

  test("is ESM module", () => {
    expect(pkg.type).toBe("module");
  });

  test("has MIT license", () => {
    expect(pkg.license).toBe("MIT");
  });
});

// ── session context ─────────────────────────────────────────────────────────

describe("session context", () => {
  test("includes context from main session messages", async () => {
    const { btwCommand, api } = await setupPlugin({
      mainSessionMessages: [
        { id: "msg-1", role: "user" },
        { id: "msg-2", role: "assistant" },
      ],
      partData: {
        "msg-1": [{ type: "text", text: "What is TypeScript?" }],
        "msg-2": [
          {
            type: "text",
            text: "TypeScript is a typed superset of JavaScript.",
          },
        ],
      },
    });
    btwCommand.onSlashSubmit("follow up question");
    await new Promise((r) => setTimeout(r, 50));

    const call = api.client.session.prompt.mock.calls[0];
    const text = call[0].parts[0].text as string;

    expect(text).toContain("Here is the recent conversation context");
    expect(text).toContain("[user]: What is TypeScript?");
    expect(text).toContain(
      "[assistant]: TypeScript is a typed superset of JavaScript.",
    );
    expect(text).toContain("---");
    expect(text).toContain("Question: follow up question");
  });

  test("sends no context when main session has no messages", async () => {
    const { btwCommand, api } = await setupPlugin({
      mainSessionMessages: [],
    });
    btwCommand.onSlashSubmit("standalone question");
    await new Promise((r) => setTimeout(r, 50));

    const call = api.client.session.prompt.mock.calls[0];
    const text = call[0].parts[0].text as string;

    expect(text).toBe("Question: standalone question");
    expect(text).not.toContain("conversation context");
  });

  test("limits context to last 5 messages", async () => {
    const msgs = Array.from({ length: 8 }, (_, i) => ({
      id: `msg-${i}`,
      role: i % 2 === 0 ? "user" : "assistant",
    }));
    const partData: Record<string, Array<{ type: string; text: string }>> = {};
    for (let i = 0; i < 8; i++) {
      partData[`msg-${i}`] = [{ type: "text", text: `Message ${i}` }];
    }

    const { btwCommand, api } = await setupPlugin({
      mainSessionMessages: msgs,
      partData,
    });
    btwCommand.onSlashSubmit("test");
    await new Promise((r) => setTimeout(r, 50));

    const call = api.client.session.prompt.mock.calls[0];
    const text = call[0].parts[0].text as string;

    // Messages 0-2 should NOT be included (only last 5: 3,4,5,6,7)
    expect(text).not.toContain("Message 0");
    expect(text).not.toContain("Message 1");
    expect(text).not.toContain("Message 2");
    expect(text).toContain("Message 3");
    expect(text).toContain("Message 7");
  });

  test("truncates long messages to 2000 chars", async () => {
    const longText = "x".repeat(3000);
    const { btwCommand, api } = await setupPlugin({
      mainSessionMessages: [{ id: "msg-long", role: "user" }],
      partData: {
        "msg-long": [{ type: "text", text: longText }],
      },
    });
    btwCommand.onSlashSubmit("test");
    await new Promise((r) => setTimeout(r, 50));

    const call = api.client.session.prompt.mock.calls[0];
    const text = call[0].parts[0].text as string;

    // The context should contain the truncated text, not the full 3000 chars
    expect(text).toContain("[user]:");
    // Extract the user message from context
    const match = text.match(/\[user\]: (x+)/);
    expect(match).toBeTruthy();
    expect(match![1].length).toBe(2000);
  });

  test("skips messages with no text parts", async () => {
    const { btwCommand, api } = await setupPlugin({
      mainSessionMessages: [
        { id: "msg-tool", role: "assistant" },
        { id: "msg-text", role: "user" },
      ],
      partData: {
        "msg-tool": [{ type: "tool-invocation", toolName: "readFile" } as any],
        "msg-text": [{ type: "text", text: "real message" }],
      },
    });
    btwCommand.onSlashSubmit("test");
    await new Promise((r) => setTimeout(r, 50));

    const call = api.client.session.prompt.mock.calls[0];
    const text = call[0].parts[0].text as string;

    expect(text).toContain("[user]: real message");
    expect(text).not.toContain("[assistant]");
  });

  test("skips messages with empty text", async () => {
    const { btwCommand, api } = await setupPlugin({
      mainSessionMessages: [
        { id: "msg-empty", role: "user" },
        { id: "msg-ok", role: "assistant" },
      ],
      partData: {
        "msg-empty": [{ type: "text", text: "   " }],
        "msg-ok": [{ type: "text", text: "answer" }],
      },
    });
    btwCommand.onSlashSubmit("test");
    await new Promise((r) => setTimeout(r, 50));

    const call = api.client.session.prompt.mock.calls[0];
    const text = call[0].parts[0].text as string;

    expect(text).toContain("[assistant]: answer");
    expect(text).not.toContain("[user]:");
  });

  test("joins multiple text parts in a single message", async () => {
    const { btwCommand, api } = await setupPlugin({
      mainSessionMessages: [{ id: "msg-multi", role: "assistant" }],
      partData: {
        "msg-multi": [
          { type: "text", text: "Part one." },
          { type: "text", text: "Part two." },
        ],
      },
    });
    btwCommand.onSlashSubmit("test");
    await new Promise((r) => setTimeout(r, 50));

    const call = api.client.session.prompt.mock.calls[0];
    const text = call[0].parts[0].text as string;

    expect(text).toContain("[assistant]: Part one.\nPart two.");
  });

  test("handles null partData gracefully", async () => {
    const { btwCommand, api } = await setupPlugin({
      mainSessionMessages: [{ id: "msg-noparts", role: "user" }],
      // no partData for this message, mock returns []
    });
    btwCommand.onSlashSubmit("test");
    await new Promise((r) => setTimeout(r, 50));

    const call = api.client.session.prompt.mock.calls[0];
    const text = call[0].parts[0].text as string;

    // No context gathered (empty parts), so just the question
    expect(text).toBe("Question: test");
  });
});
