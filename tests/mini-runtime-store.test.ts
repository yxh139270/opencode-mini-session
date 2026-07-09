import { describe, expect, it } from "vitest";
import {
  applyPartDelta,
  applyPartRemoved,
  applyMessageUpdated,
  applyPartUpdated,
  applySessionError,
  applySessionIdle,
  createMiniRuntimeStore,
} from "../src/mini-runtime/store";
import { applySyncEvent } from "../src/mini-runtime/sync";

describe("mini runtime store", () => {
  it("returns an immutable snapshot so callers cannot mutate runtime state directly", () => {
    const runtime = createMiniRuntimeStore();

    applyMessageUpdated(runtime, {
      id: "assistant-1",
      role: "assistant",
    });

    const snapshot = runtime.getState();

    expect(() => {
      (snapshot.rootMessageIds as string[]).push("assistant-2");
    }).toThrow(TypeError);
    expect(() => {
      (snapshot.messages["assistant-1"]!.parts as {
        id: string;
        messageID: string;
        type: "text";
        text: string;
      }[]).push({
        id: "part-1",
        messageID: "assistant-1",
        type: "text",
        text: "mutated outside runtime",
      });
    }).toThrow(TypeError);

    expect(runtime.getState()).toEqual({
      error: null,
      messages: {
        "assistant-1": {
          info: {
            id: "assistant-1",
            role: "assistant",
          },
          parts: [],
        },
      },
      rootMessageIds: ["assistant-1"],
      status: "loading",
    });
  });

  it("returns the same snapshot instance between reads until a write changes state", () => {
    const runtime = createMiniRuntimeStore();

    const initialState = runtime.getState();

    expect(runtime.getState()).toBe(initialState);

    applyMessageUpdated(runtime, {
      id: "assistant-1",
      role: "assistant",
    });

    const stateAfterWrite = runtime.getState();

    expect(stateAfterWrite).not.toBe(initialState);
    expect(runtime.getState()).toBe(stateAfterWrite);
  });

  it("stores assistant messages and parts as a persistent message tree", () => {
    const runtime = createMiniRuntimeStore();

    expect(runtime.getState()).toEqual({
      error: null,
      messages: {},
      rootMessageIds: [],
      status: "loading",
    });

    applyMessageUpdated(runtime, {
      id: "assistant-1",
      role: "assistant",
    });

    const stateAfterMessage = runtime.getState();

    expect(stateAfterMessage).toEqual({
      error: null,
      messages: {
        "assistant-1": {
          info: {
            id: "assistant-1",
            role: "assistant",
          },
          parts: [],
        },
      },
      rootMessageIds: ["assistant-1"],
      status: "loading",
    });

    applyPartUpdated(runtime, {
      id: "part-1",
      messageID: "assistant-1",
      type: "text",
      text: "hello from mini runtime",
    });

    const stateAfterPart = runtime.getState();

    expect(stateAfterPart).not.toBe(stateAfterMessage);
    expect(stateAfterPart.messages).not.toBe(stateAfterMessage.messages);
    expect(stateAfterPart.messages["assistant-1"]).not.toBe(
      stateAfterMessage.messages["assistant-1"],
    );
    expect(stateAfterMessage.messages["assistant-1"]?.parts).toEqual([]);
    expect(stateAfterPart).toEqual({
      error: null,
      messages: {
        "assistant-1": {
          info: {
            id: "assistant-1",
            role: "assistant",
          },
          parts: [
            {
              id: "part-1",
              messageID: "assistant-1",
              type: "text",
              text: "hello from mini runtime",
            },
          ],
        },
      },
      rootMessageIds: ["assistant-1"],
      status: "loading",
    });
  });

  it("stores both user and assistant messages", () => {
    const runtime = createMiniRuntimeStore();

    applyMessageUpdated(runtime, {
      id: "user-1",
      role: "user",
    });
    applyMessageUpdated(runtime, {
      id: "assistant-1",
      role: "assistant",
    });

    expect(runtime.getState()).toEqual({
      error: null,
      messages: {
        "assistant-1": {
          info: {
            id: "assistant-1",
            role: "assistant",
          },
          parts: [],
        },
        "user-1": {
          info: {
            id: "user-1",
            role: "user",
          },
          parts: [],
        },
      },
      rootMessageIds: ["user-1", "assistant-1"],
      status: "loading",
    });
  });

  it("keeps transcript ordering stable from explicit first-seen message order", () => {
    const runtime = createMiniRuntimeStore();

    applyMessageUpdated(runtime, {
      id: "assistant-2",
      role: "assistant",
    });
    applyMessageUpdated(runtime, {
      id: "user-1",
      role: "user",
    });
    applyMessageUpdated(runtime, {
      id: "assistant-1",
      role: "assistant",
    });

    const stateBeforeUpdate = runtime.getState();

    expect(stateBeforeUpdate.rootMessageIds).toEqual([
      "assistant-2",
      "user-1",
      "assistant-1",
    ]);

    applyMessageUpdated(runtime, {
      id: "user-1",
      role: "user",
    });

    expect(runtime.getState()).toEqual({
      error: null,
      messages: {
        "assistant-1": {
          info: {
            id: "assistant-1",
            role: "assistant",
          },
          parts: [],
        },
        "assistant-2": {
          info: {
            id: "assistant-2",
            role: "assistant",
          },
          parts: [],
        },
        "user-1": {
          info: {
            id: "user-1",
            role: "user",
          },
          parts: [],
        },
      },
      rootMessageIds: ["assistant-2", "user-1", "assistant-1"],
      status: "loading",
    });
  });

  it("copies input objects on write so later caller mutation does not affect store state", () => {
    const runtime = createMiniRuntimeStore();
    const message = {
      id: "assistant-1",
      role: "assistant" as const,
    };
    const part = {
      id: "part-1",
      messageID: "assistant-1",
      type: "text" as const,
      text: "hello from mini runtime",
    };

    applyMessageUpdated(runtime, message);
    applyPartUpdated(runtime, part);

    message.id = "assistant-mutated";
    part.text = "changed after write";

    expect(runtime.getState()).toEqual({
      error: null,
      messages: {
        "assistant-1": {
          info: {
            id: "assistant-1",
            role: "assistant",
          },
          parts: [
            {
              id: "part-1",
              messageID: "assistant-1",
              type: "text",
              text: "hello from mini runtime",
            },
          ],
        },
      },
      rootMessageIds: ["assistant-1"],
      status: "loading",
    });
  });

  it("replaces an existing message update instead of duplicating it", () => {
    const runtime = createMiniRuntimeStore();

    applyMessageUpdated(runtime, {
      id: "assistant-1",
      role: "assistant",
    });
    applyMessageUpdated(runtime, {
      id: "assistant-1",
      role: "assistant",
    });

    expect(runtime.getState()).toEqual({
      error: null,
      messages: {
        "assistant-1": {
          info: {
            id: "assistant-1",
            role: "assistant",
          },
          parts: [],
        },
      },
      rootMessageIds: ["assistant-1"],
      status: "loading",
    });
  });

  it("replaces an existing part update instead of duplicating it", () => {
    const runtime = createMiniRuntimeStore();

    applyMessageUpdated(runtime, {
      id: "assistant-1",
      role: "assistant",
    });
    applyPartUpdated(runtime, {
      id: "part-1",
      messageID: "assistant-1",
      type: "text",
      text: "first text",
    });
    applyPartUpdated(runtime, {
      id: "part-1",
      messageID: "assistant-1",
      type: "text",
      text: "updated text",
    });

    expect(runtime.getState()).toEqual({
      error: null,
      messages: {
        "assistant-1": {
          info: {
            id: "assistant-1",
            role: "assistant",
          },
          parts: [
            {
              id: "part-1",
              messageID: "assistant-1",
              type: "text",
              text: "updated text",
            },
          ],
        },
      },
      rootMessageIds: ["assistant-1"],
      status: "loading",
    });
  });

  it("ignores part updates for messages that do not exist", () => {
    const runtime = createMiniRuntimeStore();
    const stateBefore = runtime.getState();

    applyPartUpdated(runtime, {
      id: "part-1",
      messageID: "missing-message",
      type: "text",
      text: "orphan part",
    });

    expect(runtime.getState()).toBe(stateBefore);
    expect(runtime.getState()).toEqual({
      error: null,
      messages: {},
      rootMessageIds: [],
      status: "loading",
    });
  });

  it("leaves state unchanged when part delta or removal targets are missing", () => {
    const runtime = createMiniRuntimeStore();

    applyMessageUpdated(runtime, {
      id: "assistant-1",
      role: "assistant",
    });

    const stateBeforeMissingPart = runtime.getState();

    applyPartDelta(runtime, {
      messageID: "assistant-1",
      partID: "missing-part",
      field: "text",
      delta: " world",
    });
    applyPartRemoved(runtime, {
      messageID: "assistant-1",
      partID: "missing-part",
    });

    expect(runtime.getState()).toBe(stateBeforeMissingPart);

    applyPartDelta(runtime, {
      messageID: "missing-message",
      partID: "part-1",
      field: "text",
      delta: " world",
    });
    applyPartRemoved(runtime, {
      messageID: "missing-message",
      partID: "part-1",
    });

    expect(runtime.getState()).toBe(stateBeforeMissingPart);
    expect(runtime.getState()).toEqual({
      error: null,
      messages: {
        "assistant-1": {
          info: {
            id: "assistant-1",
            role: "assistant",
          },
          parts: [],
        },
      },
      rootMessageIds: ["assistant-1"],
      status: "loading",
    });
  });

  it("applies text deltas to an existing part", () => {
    const runtime = createMiniRuntimeStore();

    applyMessageUpdated(runtime, {
      id: "assistant-1",
      role: "assistant",
    });
    applyPartUpdated(runtime, {
      id: "part-1",
      messageID: "assistant-1",
      type: "text",
      text: "hello",
    });

    applyPartDelta(runtime, {
      messageID: "assistant-1",
      partID: "part-1",
      field: "text",
      delta: " world",
    });

    expect(runtime.getState()).toEqual({
      error: null,
      messages: {
        "assistant-1": {
          info: {
            id: "assistant-1",
            role: "assistant",
          },
          parts: [
            {
              id: "part-1",
              messageID: "assistant-1",
              type: "text",
              text: "hello world",
            },
          ],
        },
      },
      rootMessageIds: ["assistant-1"],
      status: "loading",
    });
  });

  it("removes an existing part from a message", () => {
    const runtime = createMiniRuntimeStore();

    applyMessageUpdated(runtime, {
      id: "assistant-1",
      role: "assistant",
    });
    applyPartUpdated(runtime, {
      id: "part-1",
      messageID: "assistant-1",
      type: "text",
      text: "hello",
    });

    applyPartRemoved(runtime, {
      messageID: "assistant-1",
      partID: "part-1",
    });

    expect(runtime.getState()).toEqual({
      error: null,
      messages: {
        "assistant-1": {
          info: {
            id: "assistant-1",
            role: "assistant",
          },
          parts: [],
        },
      },
      rootMessageIds: ["assistant-1"],
      status: "loading",
    });
  });

  it("tracks idle and error session status in public runtime state", () => {
    const runtime = createMiniRuntimeStore();

    applySessionError(runtime, "stream failed");

    expect(runtime.getState()).toEqual({
      error: "stream failed",
      messages: {},
      rootMessageIds: [],
      status: "error",
    });

    applySessionIdle(runtime);

    expect(runtime.getState()).toEqual({
      error: null,
      messages: {},
      rootMessageIds: [],
      status: "idle",
    });
  });

  it("keeps snapshot identity stable when session status reducers do not change semantics", () => {
    const runtime = createMiniRuntimeStore();

    applySessionIdle(runtime);

    const idleState = runtime.getState();

    applySessionIdle(runtime);

    expect(runtime.getState()).toBe(idleState);

    applySessionError(runtime, "stream failed");

    const errorState = runtime.getState();

    applySessionError(runtime, "stream failed");

    expect(runtime.getState()).toBe(errorState);
  });

  it("maps sync events onto store reducers", () => {
    const runtime = createMiniRuntimeStore();

    applySyncEvent(runtime, {
      type: "message.updated",
      properties: {
        info: {
          id: "assistant-1",
          role: "assistant",
        },
      },
    });
    applySyncEvent(runtime, {
      type: "message.part.updated",
      properties: {
        part: {
          id: "part-1",
          messageID: "assistant-1",
          type: "text",
          text: "hello",
        },
      },
    });
    applySyncEvent(runtime, {
      type: "message.part.delta",
      properties: {
        messageID: "assistant-1",
        partID: "part-1",
        field: "text",
        delta: " world",
      },
    });
    applySyncEvent(runtime, {
      type: "message.part.removed",
      properties: {
        messageID: "assistant-1",
        partID: "part-1",
      },
    });
    applySyncEvent(runtime, {
      type: "session.error",
      properties: {
        error: "stream failed",
      },
    });

    expect(runtime.getState()).toEqual({
      error: "stream failed",
      messages: {
        "assistant-1": {
          info: {
            id: "assistant-1",
            role: "assistant",
          },
          parts: [],
        },
      },
      rootMessageIds: ["assistant-1"],
      status: "error",
    });

    applySyncEvent(runtime, {
      type: "session.idle",
      properties: {},
    });

    expect(runtime.getState()).toEqual({
      error: null,
      messages: {
        "assistant-1": {
          info: {
            id: "assistant-1",
            role: "assistant",
          },
          parts: [],
        },
      },
      rootMessageIds: ["assistant-1"],
      status: "idle",
    });
  });
});
