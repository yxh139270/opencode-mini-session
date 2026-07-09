import { describe, expect, it } from "vitest";
import { getHydratedMiniRuntimeSnapshot } from "../src/mini-runtime/hydrate";

describe("mini runtime hydrate", () => {
  it("hydrates user and assistant text messages from session entries", () => {
    const snapshot = getHydratedMiniRuntimeSnapshot([
      {
        info: { id: "user-1", role: "user" } as any,
        parts: [{ type: "text", text: "hello" } as any],
      },
      {
        info: { id: "assistant-1", role: "assistant" } as any,
        parts: [
          { type: "text", text: "world" } as any,
          { type: "reasoning", text: "ignored" } as any,
        ],
      },
    ]);

    expect(snapshot.rootMessageIds).toEqual(["user-1", "assistant-1"]);
    expect(snapshot.messages["user-1"]).toEqual({
      info: { id: "user-1", role: "user" },
      parts: [
        {
          id: "user-1:text:0",
          messageID: "user-1",
          type: "text",
          text: "hello",
        },
      ],
    });
    expect(snapshot.messages["assistant-1"]).toEqual({
      info: { id: "assistant-1", role: "assistant" },
      parts: [
        {
          id: "assistant-1:text:0",
          messageID: "assistant-1",
          type: "text",
          text: "world",
        },
      ],
    });
  });

  it("keeps repeated text parts as distinct runtime parts when source entries lack part ids", () => {
    const snapshot = getHydratedMiniRuntimeSnapshot([
      {
        info: { id: "assistant-1", role: "assistant" } as any,
        parts: [
          { type: "text", text: "same" } as any,
          { type: "text", text: "same" } as any,
        ],
      },
    ]);

    expect(snapshot.messages["assistant-1"]).toEqual({
      info: { id: "assistant-1", role: "assistant" },
      parts: [
        {
          id: "assistant-1:text:0",
          messageID: "assistant-1",
          type: "text",
          text: "same",
        },
        {
          id: "assistant-1:text:1",
          messageID: "assistant-1",
          type: "text",
          text: "same",
        },
      ],
    });
  });
});
