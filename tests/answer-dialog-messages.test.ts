import { describe, expect, it } from "vitest";
import {
  buildMiniMessages,
  buildMiniSessionTranscript,
  extractAssistantTextFromState,
} from "../src/components/answer-dialog-messages";
import {
  applyMessageUpdated,
  applyPartUpdated,
  createMiniRuntimeStore,
} from "../src/mini-runtime/store";
import type { AnswerDialogState } from "../src/types";

function createState(): AnswerDialogState {
  return {
    mode: "main",
    entries: [],
    runtime: createMiniRuntimeStore().getState(),
    streamingAnswer: "",
    emptyResponseNotice: undefined,
    loading: false,
    scrollbarVisible: false,
    spinnerFrame: 0,
    footerCounter: {},
    thinkingEnabled: false,
    expandedThinkingPartIDs: {},
    messageModels: {},
  };
}

describe("answer dialog messages", () => {
  it("builds transcript rows from runtime messages without merging assistant entries", () => {
    const runtime = createMiniRuntimeStore();
    applyMessageUpdated(runtime, { id: "assistant-1", role: "assistant" });
    applyPartUpdated(runtime, {
      id: "part-1",
      messageID: "assistant-1",
      type: "text",
      text: "first",
    });
    applyMessageUpdated(runtime, { id: "assistant-2", role: "assistant" });
    applyPartUpdated(runtime, {
      id: "part-2",
      messageID: "assistant-2",
      type: "text",
      text: "second",
    });

    const state = createState();
    state.runtime = runtime.getState();

    expect(buildMiniMessages(state)).toEqual([
      {
        id: "assistant-1",
        role: "assistant",
        parts: [{ type: "text", text: "first" }],
        modelName: undefined,
      },
      {
        id: "assistant-2",
        role: "assistant",
        parts: [{ type: "text", text: "second" }],
        modelName: undefined,
      },
    ]);
  });

  it("keeps an empty assistant shell and overlays fallback streaming text into it", () => {
    const runtime = createMiniRuntimeStore();
    applyMessageUpdated(runtime, { id: "assistant-1", role: "assistant" });

    const state = createState();
    state.runtime = runtime.getState();
    state.loading = true;
    state.streamingAnswer = "still streaming";

    expect(buildMiniMessages(state)).toEqual([
      {
        id: "assistant-1",
        role: "assistant",
        parts: [{ type: "text", text: "still streaming", streaming: true }],
        modelName: undefined,
      },
    ]);
  });

  it("does not overlay fallback streaming text when runtime already has the same live text part", () => {
    const runtime = createMiniRuntimeStore();
    applyMessageUpdated(runtime, { id: "assistant-1", role: "assistant" });
    applyPartUpdated(runtime, {
      id: "part-1",
      messageID: "assistant-1",
      type: "text",
      text: "still streaming",
    });

    const state = createState();
    state.runtime = runtime.getState();
    state.loading = true;
    state.streamingAnswer = "still streaming";

    expect(buildMiniMessages(state)).toEqual([
      {
        id: "assistant-1",
        role: "assistant",
        parts: [{ type: "text", text: "still streaming", streaming: true }],
        modelName: undefined,
      },
    ]);
  });

  it("derives continue transcript and assistant text from runtime-first messages", () => {
    const runtime = createMiniRuntimeStore();
    applyMessageUpdated(runtime, { id: "user-1", role: "user" });
    applyPartUpdated(runtime, {
      id: "part-1",
      messageID: "user-1",
      type: "text",
      text: "question",
    });
    applyMessageUpdated(runtime, { id: "assistant-1", role: "assistant" });
    applyPartUpdated(runtime, {
      id: "part-2",
      messageID: "assistant-1",
      type: "text",
      text: "answer",
    });

    const state = createState();
    state.runtime = runtime.getState();

    expect(extractAssistantTextFromState(state)).toBe("answer");
    expect(buildMiniSessionTranscript(state)).toBe(
      "user:\nquestion\n\nassistant:\nanswer",
    );
  });

  it("does not treat the empty-response notice as assistant transcript content", () => {
    const state = createState();
    state.emptyResponseNotice = "No response generated.";

    expect(buildMiniMessages(state)).toEqual([]);
    expect(extractAssistantTextFromState(state)).toBe("");
    expect(buildMiniSessionTranscript(state)).toBe("");
  });

  it("shows fallback streaming text as a new assistant message after a later user message when legacy deltas lack identifiers", () => {
    const runtime = createMiniRuntimeStore();
    applyMessageUpdated(runtime, { id: "assistant-1", role: "assistant" });
    applyPartUpdated(runtime, {
      id: "part-1",
      messageID: "assistant-1",
      type: "text",
      text: "first answer",
    });
    applyMessageUpdated(runtime, { id: "user-2", role: "user" });
    applyPartUpdated(runtime, {
      id: "part-2",
      messageID: "user-2",
      type: "text",
      text: "follow-up question",
    });

    const state = createState();
    state.runtime = runtime.getState();
    state.loading = true;
    state.streamingAnswer = "second answer streaming";

    expect(buildMiniMessages(state)).toEqual([
      {
        id: "assistant-1",
        role: "assistant",
        parts: [{ type: "text", text: "first answer" }],
        modelName: undefined,
      },
      {
        id: "user-2",
        role: "user",
        parts: [{ type: "text", text: "follow-up question" }],
        modelName: undefined,
      },
      {
        id: "streaming-assistant",
        role: "assistant",
        parts: [{ type: "text", text: "second answer streaming", streaming: true }],
        modelName: undefined,
      },
    ]);
  });

  it("preserves legacy non-text assistant parts while replacing text content from runtime", () => {
    const runtime = createMiniRuntimeStore();
    applyMessageUpdated(runtime, { id: "assistant-1", role: "assistant" });
    applyPartUpdated(runtime, {
      id: "part-1",
      messageID: "assistant-1",
      type: "text",
      text: "runtime text",
    });

    const state = createState();
    state.runtime = runtime.getState();
    state.entries = [
      {
        info: { id: "assistant-1", role: "assistant" } as any,
        parts: [
          { type: "reasoning", text: "**Plan**\nThink first", id: "reason-1" } as any,
          { type: "text", text: "stale legacy text" } as any,
          {
            type: "tool",
            tool: "read",
            state: { status: "running", input: { file: "a.ts" } },
          } as any,
        ],
      },
    ];

    expect(buildMiniMessages(state)).toEqual([
      {
        id: "assistant-1",
        role: "assistant",
        modelName: undefined,
        parts: [
          {
            type: "reasoning",
            id: "reason-1",
            text: "**Plan**\nThink first",
            time: undefined,
            metadata: undefined,
          },
          {
            type: "text",
            text: "runtime text",
          },
          {
            type: "tool",
            status: "running",
            text: "→ Read a.ts",
          },
        ],
      },
    ]);
  });

  it("keeps legacy unidentified streaming text additive when runtime already has an older assistant text", () => {
    const runtime = createMiniRuntimeStore();
    applyMessageUpdated(runtime, { id: "assistant-1", role: "assistant" });
    applyPartUpdated(runtime, {
      id: "part-1",
      messageID: "assistant-1",
      type: "text",
      text: "hello",
    });

    const state = createState();
    state.runtime = runtime.getState();
    state.loading = true;
    state.streamingAnswer = " world";

    expect(buildMiniMessages(state)).toEqual([
      {
        id: "assistant-1",
        role: "assistant",
        modelName: undefined,
        parts: [{ type: "text", text: "hello world", streaming: true }],
      },
    ]);
  });

  it("marks only the last assistant text part as streaming while loading", () => {
    const runtime = createMiniRuntimeStore();
    applyMessageUpdated(runtime, { id: "assistant-1", role: "assistant" });
    applyPartUpdated(runtime, {
      id: "part-1",
      messageID: "assistant-1",
      type: "text",
      text: "intro",
    });
    applyPartUpdated(runtime, {
      id: "part-2",
      messageID: "assistant-1",
      type: "text",
      text: "streaming tail",
    });

    const state = createState();
    state.runtime = runtime.getState();
    state.loading = true;

    expect(buildMiniMessages(state)).toEqual([
      {
        id: "assistant-1",
        role: "assistant",
        modelName: undefined,
        parts: [
          { type: "text", text: "intro" },
          { type: "text", text: "streaming tail", streaming: true },
        ],
      },
    ]);
  });

  it("does not mark a previous assistant answer as streaming during a later user turn", () => {
    const runtime = createMiniRuntimeStore();
    applyMessageUpdated(runtime, { id: "assistant-1", role: "assistant" });
    applyPartUpdated(runtime, {
      id: "part-1",
      messageID: "assistant-1",
      type: "text",
      text: "formatted answer",
    });
    applyMessageUpdated(runtime, { id: "user-2", role: "user" });
    applyPartUpdated(runtime, {
      id: "part-2",
      messageID: "user-2",
      type: "text",
      text: "follow-up",
    });

    const state = createState();
    state.runtime = runtime.getState();
    state.loading = true;

    expect(buildMiniMessages(state)).toEqual([
      {
        id: "assistant-1",
        role: "assistant",
        modelName: undefined,
        parts: [{ type: "text", text: "formatted answer" }],
      },
      {
        id: "user-2",
        role: "user",
        modelName: undefined,
        parts: [{ type: "text", text: "follow-up" }],
      },
    ]);
  });

  it("avoids misplacing runtime text when legacy assistant content has multiple text parts", () => {
    const runtime = createMiniRuntimeStore();
    applyMessageUpdated(runtime, { id: "assistant-1", role: "assistant" });
    applyPartUpdated(runtime, {
      id: "part-2",
      messageID: "assistant-1",
      type: "text",
      text: "updated second",
    });

    const state = createState();
    state.runtime = runtime.getState();
    state.entries = [
      {
        info: { id: "assistant-1", role: "assistant" } as any,
        parts: [
          { type: "text", text: "first legacy" } as any,
          { type: "reasoning", text: "**Plan**\nthink", id: "reason-1" } as any,
          { type: "text", text: "second legacy" } as any,
        ],
      },
    ];

    expect(buildMiniMessages(state)).toEqual([
      {
        id: "assistant-1",
        role: "assistant",
        modelName: undefined,
        parts: [
          {
            type: "reasoning",
            id: "reason-1",
            text: "**Plan**\nthink",
            time: undefined,
            metadata: undefined,
          },
          { type: "text", text: "updated second" },
        ],
      },
    ]);
  });

  it("preserves non-text placement when runtime and legacy text counts differ", () => {
    const runtime = createMiniRuntimeStore();
    applyMessageUpdated(runtime, { id: "assistant-1", role: "assistant" });
    applyPartUpdated(runtime, {
      id: "part-2",
      messageID: "assistant-1",
      type: "text",
      text: "updated second",
    });

    const state = createState();
    state.runtime = runtime.getState();
    state.entries = [
      {
        info: { id: "assistant-1", role: "assistant" } as any,
        parts: [
          { type: "text", text: "first legacy" } as any,
          {
            type: "tool",
            tool: "read",
            state: { status: "running", input: { file: "a.ts" } },
          } as any,
          { type: "text", text: "second legacy" } as any,
        ],
      },
    ];

    expect(buildMiniMessages(state)).toEqual([
      {
        id: "assistant-1",
        role: "assistant",
        modelName: undefined,
        parts: [
          { type: "text", text: "updated second" },
          { type: "tool", status: "running", text: "→ Read a.ts" },
        ],
      },
    ]);
  });
});
