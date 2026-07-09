import { afterEach, describe, expect, it, vi } from "vitest";

const { buildCopiedContext, getSessionEntries, resolveRuntimeMiniAgent } = vi.hoisted(
  () => ({
    buildCopiedContext: vi.fn(() => ({
      text: "main context",
      usedTokens: 31_000,
      totalAvailableTokens: 31_000,
    })),
    getSessionEntries: vi.fn(() => []),
    resolveRuntimeMiniAgent: vi.fn(),
  }),
);

vi.mock("../src/agent", async () => {
  const actual = await vi.importActual<typeof import("../src/agent")>(
    "../src/agent",
  );
  return {
    ...actual,
    resolveRuntimeMiniAgent,
  };
});

vi.mock("../src/context", () => ({
  getSessionEntries,
  buildCopiedContext,
}));

import { openMiniSession, startQuestion } from "../src/session";
import type {
  ActiveDialogController,
  OverlayState,
  MiniConfig,
  ModelPreferenceState,
  ThinkingPreferenceState,
} from "../src/types";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function config(): MiniConfig {
  return {
    model: null,
    variant: null,
    agent: null,
    tokenLimit: 50_000,
    keybind: "alt+b",
    freshKeybind: "alt+n",
    enableThinking: false,
    toggleThinkingKeybind: "ctrl+t",
  };
}

function fakeApi() {
  return {
    state: {
      provider: [
        {
          id: "anthropic",
          name: "Anthropic",
          models: {
            "claude-sonnet-4.6": {
              id: "claude-sonnet-4.6",
              providerID: "anthropic",
              name: "Claude Sonnet 4.6",
              limit: { context: 200_000, output: 8_000 },
              variants: { fast: {} },
            },
          },
        },
      ],
      path: { directory: "/tmp/project" },
    },
    renderer: {
      currentFocusedRenderable: undefined,
      requestRender: vi.fn(),
    },
    ui: {
      toast: vi.fn(),
    },
    client: {
      tui: {
        appendPrompt: vi.fn(),
      },
      session: {
        abort: vi.fn(),
        create: vi.fn(async () => ({ data: { id: "mini-session" } })),
        delete: vi.fn(),
        promptAsync: vi.fn(),
      },
    },
    event: {
      on: vi.fn(() => () => {}),
    },
    route: {
      current: { name: "session", params: { sessionID: "session-1" } },
    },
  } as any;
}

function assistantEntry(options: {
  id: string;
  text: string;
  inputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  completed?: boolean;
}) {
  return {
    info: {
      id: options.id,
      role: "assistant",
      providerID: "anthropic",
      modelID: "claude-sonnet-4.6",
      variant: "fast",
      time: options.completed ? { completed: Date.now() } : {},
      tokens:
        options.inputTokens !== undefined
          ? {
              input: options.inputTokens,
              cache: {
                read: options.cacheReadTokens ?? 0,
                write: options.cacheWriteTokens ?? 0,
              },
            }
          : undefined,
    },
    parts: [{ type: "text", text: options.text }],
  } as any;
}

function resolvedAgent() {
  return {
    mode: "plugin-managed",
    requestedAgent: null,
    agent: null,
    permission: [],
    permissionSource: "plugin-managed",
    notices: [],
  };
}

function fakeScroller(options: {
  scrollTop?: number;
  scrollHeight?: number;
  viewportHeight?: number;
} = {}) {
  const scroller = {
    scrollTop: options.scrollTop ?? 0,
    scrollHeight: options.scrollHeight ?? 20,
    viewport: { height: options.viewportHeight ?? 10 },
    scrollTo: vi.fn((position: number) => {
      scroller.scrollTop =
        position === Number.MAX_SAFE_INTEGER
          ? Math.max(0, scroller.scrollHeight - scroller.viewport.height)
          : position;
    }),
    scrollBy: vi.fn((delta: number) => {
      scroller.scrollTop = Math.max(
        0,
        Math.min(
          scroller.scrollTop + delta,
          Math.max(0, scroller.scrollHeight - scroller.viewport.height),
        ),
      );
    }),
  };
  return scroller;
}

async function flushScrollTimer() {
  await vi.advanceTimersByTimeAsync(0);
}

async function flushStreamingRender() {
  await vi.advanceTimersByTimeAsync(51);
  await flushScrollTimer();
}

afterEach(() => {
  vi.useRealTimers();
  buildCopiedContext.mockClear();
  getSessionEntries.mockReset();
  getSessionEntries.mockReturnValue([]);
  resolveRuntimeMiniAgent.mockReset();
});

describe("openMiniSession", () => {
  it("returns false and shows the active dialog when one is already open", () => {
    const activeDialog = {
      show: vi.fn(),
    } as any;

    const opened = openMiniSession(
      fakeApi(),
      config(),
      "main",
      vi.fn(),
      { get: () => activeDialog, set: vi.fn() },
      { get: () => undefined, set: vi.fn() },
      { get: () => false, set: vi.fn() },
      vi.fn(),
    );

    expect(opened).toBe(false);
    expect(activeDialog.show).toHaveBeenCalledOnce();
  });

  it("returns true after creating a new dialog", () => {
    resolveRuntimeMiniAgent.mockReturnValue({
      mode: "plugin-managed",
      requestedAgent: null,
      agent: null,
      permission: [],
      permissionSource: "plugin-managed",
      notices: [],
    });

    let activeDialog: ActiveDialogController | undefined;

    const opened = openMiniSession(
      fakeApi(),
      config(),
      "main",
      vi.fn(),
      {
        get: () => activeDialog,
        set: (dialog: ActiveDialogController | undefined) => {
          activeDialog = dialog;
        },
      },
      { get: () => undefined, set: vi.fn() },
      { get: () => false, set: vi.fn() },
      vi.fn(),
    );

    expect(opened).toBe(true);
    expect(activeDialog).toBeDefined();
  });
});

