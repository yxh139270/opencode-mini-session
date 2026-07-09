import { describe, expect, it } from "vitest";
import {
  getLastAssistantTextPartContext,
  getMiniRuntimeTranscript,
} from "../src/mini-runtime/transcript";
import {
  applyMessageUpdated,
  applyPartUpdated,
  createMiniRuntimeStore,
} from "../src/mini-runtime/store";

describe("mini runtime transcript", () => {
  it("keeps historical assistant messages visible when a newer assistant message exists", () => {
    const runtime = createMiniRuntimeStore();

    applyMessageUpdated(runtime, {
      id: "assistant-1",
      role: "assistant",
    });
    applyPartUpdated(runtime, {
      id: "part-1",
      messageID: "assistant-1",
      type: "text",
      text: "first assistant answer",
    });
    applyMessageUpdated(runtime, {
      id: "assistant-2",
      role: "assistant",
    });
    applyPartUpdated(runtime, {
      id: "part-2",
      messageID: "assistant-2",
      type: "text",
      text: "second assistant answer",
    });

    expect(getMiniRuntimeTranscript(runtime.getState())).toEqual([
      {
        info: {
          id: "assistant-1",
          role: "assistant",
        },
        parts: [
          {
            id: "part-1",
            messageID: "assistant-1",
            type: "text",
            text: "first assistant answer",
          },
        ],
      },
      {
        info: {
          id: "assistant-2",
          role: "assistant",
        },
        parts: [
          {
            id: "part-2",
            messageID: "assistant-2",
            type: "text",
            text: "second assistant answer",
          },
        ],
      },
    ]);
  });

  it("filters messages with no parts from the visible transcript", () => {
    const runtime = createMiniRuntimeStore();

    applyMessageUpdated(runtime, {
      id: "user-1",
      role: "user",
    });
    applyMessageUpdated(runtime, {
      id: "assistant-1",
      role: "assistant",
    });
    applyPartUpdated(runtime, {
      id: "part-1",
      messageID: "assistant-1",
      type: "text",
      text: "visible assistant answer",
    });

    expect(getMiniRuntimeTranscript(runtime.getState())).toEqual([
      {
        info: {
          id: "user-1",
          role: "user",
        },
        parts: [],
      },
      {
        info: {
          id: "assistant-1",
          role: "assistant",
        },
        parts: [
          {
            id: "part-1",
            messageID: "assistant-1",
            type: "text",
            text: "visible assistant answer",
          },
        ],
      },
    ]);
  });

  it("keeps transcript ordering stable from root message ordering", () => {
    const runtime = createMiniRuntimeStore();

    applyMessageUpdated(runtime, {
      id: "assistant-2",
      role: "assistant",
    });
    applyPartUpdated(runtime, {
      id: "part-2",
      messageID: "assistant-2",
      type: "text",
      text: "second in time, first in order",
    });
    applyMessageUpdated(runtime, {
      id: "user-1",
      role: "user",
    });
    applyPartUpdated(runtime, {
      id: "part-1",
      messageID: "user-1",
      type: "text",
      text: "user question",
    });
    applyMessageUpdated(runtime, {
      id: "assistant-1",
      role: "assistant",
    });
    applyPartUpdated(runtime, {
      id: "part-3",
      messageID: "assistant-1",
      type: "text",
      text: "third message",
    });

    expect(
      getMiniRuntimeTranscript(runtime.getState()).map((entry) => entry.info.id),
    ).toEqual(["assistant-2", "user-1", "assistant-1"]);
  });

  it("keeps assistant shells even when no text part exists yet", () => {
    const runtime = createMiniRuntimeStore();

    applyMessageUpdated(runtime, {
      id: "assistant-1",
      role: "assistant",
    });

    expect(getMiniRuntimeTranscript(runtime.getState())).toEqual([
      {
        info: {
          id: "assistant-1",
          role: "assistant",
        },
        parts: [],
      },
    ]);
  });

  it("preserves whitespace-only text structurally for presentation to decide on visibility", () => {
    const runtime = createMiniRuntimeStore();

    applyMessageUpdated(runtime, {
      id: "assistant-1",
      role: "assistant",
    });
    applyPartUpdated(runtime, {
      id: "part-1",
      messageID: "assistant-1",
      type: "text",
      text: "   ",
    });

    expect(getMiniRuntimeTranscript(runtime.getState())).toEqual([
      {
        info: {
          id: "assistant-1",
          role: "assistant",
        },
        parts: [
          {
            id: "part-1",
            messageID: "assistant-1",
            type: "text",
            text: "   ",
          },
        ],
      },
    ]);
  });

  it("returns stable assistant message and part context for the latest assistant text part", () => {
    const runtime = createMiniRuntimeStore();

    applyMessageUpdated(runtime, {
      id: "user-1",
      role: "user",
    });
    applyPartUpdated(runtime, {
      id: "part-1",
      messageID: "user-1",
      type: "text",
      text: "question",
    });
    applyMessageUpdated(runtime, {
      id: "assistant-1",
      role: "assistant",
    });
    applyPartUpdated(runtime, {
      id: "part-2",
      messageID: "assistant-1",
      type: "text",
      text: "older answer",
    });
    applyMessageUpdated(runtime, {
      id: "assistant-2",
      role: "assistant",
    });
    applyPartUpdated(runtime, {
      id: "part-3",
      messageID: "assistant-2",
      type: "text",
      text: "currently streaming",
    });

    expect(
      getLastAssistantTextPartContext(getMiniRuntimeTranscript(runtime.getState())),
    ).toEqual({
      entry: {
        info: {
          id: "assistant-2",
          role: "assistant",
        },
        parts: [
          {
            id: "part-3",
            messageID: "assistant-2",
            type: "text",
            text: "currently streaming",
          },
        ],
      },
      entryIndex: 2,
      message: {
        id: "assistant-2",
        role: "assistant",
      },
      part: {
        id: "part-3",
        messageID: "assistant-2",
        type: "text",
        text: "currently streaming",
      },
      partIndex: 0,
    });
  });

  it("returns assistant shell context when the latest assistant message has no parts yet", () => {
    const runtime = createMiniRuntimeStore();

    applyMessageUpdated(runtime, {
      id: "assistant-1",
      role: "assistant",
    });
    applyPartUpdated(runtime, {
      id: "part-1",
      messageID: "assistant-1",
      type: "text",
      text: "older answer",
    });
    applyMessageUpdated(runtime, {
      id: "assistant-2",
      role: "assistant",
    });

    expect(getLastAssistantTextPartContext(getMiniRuntimeTranscript(runtime.getState()))).toEqual({
      entry: {
        info: {
          id: "assistant-2",
          role: "assistant",
        },
        parts: [],
      },
      entryIndex: 1,
      message: {
        id: "assistant-2",
        role: "assistant",
      },
      part: undefined,
      partIndex: undefined,
    });
  });

  it("returns undefined when no assistant message exists", () => {
    const runtime = createMiniRuntimeStore();

    applyMessageUpdated(runtime, {
      id: "user-1",
      role: "user",
    });

    expect(getLastAssistantTextPartContext(getMiniRuntimeTranscript(runtime.getState()))).toBeUndefined();
  });
});
