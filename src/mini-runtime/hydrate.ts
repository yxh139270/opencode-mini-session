import type { SessionEntry } from "../types";
import { applyMessageUpdated, applyPartUpdated, createMiniRuntimeStore } from "./store";
import { applySessionError, applySessionIdle } from "./store";
import type {
  MiniRuntimeSessionStatus,
  MiniRuntimeStateSnapshot,
  MiniRuntimeStore,
} from "./types";

export function hydrateMiniRuntimeFromEntries(
  entries: SessionEntry[],
  options: {
    error?: string | null;
    status?: MiniRuntimeSessionStatus;
  } = {},
): MiniRuntimeStore {
  const runtime = createMiniRuntimeStore();

  for (const entry of entries) {
    if (entry.info.role !== "user" && entry.info.role !== "assistant") {
      continue;
    }

    applyMessageUpdated(runtime, {
      id: entry.info.id,
      role: entry.info.role,
    });

    for (const [index, part] of entry.parts.entries()) {
      if (part.type !== "text") {
        continue;
      }

      applyPartUpdated(runtime, {
        id:
          "id" in part && typeof part.id === "string"
            ? part.id
            : `${entry.info.id}:text:${index}`,
        messageID: entry.info.id,
        type: "text",
        text: part.text,
      });
    }
  }

  if (options.status === "idle") {
    applySessionIdle(runtime);
  }

  if (options.status === "error") {
    applySessionError(runtime, options.error ?? "Unknown mini runtime error");
  }

  return runtime;
}

export function getHydratedMiniRuntimeSnapshot(
  entries: SessionEntry[],
  options: {
    error?: string | null;
    status?: MiniRuntimeSessionStatus;
  } = {},
): MiniRuntimeStateSnapshot {
  return hydrateMiniRuntimeFromEntries(entries, options).getState();
}
