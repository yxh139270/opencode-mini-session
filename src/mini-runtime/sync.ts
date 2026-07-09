import {
  applyMessageUpdated,
  applyPartDelta,
  applyPartRemoved,
  applyPartUpdated,
  applySessionError,
  applySessionIdle,
} from "./store";
import type {
  MiniRuntimeMessageInfo,
  MiniRuntimePart,
  MiniRuntimePartDelta,
  MiniRuntimePartRemoved,
  MiniRuntimeStore,
} from "./types";

type MiniRuntimeSyncEvent =
  | {
      type: "message.updated";
      properties: {
        info: MiniRuntimeMessageInfo;
      };
    }
  | {
      type: "message.part.updated";
      properties: {
        part: MiniRuntimePart;
      };
    }
  | {
      type: "message.part.delta";
      properties: MiniRuntimePartDelta;
    }
  | {
      type: "message.part.removed";
      properties: MiniRuntimePartRemoved;
    }
  | {
      type: "session.idle";
      properties: Record<string, never>;
    }
  | {
      type: "session.error";
      properties: {
        error: string;
      };
    };

export function applySyncEvent(runtime: MiniRuntimeStore, event: MiniRuntimeSyncEvent) {
  switch (event.type) {
    case "message.updated":
      applyMessageUpdated(runtime, event.properties.info);
      return;
    case "message.part.updated":
      applyPartUpdated(runtime, event.properties.part);
      return;
    case "message.part.delta":
      applyPartDelta(runtime, event.properties);
      return;
    case "message.part.removed":
      applyPartRemoved(runtime, event.properties);
      return;
    case "session.idle":
      applySessionIdle(runtime);
      return;
    case "session.error":
      applySessionError(runtime, event.properties.error);
      return;
  }
}
