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

function createMockApi(
  overrides: {
    route?: { name: string; params?: Record<string, string> };
    createFails?: boolean;
    createReturnsNoData?: boolean;
    promptFails?: boolean;
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
        messages: () => [],
        status: () => undefined,
      },
      part: () => [],
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
  test("registers exactly one command", async () => {
    const { api } = await setupPlugin();
    expect(api._commands.length).toBe(1);
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
      { type: "text", text: "what is typescript" },
    ]);
  });

  test("trims whitespace from question", async () => {
    const { btwCommand, api } = await setupPlugin();
    btwCommand.onSlashSubmit("  hello world  ");
    await new Promise((r) => setTimeout(r, 50));

    const call = api.client.session.prompt.mock.calls[0];
    expect(call[0].parts[0].text).toBe("hello world");
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
    expect(lastCall[0].parts[0].text).toBe("third");
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
      'what is "TypeScript" & how <does> it work?',
    );
  });

  test("handles unicode", async () => {
    const { btwCommand, api } = await setupPlugin();
    btwCommand.onSlashSubmit("o que é programação funcional? 🤔");
    await new Promise((r) => setTimeout(r, 50));

    const call = api.client.session.prompt.mock.calls[0];
    expect(call[0].parts[0].text).toBe("o que é programação funcional? 🤔");
  });

  test("handles 10k char question", async () => {
    const { btwCommand, api } = await setupPlugin();
    const longQ = "a".repeat(10000);
    btwCommand.onSlashSubmit(longQ);
    await new Promise((r) => setTimeout(r, 50));

    const call = api.client.session.prompt.mock.calls[0];
    expect(call[0].parts[0].text).toBe(longQ);
  });

  test("preserves newlines in question body", async () => {
    const { btwCommand, api } = await setupPlugin();
    btwCommand.onSlashSubmit("line one\nline two");
    await new Promise((r) => setTimeout(r, 50));

    const call = api.client.session.prompt.mock.calls[0];
    expect(call[0].parts[0].text).toBe("line one\nline two");
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