describe("startQuestion", () => {
  it("forces bottom scroll and follows streaming after submitting a prompt", async () => {
    vi.useFakeTimers();
    resolveRuntimeMiniAgent.mockResolvedValue(resolvedAgent());

    const handlers: Record<string, (event: any) => void> = {};
    const api = fakeApi();
    api.event.on.mockImplementation((name: string, handler: (event: any) => void) => {
      handlers[name] = handler;
      return () => {};
    });
    let overlay: OverlayState | undefined;
    const scroller = fakeScroller({
      scrollTop: 30,
      scrollHeight: 40,
      viewportHeight: 10,
    });

    await startQuestion(
      api,
      config(),
      "main",
      "session-1",
      ((next: OverlayState | undefined) => {
        overlay = next;
      }) as any,
      { get: () => undefined, set: vi.fn() },
      { get: () => undefined, set: vi.fn() },
      { get: () => false, set: vi.fn() },
      vi.fn(),
    );

    overlay?.onScroller?.(scroller as any);
    expect(overlay?.onSubmit("hello")).toBe(true);
    await flushScrollTimer();

    expect(scroller.scrollTo).toHaveBeenCalledWith(Number.MAX_SAFE_INTEGER);

    scroller.scrollHeight += 20;
    handlers["session.next.text.delta"]({
      properties: { sessionID: "mini-session", delta: "answer" },
    });
    await flushStreamingRender();

    expect(scroller.scrollTo).toHaveBeenCalledTimes(2);
    expect(scroller.scrollTop).toBe(50);
  });

  it("stops following streaming after the user scrolls up", async () => {
    vi.useFakeTimers();
    resolveRuntimeMiniAgent.mockResolvedValue(resolvedAgent());

    const handlers: Record<string, (event: any) => void> = {};
    const api = fakeApi();
    api.event.on.mockImplementation((name: string, handler: (event: any) => void) => {
      handlers[name] = handler;
      return () => {};
    });
    let overlay: OverlayState | undefined;
    const scroller = fakeScroller({
      scrollTop: 30,
      scrollHeight: 40,
      viewportHeight: 10,
    });

    await startQuestion(
      api,
      config(),
      "main",
      "session-1",
      ((next: OverlayState | undefined) => {
        overlay = next;
      }) as any,
      { get: () => undefined, set: vi.fn() },
      { get: () => undefined, set: vi.fn() },
      { get: () => false, set: vi.fn() },
      vi.fn(),
    );

    overlay?.onScroller?.(scroller as any);
    expect(overlay?.onSubmit("hello")).toBe(true);
    await flushScrollTimer();

    scroller.scrollTop = 25;
    scroller.scrollHeight += 20;
    handlers["session.next.text.delta"]({
      properties: { sessionID: "mini-session", delta: "answer" },
    });
    await flushStreamingRender();

    expect(scroller.scrollTo).toHaveBeenCalledTimes(1);
    expect(scroller.scrollTop).toBe(25);
  });

  it("updates overlay runtime from session next text delta when assistant identifiers are present", async () => {
    vi.useFakeTimers();
    resolveRuntimeMiniAgent.mockResolvedValue(resolvedAgent());

    const handlers: Record<string, (event: any) => void> = {};
    const api = fakeApi();
    api.event.on.mockImplementation((name: string, handler: (event: any) => void) => {
      handlers[name] = handler;
      return () => {};
    });
    let overlay: OverlayState | undefined;

    await startQuestion(
      api,
      config(),
      "main",
      "session-1",
      ((next: OverlayState | undefined) => {
        overlay = next;
      }) as any,
      { get: () => undefined, set: vi.fn() },
      { get: () => undefined, set: vi.fn() },
      { get: () => false, set: vi.fn() },
      vi.fn(),
    );

    handlers["session.next.text.delta"]({
      properties: {
        sessionID: "mini-session",
        assistantMessageID: "assistant-1",
        textID: "text-1",
        delta: "answer",
      },
    });
    await flushStreamingRender();

    expect(overlay?.state.runtime.rootMessageIds).toEqual(["assistant-1"]);
    expect(overlay?.state.runtime.messages["assistant-1"]).toEqual({
      info: {
        id: "assistant-1",
        role: "assistant",
      },
      parts: [
        {
          id: "text-1",
          messageID: "assistant-1",
          type: "text",
          text: "answer",
        },
      ],
    });
    expect(overlay?.state.streamingAnswer).toBe("");
  });

  it("does not let a stale refresh roll back identified runtime streaming text", async () => {
    vi.useFakeTimers();
    resolveRuntimeMiniAgent.mockResolvedValue(resolvedAgent());

    const handlers: Record<string, (event: any) => void> = {};
    const api = fakeApi();
    api.event.on.mockImplementation((name: string, handler: (event: any) => void) => {
      handlers[name] = handler;
      return () => {};
    });
    let overlay: OverlayState | undefined;

    await startQuestion(
      api,
      config(),
      "main",
      "session-1",
      ((next: OverlayState | undefined) => {
        overlay = next;
      }) as any,
      { get: () => undefined, set: vi.fn() },
      { get: () => undefined, set: vi.fn() },
      { get: () => false, set: vi.fn() },
      vi.fn(),
    );

    handlers["session.next.text.delta"]({
      properties: {
        sessionID: "mini-session",
        assistantMessageID: "assistant-1",
        textID: "text-1",
        delta: "live answer",
      },
    });
    await flushStreamingRender();

    (getSessionEntries as any).mockReturnValue([
      {
        info: { id: "assistant-1", role: "assistant" },
        parts: [],
      },
    ]);

    handlers["message.updated"]({
      properties: {
        sessionID: "mini-session",
        info: { id: "assistant-1", role: "assistant" },
      },
    });

    expect(overlay?.state.runtime.messages["assistant-1"]?.parts).toEqual([
      {
        id: "text-1",
        messageID: "assistant-1",
        type: "text",
        text: "live answer",
      },
    ]);
  });

  it("clears the empty-response notice as soon as runtime-only text arrives", async () => {
    vi.useFakeTimers();
    resolveRuntimeMiniAgent.mockResolvedValue(resolvedAgent());

    const handlers: Record<string, (event: any) => void> = {};
    const api = fakeApi();
    api.event.on.mockImplementation((name: string, handler: (event: any) => void) => {
      handlers[name] = handler;
      return () => {};
    });
    let overlay: OverlayState | undefined;

    await startQuestion(
      api,
      config(),
      "main",
      "session-1",
      ((next: OverlayState | undefined) => {
        overlay = next;
      }) as any,
      { get: () => undefined, set: vi.fn() },
      { get: () => undefined, set: vi.fn() },
      { get: () => false, set: vi.fn() },
      vi.fn(),
    );

    handlers["session.idle"]({ properties: { sessionID: "mini-session" } });
    expect(overlay?.state.emptyResponseNotice).toBe("No response generated.");

    handlers["session.next.text.delta"]({
      properties: {
        sessionID: "mini-session",
        assistantMessageID: "assistant-1",
        textID: "text-1",
        delta: "late live answer",
      },
    });
    await flushStreamingRender();

    expect(overlay?.state.emptyResponseNotice).toBeUndefined();
  });

  it("keeps auto-scroll following runtime-driven streaming even when streamingAnswer stays empty", async () => {
    vi.useFakeTimers();
    resolveRuntimeMiniAgent.mockResolvedValue(resolvedAgent());

    const handlers: Record<string, (event: any) => void> = {};
    const api = fakeApi();
    api.event.on.mockImplementation((name: string, handler: (event: any) => void) => {
      handlers[name] = handler;
      return () => {};
    });
    let overlay: OverlayState | undefined;
    const scroller = fakeScroller({
      scrollTop: 30,
      scrollHeight: 40,
      viewportHeight: 10,
    });

    await startQuestion(
      api,
      config(),
      "main",
      "session-1",
      ((next: OverlayState | undefined) => {
        overlay = next;
      }) as any,
      { get: () => undefined, set: vi.fn() },
      { get: () => undefined, set: vi.fn() },
      { get: () => false, set: vi.fn() },
      vi.fn(),
    );

    overlay?.onScroller?.(scroller as any);
    expect(overlay?.onSubmit("hello")).toBe(true);
    await flushScrollTimer();

    scroller.scrollHeight += 20;
    handlers["session.next.text.delta"]({
      properties: {
        sessionID: "mini-session",
        assistantMessageID: "assistant-1",
        textID: "text-1",
        delta: "answer",
      },
    });
    await flushStreamingRender();

    expect(overlay?.state.streamingAnswer).toBe("");
    expect(scroller.scrollTo).toHaveBeenCalledTimes(2);
    expect(scroller.scrollTop).toBe(50);
  });

  it("hydrates overlay runtime from refreshed session entries after message updates", async () => {
    resolveRuntimeMiniAgent.mockResolvedValue(resolvedAgent());

    const handlers: Record<string, (event: any) => void> = {};
    const api = fakeApi();
    api.event.on.mockImplementation((name: string, handler: (event: any) => void) => {
      handlers[name] = handler;
      return () => {};
    });
    let overlay: OverlayState | undefined;

    await startQuestion(
      api,
      config(),
      "main",
      "session-1",
      ((next: OverlayState | undefined) => {
        overlay = next;
      }) as any,
      { get: () => undefined, set: vi.fn() },
      { get: () => undefined, set: vi.fn() },
      { get: () => false, set: vi.fn() },
      vi.fn(),
    );

    (getSessionEntries as any).mockReturnValue([
      {
        info: { id: "user-1", role: "user" },
        parts: [{ type: "text", text: "question" }],
      },
      {
        info: { id: "assistant-1", role: "assistant" },
        parts: [{ type: "text", text: "answer" }],
      },
    ]);

    handlers["message.updated"]({
      properties: {
        sessionID: "mini-session",
        info: { id: "assistant-1", role: "assistant" },
      },
    });

    expect(overlay?.state.runtime.rootMessageIds).toEqual(["user-1", "assistant-1"]);
    expect(overlay?.state.runtime.messages["user-1"]?.parts).toEqual([
      {
        id: "user-1:text:0",
        messageID: "user-1",
        type: "text",
        text: "question",
      },
    ]);
    expect(overlay?.state.runtime.messages["assistant-1"]?.parts).toEqual([
      {
        id: "assistant-1:text:0",
        messageID: "assistant-1",
        type: "text",
        text: "answer",
      },
    ]);
  });

  it("marks overlay runtime idle after session idle", async () => {
    resolveRuntimeMiniAgent.mockResolvedValue(resolvedAgent());

    const handlers: Record<string, (event: any) => void> = {};
    const api = fakeApi();
    api.event.on.mockImplementation((name: string, handler: (event: any) => void) => {
      handlers[name] = handler;
      return () => {};
    });
    let overlay: OverlayState | undefined;

    await startQuestion(
      api,
      config(),
      "main",
      "session-1",
      ((next: OverlayState | undefined) => {
        overlay = next;
      }) as any,
      { get: () => undefined, set: vi.fn() },
      { get: () => undefined, set: vi.fn() },
      { get: () => false, set: vi.fn() },
      vi.fn(),
    );

    handlers["session.idle"]({ properties: { sessionID: "mini-session" } });

    expect(overlay?.state.runtime.status).toBe("idle");
  });

  it("continues in the main thread using the runtime-first transcript", async () => {
    resolveRuntimeMiniAgent.mockResolvedValue(resolvedAgent());

    const handlers: Record<string, (event: any) => void> = {};
    const api = fakeApi();
    api.event.on.mockImplementation((name: string, handler: (event: any) => void) => {
      handlers[name] = handler;
      return () => {};
    });
    let overlay: OverlayState | undefined;

    await startQuestion(
      api,
      config(),
      "main",
      "session-1",
      ((next: OverlayState | undefined) => {
        overlay = next;
      }) as any,
      { get: () => undefined, set: vi.fn() },
      { get: () => undefined, set: vi.fn() },
      { get: () => false, set: vi.fn() },
      vi.fn(),
    );

    (getSessionEntries as any).mockReturnValue([
      {
        info: { id: "user-1", role: "user" },
        parts: [{ type: "text", text: "question" }],
      },
      {
        info: { id: "assistant-1", role: "assistant" },
        parts: [{ type: "text", text: "answer" }],
      },
    ]);

    handlers["message.updated"]({
      properties: {
        sessionID: "mini-session",
        info: { id: "assistant-1", role: "assistant" },
      },
    });
    handlers["session.idle"]({ properties: { sessionID: "mini-session" } });

    await overlay?.onContinue();

    expect(api.client.tui.appendPrompt).toHaveBeenCalledWith(
      {
        text: "[Context from a mini session]\n\nuser:\nquestion\n\nassistant:\nanswer\n\n---\n",
      },
      { throwOnError: true },
    );
  });

  it("does not show the no-response fallback when runtime already contains assistant text", async () => {
    resolveRuntimeMiniAgent.mockResolvedValue(resolvedAgent());

    const handlers: Record<string, (event: any) => void> = {};
    const api = fakeApi();
    api.event.on.mockImplementation((name: string, handler: (event: any) => void) => {
      handlers[name] = handler;
      return () => {};
    });
    let overlay: OverlayState | undefined;

    await startQuestion(
      api,
      config(),
      "main",
      "session-1",
      ((next: OverlayState | undefined) => {
        overlay = next;
      }) as any,
      { get: () => undefined, set: vi.fn() },
      { get: () => undefined, set: vi.fn() },
      { get: () => false, set: vi.fn() },
      vi.fn(),
    );

    (getSessionEntries as any).mockReturnValue([
      {
        info: { id: "assistant-1", role: "assistant" },
        parts: [{ type: "text", text: "answer" }],
      },
    ]);

    handlers["session.idle"]({ properties: { sessionID: "mini-session" } });

    expect(overlay?.state.streamingAnswer).toBe("");
    expect(overlay?.state.emptyResponseNotice).toBeUndefined();
  });

  it("stores the no-response fallback in a dedicated notice field instead of streaming text", async () => {
    resolveRuntimeMiniAgent.mockResolvedValue(resolvedAgent());

    const handlers: Record<string, (event: any) => void> = {};
    const api = fakeApi();
    api.event.on.mockImplementation((name: string, handler: (event: any) => void) => {
      handlers[name] = handler;
      return () => {};
    });
    let overlay: OverlayState | undefined;

    await startQuestion(
      api,
      config(),
      "main",
      "session-1",
      ((next: OverlayState | undefined) => {
        overlay = next;
      }) as any,
      { get: () => undefined, set: vi.fn() },
      { get: () => undefined, set: vi.fn() },
      { get: () => false, set: vi.fn() },
      vi.fn(),
    );

    handlers["session.idle"]({ properties: { sessionID: "mini-session" } });

    expect(overlay?.state.emptyResponseNotice).toBe("No response generated.");
    expect(overlay?.state.streamingAnswer).toBe("");
  });

  it("clears legacy fallback streaming text once a refreshed final assistant answer is available", async () => {
    vi.useFakeTimers();
    resolveRuntimeMiniAgent.mockResolvedValue(resolvedAgent());

    const handlers: Record<string, (event: any) => void> = {};
    const api = fakeApi();
    api.event.on.mockImplementation((name: string, handler: (event: any) => void) => {
      handlers[name] = handler;
      return () => {};
    });
    let overlay: OverlayState | undefined;

    await startQuestion(
      api,
      config(),
      "main",
      "session-1",
      ((next: OverlayState | undefined) => {
        overlay = next;
      }) as any,
      { get: () => undefined, set: vi.fn() },
      { get: () => undefined, set: vi.fn() },
      { get: () => false, set: vi.fn() },
      vi.fn(),
    );

    handlers["session.next.text.delta"]({
      properties: {
        sessionID: "mini-session",
        delta: "partial legacy answer",
      },
    });
    await flushStreamingRender();

    expect(overlay?.state.streamingAnswer).toBe("partial legacy answer");

    (getSessionEntries as any).mockReturnValue([
      {
        info: { id: "assistant-1", role: "assistant" },
        parts: [{ type: "text", text: "final persisted answer" }],
      },
    ]);

    handlers["message.updated"]({
      properties: {
        sessionID: "mini-session",
        info: { id: "assistant-1", role: "assistant" },
      },
    });

    expect(overlay?.state.streamingAnswer).toBe("");
    expect(overlay?.state.runtime.messages["assistant-1"]?.parts).toEqual([
      {
        id: "assistant-1:text:0",
        messageID: "assistant-1",
        type: "text",
        text: "final persisted answer",
      },
    ]);
  });

  it("clears an earlier empty-response notice once persisted assistant text arrives later", async () => {
    resolveRuntimeMiniAgent.mockResolvedValue(resolvedAgent());

    const handlers: Record<string, (event: any) => void> = {};
    const api = fakeApi();
    api.event.on.mockImplementation((name: string, handler: (event: any) => void) => {
      handlers[name] = handler;
      return () => {};
    });
    let overlay: OverlayState | undefined;

    await startQuestion(
      api,
      config(),
      "main",
      "session-1",
      ((next: OverlayState | undefined) => {
        overlay = next;
      }) as any,
      { get: () => undefined, set: vi.fn() },
      { get: () => undefined, set: vi.fn() },
      { get: () => false, set: vi.fn() },
      vi.fn(),
    );

    handlers["session.idle"]({ properties: { sessionID: "mini-session" } });
    expect(overlay?.state.emptyResponseNotice).toBe("No response generated.");

    (getSessionEntries as any).mockReturnValue([
      {
        info: { id: "assistant-1", role: "assistant" },
        parts: [{ type: "text", text: "late persisted answer" }],
      },
    ]);

    handlers["message.updated"]({
      properties: {
        sessionID: "mini-session",
        info: { id: "assistant-1", role: "assistant" },
      },
    });

    expect(overlay?.state.emptyResponseNotice).toBeUndefined();
  });

  it("does not let stale entries roll back a direct message part text update", async () => {
    resolveRuntimeMiniAgent.mockResolvedValue(resolvedAgent());

    const handlers: Record<string, (event: any) => void> = {};
    const api = fakeApi();
    api.event.on.mockImplementation((name: string, handler: (event: any) => void) => {
      handlers[name] = handler;
      return () => {};
    });
    let overlay: OverlayState | undefined;

    await startQuestion(
      api,
      config(),
      "main",
      "session-1",
      ((next: OverlayState | undefined) => {
        overlay = next;
      }) as any,
      { get: () => undefined, set: vi.fn() },
      { get: () => undefined, set: vi.fn() },
      { get: () => false, set: vi.fn() },
      vi.fn(),
    );

    handlers["message.updated"]({
      properties: {
        sessionID: "mini-session",
        info: { id: "assistant-1", role: "assistant" },
      },
    });

    handlers["message.part.updated"]({
      properties: {
        sessionID: "mini-session",
        part: {
          id: "text-1",
          messageID: "assistant-1",
          type: "text",
          text: "corrected live answer",
        },
      },
    });

    (getSessionEntries as any).mockReturnValue([
      {
        info: { id: "assistant-1", role: "assistant" },
        parts: [{ type: "text", text: "stale persisted answer" }],
      },
    ]);

    handlers["message.part.updated"]({
      properties: {
        sessionID: "mini-session",
        part: {
          id: "text-1",
          messageID: "assistant-1",
          type: "text",
          text: "corrected live answer",
        },
      },
    });

    expect(overlay?.state.runtime.messages["assistant-1"]?.parts).toEqual([
      {
        id: "text-1",
        messageID: "assistant-1",
        type: "text",
        text: "corrected live answer",
      },
    ]);
  });

  it("keeps protecting a newer direct runtime text update across repeated stale refreshes", async () => {
    resolveRuntimeMiniAgent.mockResolvedValue(resolvedAgent());

    const handlers: Record<string, (event: any) => void> = {};
    const api = fakeApi();
    api.event.on.mockImplementation((name: string, handler: (event: any) => void) => {
      handlers[name] = handler;
      return () => {};
    });
    let overlay: OverlayState | undefined;

    await startQuestion(
      api,
      config(),
      "main",
      "session-1",
      ((next: OverlayState | undefined) => {
        overlay = next;
      }) as any,
      { get: () => undefined, set: vi.fn() },
      { get: () => undefined, set: vi.fn() },
      { get: () => false, set: vi.fn() },
      vi.fn(),
    );

    (getSessionEntries as any).mockReturnValue([
      {
        info: { id: "assistant-1", role: "assistant" },
        parts: [{ type: "text", text: "stale persisted answer" }],
      },
    ]);

    handlers["message.updated"]({
      properties: {
        sessionID: "mini-session",
        info: { id: "assistant-1", role: "assistant" },
      },
    });

    handlers["message.part.updated"]({
      properties: {
        sessionID: "mini-session",
        part: {
          id: "text-1",
          messageID: "assistant-1",
          type: "text",
          text: "corrected live answer",
        },
      },
    });

    expect(overlay?.state.runtime.messages["assistant-1"]?.parts).toEqual([
      {
        id: "text-1",
        messageID: "assistant-1",
        type: "text",
        text: "corrected live answer",
      },
    ]);

    handlers["message.updated"]({
      properties: {
        sessionID: "mini-session",
        info: { id: "assistant-1", role: "assistant" },
      },
    });

    expect(overlay?.state.runtime.messages["assistant-1"]?.parts).toEqual([
      {
        id: "text-1",
        messageID: "assistant-1",
        type: "text",
        text: "corrected live answer",
      },
    ]);
  });

  it("accepts a newer persisted correction after protecting an older live text update", async () => {
    resolveRuntimeMiniAgent.mockResolvedValue(resolvedAgent());

    const handlers: Record<string, (event: any) => void> = {};
    const api = fakeApi();
    api.event.on.mockImplementation((name: string, handler: (event: any) => void) => {
      handlers[name] = handler;
      return () => {};
    });
    let overlay: OverlayState | undefined;

    await startQuestion(
      api,
      config(),
      "main",
      "session-1",
      ((next: OverlayState | undefined) => {
        overlay = next;
      }) as any,
      { get: () => undefined, set: vi.fn() },
      { get: () => undefined, set: vi.fn() },
      { get: () => false, set: vi.fn() },
      vi.fn(),
    );

    (getSessionEntries as any).mockReturnValue([
      {
        info: { id: "assistant-1", role: "assistant" },
        parts: [{ type: "text", text: "stale persisted answer" }],
      },
    ]);

    handlers["message.updated"]({
      properties: {
        sessionID: "mini-session",
        info: { id: "assistant-1", role: "assistant" },
      },
    });

    handlers["message.part.updated"]({
      properties: {
        sessionID: "mini-session",
        part: {
          id: "text-1",
          messageID: "assistant-1",
          type: "text",
          text: "helo",
        },
      },
    });

    expect(overlay?.state.runtime.messages["assistant-1"]?.parts).toEqual([
      {
        id: "text-1",
        messageID: "assistant-1",
        type: "text",
        text: "helo",
      },
    ]);

    (getSessionEntries as any).mockReturnValue([
      {
        info: { id: "assistant-1", role: "assistant" },
        parts: [{ type: "text", text: "hello" }],
      },
    ]);

    handlers["message.updated"]({
      properties: {
        sessionID: "mini-session",
        info: { id: "assistant-1", role: "assistant" },
      },
    });

    expect(overlay?.state.runtime.messages["assistant-1"]?.parts).toEqual([
      {
        id: "assistant-1:text:0",
        messageID: "assistant-1",
        type: "text",
        text: "hello",
      },
    ]);
  });

  it("keeps earlier persisted text parts while protecting a later dirty live text part", async () => {
    resolveRuntimeMiniAgent.mockResolvedValue(resolvedAgent());

    const handlers: Record<string, (event: any) => void> = {};
    const api = fakeApi();
    api.event.on.mockImplementation((name: string, handler: (event: any) => void) => {
      handlers[name] = handler;
      return () => {};
    });
    let overlay: OverlayState | undefined;

    await startQuestion(
      api,
      config(),
      "main",
      "session-1",
      ((next: OverlayState | undefined) => {
        overlay = next;
      }) as any,
      { get: () => undefined, set: vi.fn() },
      { get: () => undefined, set: vi.fn() },
      { get: () => false, set: vi.fn() },
      vi.fn(),
    );

    (getSessionEntries as any).mockReturnValue([
      {
        info: { id: "assistant-1", role: "assistant" },
        parts: [
          { type: "text", text: "persisted intro" },
          { type: "text", text: "stale persisted ending" },
        ],
      },
    ]);

    handlers["message.updated"]({
      properties: {
        sessionID: "mini-session",
        info: { id: "assistant-1", role: "assistant" },
      },
    });

    handlers["message.part.updated"]({
      properties: {
        sessionID: "mini-session",
        part: {
          id: "text-live-2",
          messageID: "assistant-1",
          type: "text",
          text: "corrected live ending",
        },
      },
    });

    expect(overlay?.state.runtime.messages["assistant-1"]?.parts).toEqual([
      {
        id: "assistant-1:text:0",
        messageID: "assistant-1",
        type: "text",
        text: "persisted intro",
      },
      {
        id: "text-live-2",
        messageID: "assistant-1",
        type: "text",
        text: "corrected live ending",
      },
    ]);
  });

  it("keeps a later persisted text segment when a direct live update targets the first segment", async () => {
    resolveRuntimeMiniAgent.mockResolvedValue(resolvedAgent());

    const handlers: Record<string, (event: any) => void> = {};
    const api = fakeApi();
    api.event.on.mockImplementation((name: string, handler: (event: any) => void) => {
      handlers[name] = handler;
      return () => {};
    });
    let overlay: OverlayState | undefined;

    await startQuestion(
      api,
      config(),
      "main",
      "session-1",
      ((next: OverlayState | undefined) => {
        overlay = next;
      }) as any,
      { get: () => undefined, set: vi.fn() },
      { get: () => undefined, set: vi.fn() },
      { get: () => false, set: vi.fn() },
      vi.fn(),
    );

    (getSessionEntries as any).mockReturnValue([
      {
        info: { id: "assistant-1", role: "assistant" },
        parts: [
          { type: "text", text: "stale persisted intro" },
          { type: "text", text: "persisted ending" },
        ],
      },
    ]);

    handlers["message.updated"]({
      properties: {
        sessionID: "mini-session",
        info: { id: "assistant-1", role: "assistant" },
      },
    });

    handlers["message.part.updated"]({
      properties: {
        sessionID: "mini-session",
        part: {
          id: "text-live-1",
          messageID: "assistant-1",
          type: "text",
          text: "corrected live intro",
        },
      },
    });

    expect(overlay?.state.runtime.messages["assistant-1"]?.parts).toEqual([
      {
        id: "text-live-1",
        messageID: "assistant-1",
        type: "text",
        text: "corrected live intro",
      },
      {
        id: "assistant-1:text:1",
        messageID: "assistant-1",
        type: "text",
        text: "persisted ending",
      },
    ]);
  });

  it("keeps later hydrated persisted segments after an identified live text update arrived first", async () => {
    vi.useFakeTimers();
    resolveRuntimeMiniAgent.mockResolvedValue(resolvedAgent());

    const handlers: Record<string, (event: any) => void> = {};
    const api = fakeApi();
    api.event.on.mockImplementation((name: string, handler: (event: any) => void) => {
      handlers[name] = handler;
      return () => {};
    });
    let overlay: OverlayState | undefined;

    await startQuestion(
      api,
      config(),
      "main",
      "session-1",
      ((next: OverlayState | undefined) => {
        overlay = next;
      }) as any,
      { get: () => undefined, set: vi.fn() },
      { get: () => undefined, set: vi.fn() },
      { get: () => false, set: vi.fn() },
      vi.fn(),
    );

    handlers["session.next.text.delta"]({
      properties: {
        sessionID: "mini-session",
        assistantMessageID: "assistant-1",
        textID: "text-live-2",
        delta: "live ending",
      },
    });
    await flushStreamingRender();

    (getSessionEntries as any).mockReturnValue([
      {
        info: { id: "assistant-1", role: "assistant" },
        parts: [
          { type: "text", text: "persisted intro" },
          { type: "text", text: "stale ending before live" },
        ],
      },
    ]);

    handlers["message.updated"]({
      properties: {
        sessionID: "mini-session",
        info: { id: "assistant-1", role: "assistant" },
      },
    });

    expect(overlay?.state.runtime.messages["assistant-1"]?.parts).toEqual([
      {
        id: "assistant-1:text:0",
        messageID: "assistant-1",
        type: "text",
        text: "persisted intro",
      },
      {
        id: "text-live-2",
        messageID: "assistant-1",
        type: "text",
        text: "live ending",
      },
    ]);
  });

  it("does not resurrect a removed identified live text part after refresh", async () => {
    vi.useFakeTimers();
    resolveRuntimeMiniAgent.mockResolvedValue(resolvedAgent());

    const handlers: Record<string, (event: any) => void> = {};
    const api = fakeApi();
    api.event.on.mockImplementation((name: string, handler: (event: any) => void) => {
      handlers[name] = handler;
      return () => {};
    });
    let overlay: OverlayState | undefined;

    await startQuestion(
      api,
      config(),
      "main",
      "session-1",
      ((next: OverlayState | undefined) => {
        overlay = next;
      }) as any,
      { get: () => undefined, set: vi.fn() },
      { get: () => undefined, set: vi.fn() },
      { get: () => false, set: vi.fn() },
      vi.fn(),
    );

    handlers["session.next.text.delta"]({
      properties: {
        sessionID: "mini-session",
        assistantMessageID: "assistant-1",
        textID: "text-live-1",
        delta: "live answer",
      },
    });
    await flushStreamingRender();

    expect(overlay?.state.runtime.messages["assistant-1"]?.parts).toEqual([
      {
        id: "text-live-1",
        messageID: "assistant-1",
        type: "text",
        text: "live answer",
      },
    ]);

    handlers["message.part.removed"]({
      properties: {
        sessionID: "mini-session",
        messageID: "assistant-1",
        partID: "text-live-1",
      },
    });

    expect(overlay?.state.runtime.messages["assistant-1"]?.parts).toEqual([]);

    (getSessionEntries as any).mockReturnValue([
      {
        info: { id: "assistant-1", role: "assistant" },
        parts: [],
      },
    ]);

    handlers["message.updated"]({
      properties: {
        sessionID: "mini-session",
        info: { id: "assistant-1", role: "assistant" },
      },
    });

    expect(overlay?.state.runtime.messages["assistant-1"]?.parts).toEqual([]);
  });

  it("registers an active controller before agent resolution completes", async () => {
    const agentResolution = deferred<any>();
    resolveRuntimeMiniAgent.mockReturnValue(agentResolution.promise);

    const api = fakeApi();
    let activeDialog: ActiveDialogController | undefined;
    const active = {
      get: () => activeDialog,
      set: (dialog: ActiveDialogController | undefined) => {
        activeDialog = dialog;
      },
    };
    const modelPreference: ModelPreferenceState = {
      get: () => undefined,
      set: vi.fn(),
    };
    const thinkingPreference: ThinkingPreferenceState = {
      get: () => false,
      set: vi.fn(),
    };

    const opening = startQuestion(
      api,
      config(),
      "main",
      "session-1",
      vi.fn(),
      active,
      modelPreference,
      thinkingPreference,
      vi.fn(),
    );

    await Promise.resolve();
    expect(activeDialog).toBeDefined();

    await activeDialog?.close();
    agentResolution.resolve({
      mode: "plugin-managed",
      requestedAgent: null,
      agent: null,
      permission: [],
      permissionSource: "plugin-managed",
      notices: [],
    });

    await opening;
    expect(activeDialog).toBeUndefined();
  });

  it("skips copied context formatting in fresh mode", async () => {
    const agentResolution = deferred<any>();
    resolveRuntimeMiniAgent.mockReturnValue(agentResolution.promise);

    const opening = startQuestion(
      fakeApi(),
      config(),
      "fresh",
      "session-1",
      vi.fn(),
      { get: () => undefined, set: vi.fn() },
      { get: () => undefined, set: vi.fn() },
      { get: () => false, set: vi.fn() },
      vi.fn(),
    );

    await Promise.resolve();
    expect(buildCopiedContext).not.toHaveBeenCalled();

    agentResolution.resolve({
      mode: "plugin-managed",
      requestedAgent: null,
      agent: null,
      permission: [],
      permissionSource: "plugin-managed",
      notices: [],
    });

    await opening;
  });

  it("shows copied-context usage when main mini opens", async () => {
    resolveRuntimeMiniAgent.mockResolvedValue(resolvedAgent());

    let overlay: OverlayState | undefined;

    await startQuestion(
      fakeApi(),
      config(),
      "main",
      "session-1",
      ((next: OverlayState | undefined) => {
        overlay = next;
      }) as any,
      { get: () => undefined, set: vi.fn() },
      { get: () => undefined, set: vi.fn() },
      { get: () => false, set: vi.fn() },
      vi.fn(),
    );

    expect(overlay?.state.footerCounter).toEqual({
      copiedContext: {
        usedTokens: 31_000,
        totalAvailableTokens: 31_000,
        tokenLimit: 50_000,
        text: "main 31.0K",
        truncated: false,
      },
      miniSession: undefined,
      placeholder: undefined,
    });
  });

  it("shows no counter when fresh mini opens", async () => {
    resolveRuntimeMiniAgent.mockResolvedValue(resolvedAgent());

    let overlay: OverlayState | undefined;

    await startQuestion(
      fakeApi(),
      config(),
      "fresh",
      "session-1",
      ((next: OverlayState | undefined) => {
        overlay = next;
      }) as any,
      { get: () => undefined, set: vi.fn() },
      { get: () => undefined, set: vi.fn() },
      { get: () => false, set: vi.fn() },
      vi.fn(),
    );

    expect(overlay?.state.footerCounter).toEqual({
      copiedContext: undefined,
      miniSession: undefined,
      placeholder: undefined,
    });
  });

  it("stores exact completed input tokens after session idle", async () => {
    resolveRuntimeMiniAgent.mockResolvedValue(resolvedAgent());
    (getSessionEntries as any).mockReturnValue([
      assistantEntry({
        id: "assistant-1",
        text: "answer",
        inputTokens: 11_240,
        completed: true,
      }),
    ]);

    const handlers: Record<string, (event: any) => void> = {};
    const api = fakeApi();
    api.event.on.mockImplementation((name: string, handler: (event: any) => void) => {
      handlers[name] = handler;
      return () => {};
    });
    let overlay: OverlayState | undefined;
    const modelPreference: any = {
      get: () => ({
        model: {
          providerID: "anthropic",
          modelID: "claude-sonnet-4.6",
        },
        variant: "fast",
      }),
      set: vi.fn(),
    };

    await startQuestion(
      api,
      config(),
      "main",
      "session-1",
      ((next: OverlayState | undefined) => {
        overlay = next;
      }) as any,
      { get: () => undefined, set: vi.fn() },
      modelPreference,
      { get: () => false, set: vi.fn() },
      vi.fn(),
    );

    handlers["session.idle"]({ properties: { sessionID: "mini-session" } });

    expect(overlay?.state.lastCompletedMiniInputTokens).toBe(11_240);
    expect(overlay?.state.footerCounter.miniSession?.text).toBe("11.2K (6%)");
  });

  it("keeps the last completed exact value while a later response streams", async () => {
    vi.useFakeTimers();
    resolveRuntimeMiniAgent.mockResolvedValue(resolvedAgent());

    const handlers: Record<string, (event: any) => void> = {};
    const api = fakeApi();
    (getSessionEntries as any).mockReturnValue([
      assistantEntry({
        id: "assistant-1",
        text: "answer",
        inputTokens: 11_240,
        completed: true,
      }),
    ]);
    api.event.on.mockImplementation((name: string, handler: (event: any) => void) => {
      handlers[name] = handler;
      return () => {};
    });
    let overlay: OverlayState | undefined;
    const modelPreference: any = {
      get: () => ({
        model: {
          providerID: "anthropic",
          modelID: "claude-sonnet-4.6",
        },
        variant: "fast",
      }),
      set: vi.fn(),
    };

    await startQuestion(
      api,
      config(),
      "main",
      "session-1",
      ((next: OverlayState | undefined) => {
        overlay = next;
      }) as any,
      { get: () => undefined, set: vi.fn() },
      modelPreference,
      { get: () => false, set: vi.fn() },
      vi.fn(),
    );

    handlers["session.idle"]({ properties: { sessionID: "mini-session" } });
    (getSessionEntries as any).mockReturnValue([
      assistantEntry({
        id: "assistant-1",
        text: "answer",
        inputTokens: 11_240,
        completed: true,
      }),
      assistantEntry({ id: "assistant-2", text: "streaming" }),
    ]);

    handlers["session.next.text.delta"]({
      properties: { sessionID: "mini-session", delta: "more" },
    });
    await flushStreamingRender();

    expect(overlay?.state.lastCompletedMiniInputTokens).toBe(11_240);
    expect(overlay?.state.footerCounter.miniSession?.text).toBe("11.2K (6%)");
  });

  it("includes cached input tokens after later completed responses", async () => {
    resolveRuntimeMiniAgent.mockResolvedValue(resolvedAgent());

    const handlers: Record<string, (event: any) => void> = {};
    const api = fakeApi();
    (getSessionEntries as any).mockReturnValue([
      assistantEntry({
        id: "assistant-1",
        text: "answer",
        inputTokens: 5_240,
        completed: true,
      }),
    ]);
    api.event.on.mockImplementation((name: string, handler: (event: any) => void) => {
      handlers[name] = handler;
      return () => {};
    });
    let overlay: OverlayState | undefined;
    const modelPreference: any = {
      get: () => ({
        model: {
          providerID: "anthropic",
          modelID: "claude-sonnet-4.6",
        },
        variant: "fast",
      }),
      set: vi.fn(),
    };

    await startQuestion(
      api,
      config(),
      "main",
      "session-1",
      ((next: OverlayState | undefined) => {
        overlay = next;
      }) as any,
      { get: () => undefined, set: vi.fn() },
      modelPreference,
      { get: () => false, set: vi.fn() },
      vi.fn(),
    );

    handlers["session.idle"]({ properties: { sessionID: "mini-session" } });

    expect(overlay?.state.footerCounter.miniSession?.text).toBe("5.2K (3%)");

    (getSessionEntries as any).mockReturnValue([
      assistantEntry({
        id: "assistant-1",
        text: "answer",
        inputTokens: 5_240,
        completed: true,
      }),
      assistantEntry({
        id: "assistant-2",
        text: "follow up",
        inputTokens: 94,
        cacheReadTokens: 5_240,
        completed: true,
      }),
    ]);

    handlers["session.idle"]({ properties: { sessionID: "mini-session" } });

    expect(overlay?.state.lastCompletedMiniInputTokens).toBe(5_334);
    expect(overlay?.state.footerCounter.miniSession?.text).toBe("5.3K (3%)");
  });

  it("treats a lower later input value as a one-time incremental delta", async () => {
    resolveRuntimeMiniAgent.mockResolvedValue(resolvedAgent());

    const handlers: Record<string, (event: any) => void> = {};
    const api = fakeApi();
    (getSessionEntries as any).mockReturnValue([
      assistantEntry({
        id: "assistant-1",
        text: "answer",
        inputTokens: 5_240,
        completed: true,
      }),
    ]);
    api.event.on.mockImplementation((name: string, handler: (event: any) => void) => {
      handlers[name] = handler;
      return () => {};
    });
    let overlay: OverlayState | undefined;
    const modelPreference: any = {
      get: () => ({
        model: {
          providerID: "anthropic",
          modelID: "claude-sonnet-4.6",
        },
        variant: "fast",
      }),
      set: vi.fn(),
    };

    await startQuestion(
      api,
      config(),
      "main",
      "session-1",
      ((next: OverlayState | undefined) => {
        overlay = next;
      }) as any,
      { get: () => undefined, set: vi.fn() },
      modelPreference,
      { get: () => false, set: vi.fn() },
      vi.fn(),
    );

    handlers["session.idle"]({ properties: { sessionID: "mini-session" } });
    (getSessionEntries as any).mockReturnValue([
      assistantEntry({
        id: "assistant-1",
        text: "answer",
        inputTokens: 5_240,
        completed: true,
      }),
      assistantEntry({
        id: "assistant-2",
        text: "follow up",
        inputTokens: 94,
        completed: true,
      }),
    ]);

    handlers["session.idle"]({ properties: { sessionID: "mini-session" } });
    handlers["message.updated"]({ properties: { sessionID: "mini-session" } });

    expect(overlay?.state.lastCompletedMiniInputTokens).toBe(5_334);
    expect(overlay?.state.footerCounter.miniSession?.text).toBe("5.3K (3%)");
  });

  it.each(["main", "fresh"] as const)(
    "increments the second completed response once in %s mode when updated before idle",
    async (mode) => {
      resolveRuntimeMiniAgent.mockResolvedValue(resolvedAgent());

      const handlers: Record<string, (event: any) => void> = {};
      const api = fakeApi();
      (getSessionEntries as any).mockReturnValue([
        assistantEntry({
          id: "assistant-1",
          text: "answer",
          inputTokens: 5_240,
          completed: true,
        }),
      ]);
      api.event.on.mockImplementation((name: string, handler: (event: any) => void) => {
        handlers[name] = handler;
        return () => {};
      });
      let overlay: OverlayState | undefined;
      const modelPreference: any = {
        get: () => ({
          model: {
            providerID: "anthropic",
            modelID: "claude-sonnet-4.6",
          },
          variant: "fast",
        }),
        set: vi.fn(),
      };

      await startQuestion(
        api,
        config(),
        mode,
        "session-1",
        ((next: OverlayState | undefined) => {
          overlay = next;
        }) as any,
        { get: () => undefined, set: vi.fn() },
        modelPreference,
        { get: () => false, set: vi.fn() },
        vi.fn(),
      );

      handlers["session.idle"]({ properties: { sessionID: "mini-session" } });
      expect(overlay?.state.lastCompletedMiniInputTokens).toBe(5_240);

      (getSessionEntries as any).mockReturnValue([
        assistantEntry({
          id: "assistant-1",
          text: "answer",
          inputTokens: 5_240,
          completed: true,
        }),
        assistantEntry({
          id: "assistant-2",
          text: "follow up",
          inputTokens: 94,
          completed: true,
        }),
      ]);

      handlers["message.updated"]({ properties: { sessionID: "mini-session" } });
      handlers["session.idle"]({ properties: { sessionID: "mini-session" } });

      expect(overlay?.state.lastCompletedMiniInputTokens).toBe(5_334);
      expect(overlay?.state.footerCounter.miniSession?.text).toBe("5.3K (3%)");
    },
  );

  it.each(["main", "fresh"] as const)(
    "increments the second completed response once in %s mode when its total equals the previous counter",
    async (mode) => {
      resolveRuntimeMiniAgent.mockResolvedValue(resolvedAgent());

      const handlers: Record<string, (event: any) => void> = {};
      const api = fakeApi();
      (getSessionEntries as any).mockReturnValue([
        assistantEntry({
          id: "assistant-1",
          text: "answer",
          inputTokens: 5_240,
          completed: true,
        }),
      ]);
      api.event.on.mockImplementation((name: string, handler: (event: any) => void) => {
        handlers[name] = handler;
        return () => {};
      });
      let overlay: OverlayState | undefined;
      const modelPreference: any = {
        get: () => ({
          model: {
            providerID: "anthropic",
            modelID: "claude-sonnet-4.6",
          },
          variant: "fast",
        }),
        set: vi.fn(),
      };

      await startQuestion(
        api,
        config(),
        mode,
        "session-1",
        ((next: OverlayState | undefined) => {
          overlay = next;
        }) as any,
        { get: () => undefined, set: vi.fn() },
        modelPreference,
        { get: () => false, set: vi.fn() },
        vi.fn(),
      );

      handlers["session.idle"]({ properties: { sessionID: "mini-session" } });
      (getSessionEntries as any).mockReturnValue([
        assistantEntry({
          id: "assistant-1",
          text: "answer",
          inputTokens: 5_240,
          completed: true,
        }),
        assistantEntry({
          id: "assistant-2",
          text: "follow up",
          inputTokens: 94,
          cacheReadTokens: 5_146,
          completed: true,
        }),
      ]);

      handlers["message.updated"]({ properties: { sessionID: "mini-session" } });
      handlers["session.idle"]({ properties: { sessionID: "mini-session" } });

      expect(overlay?.state.lastCompletedMiniInputTokens).toBe(5_334);
      expect(overlay?.state.footerCounter.miniSession?.text).toBe("5.3K (3%)");
    },
  );

  it("updates completed input tokens when cache metadata arrives after idle", async () => {
    resolveRuntimeMiniAgent.mockResolvedValue(resolvedAgent());

    const handlers: Record<string, (event: any) => void> = {};
    const api = fakeApi();
    (getSessionEntries as any).mockReturnValue([
      assistantEntry({
        id: "assistant-1",
        text: "answer",
        inputTokens: 5_240,
        completed: true,
      }),
    ]);
    api.event.on.mockImplementation((name: string, handler: (event: any) => void) => {
      handlers[name] = handler;
      return () => {};
    });
    let overlay: OverlayState | undefined;
    const modelPreference: any = {
      get: () => ({
        model: {
          providerID: "anthropic",
          modelID: "claude-sonnet-4.6",
        },
        variant: "fast",
      }),
      set: vi.fn(),
    };

    await startQuestion(
      api,
      config(),
      "main",
      "session-1",
      ((next: OverlayState | undefined) => {
        overlay = next;
      }) as any,
      { get: () => undefined, set: vi.fn() },
      modelPreference,
      { get: () => false, set: vi.fn() },
      vi.fn(),
    );

    handlers["session.idle"]({ properties: { sessionID: "mini-session" } });
    (getSessionEntries as any).mockReturnValue([
      assistantEntry({
        id: "assistant-1",
        text: "answer",
        inputTokens: 5_240,
        completed: true,
      }),
      assistantEntry({
        id: "assistant-2",
        text: "follow up",
        inputTokens: 94,
        completed: true,
      }),
    ]);

    handlers["session.idle"]({ properties: { sessionID: "mini-session" } });
    expect(overlay?.state.lastCompletedMiniInputTokens).toBe(5_334);

    (getSessionEntries as any).mockReturnValue([
      assistantEntry({
        id: "assistant-1",
        text: "answer",
        inputTokens: 5_240,
        completed: true,
      }),
      assistantEntry({
        id: "assistant-2",
        text: "follow up",
        inputTokens: 94,
        cacheReadTokens: 5_900,
        completed: true,
      }),
    ]);

    handlers["message.updated"]({ properties: { sessionID: "mini-session" } });

    expect(overlay?.state.lastCompletedMiniInputTokens).toBe(5_994);
    expect(overlay?.state.footerCounter.miniSession?.text).toBe("6.0K (3%)");
  });

  it("recalculates percentages immediately after a model change", async () => {
    resolveRuntimeMiniAgent.mockResolvedValue(resolvedAgent());

    const api = fakeApi();
    let overlay: OverlayState | undefined;
    const modelPreference: any = {
      get: vi.fn(() => undefined),
      set: vi.fn(),
    };

    await startQuestion(
      api,
      config(),
      "main",
      "session-1",
      ((next: OverlayState | undefined) => {
        overlay = next;
      }) as any,
      { get: () => undefined, set: vi.fn() },
      modelPreference,
      { get: () => false, set: vi.fn() },
      (onAfterSelect) => {
        if (!overlay) return;
        overlay.state.lastCompletedMiniInputTokens = 100_000;
        modelPreference.get.mockReturnValue({
          model: {
            providerID: "anthropic",
            modelID: "claude-sonnet-4.6",
          },
          variant: "fast",
        });
        onAfterSelect();
      },
    );

    overlay?.onChangeModel();

    expect(overlay?.state.modelContextWindow).toBe(200_000);
    expect(overlay?.state.footerCounter.miniSession?.text).toBe("100.0K (50%)");
  });

  it("changes the placeholder only after the exact mini-session value crosses the limit threshold", async () => {
    resolveRuntimeMiniAgent.mockResolvedValue(resolvedAgent());

    const api = fakeApi();
    let overlay: OverlayState | undefined;
    const modelPreference: any = {
      get: vi.fn(() => undefined),
      set: vi.fn(),
    };

    await startQuestion(
      api,
      config(),
      "main",
      "session-1",
      ((next: OverlayState | undefined) => {
        overlay = next;
      }) as any,
      { get: () => undefined, set: vi.fn() },
      modelPreference,
      { get: () => false, set: vi.fn() },
      (onAfterSelect) => {
        if (!overlay) return;
        overlay.state.lastCompletedMiniInputTokens = 196_000;
        modelPreference.get.mockReturnValue({
          model: {
            providerID: "anthropic",
            modelID: "claude-sonnet-4.6",
          },
          variant: "fast",
        });
        onAfterSelect();
      },
    );

    expect(overlay?.state.inputPlaceholder).toBeUndefined();

    overlay?.onChangeModel();

    expect(overlay?.state.inputPlaceholder).toBe(
      "Session context limit reached...",
    );
  });

  it("hides percentages and threshold effects when the model context window is unknown", async () => {
    resolveRuntimeMiniAgent.mockResolvedValue(resolvedAgent());

    const api = fakeApi();
    let overlay: OverlayState | undefined;
    const modelPreference: any = {
      get: vi.fn(() => undefined),
      set: vi.fn(),
    };

    await startQuestion(
      api,
      config(),
      "main",
      "session-1",
      ((next: OverlayState | undefined) => {
        overlay = next;
      }) as any,
      { get: () => undefined, set: vi.fn() },
      modelPreference,
      { get: () => false, set: vi.fn() },
      (onAfterSelect) => {
        if (!overlay) return;
        overlay.state.lastCompletedMiniInputTokens = 196_000;
        modelPreference.get.mockReturnValue({
          model: {
            providerID: "openai",
            modelID: "gpt-5",
          },
        });
        onAfterSelect();
      },
    );

    overlay?.onChangeModel();

    expect(overlay?.state.modelContextWindow).toBeUndefined();
    expect(overlay?.state.footerCounter.miniSession?.text).toBe("196.0K");
    expect(overlay?.state.footerCounter.miniSession?.warning).toBe(false);
    expect(overlay?.state.inputPlaceholder).toBeUndefined();
  });

  it("uses the fresh keybind in the hide toast", async () => {
    const agentResolution = deferred<any>();
    resolveRuntimeMiniAgent.mockReturnValue(agentResolution.promise);

    const api = fakeApi();
    let activeDialog: ActiveDialogController | undefined;

    const opening = startQuestion(
      api,
      config(),
      "fresh",
      "session-1",
      vi.fn(),
      {
        get: () => activeDialog,
        set: (dialog: ActiveDialogController | undefined) => {
          activeDialog = dialog;
        },
      },
      { get: () => undefined, set: vi.fn() },
      { get: () => false, set: vi.fn() },
      vi.fn(),
    );

    await Promise.resolve();
    activeDialog?.hide();

    expect(api.ui.toast).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "mini hidden. Press alt+n to show it.",
      }),
    );

    agentResolution.resolve({
      mode: "plugin-managed",
      requestedAgent: null,
      agent: null,
      permission: [],
      permissionSource: "plugin-managed",
      notices: [],
    });

    await opening;
  });

  it("hides the mini overlay during a matching permission prompt and restores it after reply", async () => {
    resolveRuntimeMiniAgent.mockResolvedValue(resolvedAgent());

    const handlers: Record<string, (event: any) => void> = {};
    const api = fakeApi();
    api.event.on.mockImplementation((name: string, handler: (event: any) => void) => {
      handlers[name] = handler;
      return () => {};
    });
    const overlays: Array<OverlayState | undefined> = [];
    let overlay: OverlayState | undefined;

    await startQuestion(
      api,
      config(),
      "main",
      "session-1",
      ((next: OverlayState | undefined) => {
        overlay = next;
        overlays.push(next);
      }) as any,
      { get: () => undefined, set: vi.fn() },
      { get: () => undefined, set: vi.fn() },
      { get: () => false, set: vi.fn() },
      vi.fn(),
    );

    handlers["permission.asked"]({
      properties: {
        sessionID: "mini-session",
        id: "perm-1",
        permission: "external_directory",
      },
    });

    expect(overlay).toBeUndefined();
    expect(api.ui.toast).not.toHaveBeenCalledWith(
      expect.objectContaining({
        message: "mini hidden. Press alt+b to show it.",
      }),
    );

    handlers["permission.replied"]({
      properties: { sessionID: "mini-session", requestID: "perm-1", reply: "once" },
    });

    expect(overlay).toBeDefined();
    expect(overlays.at(-1)).toBeDefined();
  });

  it("waits for all matching permission replies before restoring the mini overlay", async () => {
    resolveRuntimeMiniAgent.mockResolvedValue(resolvedAgent());

    const handlers: Record<string, (event: any) => void> = {};
    const api = fakeApi();
    api.event.on.mockImplementation((name: string, handler: (event: any) => void) => {
      handlers[name] = handler;
      return () => {};
    });
    let overlay: OverlayState | undefined;

    await startQuestion(
      api,
      config(),
      "main",
      "session-1",
      ((next: OverlayState | undefined) => {
        overlay = next;
      }) as any,
      { get: () => undefined, set: vi.fn() },
      { get: () => undefined, set: vi.fn() },
      { get: () => false, set: vi.fn() },
      vi.fn(),
    );

    handlers["permission.asked"]({
      properties: {
        sessionID: "mini-session",
        id: "perm-1",
        permission: "external_directory",
      },
    });
    handlers["permission.asked"]({
      properties: {
        sessionID: "mini-session",
        id: "perm-2",
        permission: "external_directory",
      },
    });

    expect(overlay).toBeUndefined();

    handlers["permission.replied"]({
      properties: { sessionID: "mini-session", requestID: "perm-1", reply: "once" },
    });

    expect(overlay).toBeUndefined();

    handlers["permission.replied"]({
      properties: { sessionID: "mini-session", requestID: "perm-2", reply: "once" },
    });

    expect(overlay).toBeDefined();
  });

  it("closes and shows an error if agent resolution fails", async () => {
    const api = fakeApi();
    let activeDialog: ActiveDialogController | undefined;

    resolveRuntimeMiniAgent.mockRejectedValue(new Error("agent lookup failed"));

    const opening = startQuestion(
      api,
      config(),
      "main",
      "session-1",
      vi.fn(),
      {
        get: () => activeDialog,
        set: (dialog: ActiveDialogController | undefined) => {
          activeDialog = dialog;
        },
      },
      { get: () => undefined, set: vi.fn() },
      { get: () => false, set: vi.fn() },
      vi.fn(),
    );

    await opening;

    expect(activeDialog).toBeUndefined();
    expect(api.ui.toast).toHaveBeenCalledWith(
      expect.objectContaining({
        variant: "error",
        message: "Failed to open mini session: agent lookup failed",
      }),
    );
  });
});
