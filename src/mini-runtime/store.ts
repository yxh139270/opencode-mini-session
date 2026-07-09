import type {
  MiniRuntimeMessageInfo,
  MiniRuntimeMessageTree,
  MiniRuntimePart,
  MiniRuntimePartDelta,
  MiniRuntimePartRemoved,
  MiniRuntimeStateSnapshot,
  MiniRuntimeStore,
} from "./types";

const STORE_STATE = new WeakMap<MiniRuntimeStore, MiniRuntimeMessageTree>();
const STORE_SNAPSHOT = new WeakMap<
  MiniRuntimeStore,
  {
    state: MiniRuntimeMessageTree;
    snapshot: MiniRuntimeStateSnapshot;
  }
>();

function createEmptyState(): MiniRuntimeMessageTree {
  return {
    error: null,
    messageOrder: {},
    messages: {},
    rootMessageIds: [],
    status: "loading",
  };
}

function buildRootMessageIds(messageOrder: MiniRuntimeMessageTree["messageOrder"]) {
  return Object.entries(messageOrder)
    .filter((entry): entry is [string, number] => entry[1] !== undefined)
    .sort((left, right) => left[1] - right[1])
    .map(([messageID]) => messageID);
}

function getNextMessageOrder(messageOrder: MiniRuntimeMessageTree["messageOrder"]) {
  let nextOrder = 0;

  for (const order of Object.values(messageOrder)) {
    if (order !== undefined && order >= nextOrder) {
      nextOrder = order + 1;
    }
  }

  return nextOrder;
}

function copyMessageInfo(info: MiniRuntimeMessageInfo): MiniRuntimeMessageInfo {
  return {
    id: info.id,
    role: info.role,
  };
}

function copyPart(part: MiniRuntimePart): MiniRuntimePart {
  return {
    id: part.id,
    messageID: part.messageID,
    type: part.type,
    text: part.text,
  };
}

function freezeState(state: MiniRuntimeMessageTree): MiniRuntimeStateSnapshot {
  const messages = Object.fromEntries(
    Object.entries(state.messages)
      .filter((entry): entry is [string, NonNullable<typeof entry[1]>] => entry[1] !== undefined)
      .map(([messageID, message]) => [
        messageID,
        Object.freeze({
          info: Object.freeze({ ...message.info }),
          parts: Object.freeze(message.parts.map((part) => Object.freeze({ ...part }))),
        }),
      ]),
  );

  return Object.freeze({
    error: state.error,
    messages: Object.freeze(messages),
    rootMessageIds: Object.freeze([...state.rootMessageIds]),
    status: state.status,
  });
}

function getBackingState(runtime: MiniRuntimeStore): MiniRuntimeMessageTree {
  const state = STORE_STATE.get(runtime);

  if (!state) {
    throw new Error("Mini runtime store state is not initialized");
  }

  return state;
}

function setBackingState(runtime: MiniRuntimeStore, nextState: MiniRuntimeMessageTree) {
  STORE_STATE.set(runtime, nextState);
}

function getSnapshot(runtime: MiniRuntimeStore): MiniRuntimeStateSnapshot {
  const state = getBackingState(runtime);
  const cachedSnapshot = STORE_SNAPSHOT.get(runtime);

  if (cachedSnapshot?.state === state) {
    return cachedSnapshot.snapshot;
  }

  const snapshot = freezeState(state);
  STORE_SNAPSHOT.set(runtime, {
    state,
    snapshot,
  });
  return snapshot;
}

export function createMiniRuntimeStore(): MiniRuntimeStore {
  const runtime: MiniRuntimeStore = {
    getState() {
      return getSnapshot(runtime);
    },
  };

  setBackingState(runtime, createEmptyState());

  return runtime;
}

function getMessage(runtime: MiniRuntimeStore, messageID: string) {
  const state = getBackingState(runtime);
  return {
    state,
    message: state.messages[messageID],
  };
}

function getPartIndex(parts: readonly MiniRuntimePart[], partID: string) {
  return parts.findIndex((part) => part.id === partID);
}

export function applyMessageUpdated(
  runtime: MiniRuntimeStore,
  info: MiniRuntimeMessageInfo,
) {
  const state = getBackingState(runtime);
  const existingMessage = state.messages[info.id];
  const messageOrder = existingMessage
    ? state.messageOrder
    : {
        ...state.messageOrder,
        [info.id]: getNextMessageOrder(state.messageOrder),
      };
  const nextState: MiniRuntimeMessageTree = {
    error: state.error,
    messageOrder,
    messages: {
      ...state.messages,
      [info.id]: existingMessage
        ? {
            ...existingMessage,
            info: copyMessageInfo(info),
          }
        : {
            info: copyMessageInfo(info),
            parts: [],
          },
    },
    rootMessageIds: existingMessage ? state.rootMessageIds : buildRootMessageIds(messageOrder),
    status: state.status,
  };

  setBackingState(runtime, nextState);
}

export function applyPartUpdated(runtime: MiniRuntimeStore, part: MiniRuntimePart) {
  const { state, message } = getMessage(runtime, part.messageID);

  if (!message) {
    return;
  }

  const existingPartIndex = getPartIndex(message.parts, part.id);
  const nextParts = [...message.parts];

  if (existingPartIndex === -1) {
    nextParts.push(copyPart(part));
  } else {
    nextParts[existingPartIndex] = copyPart(part);
  }

  const nextState: MiniRuntimeMessageTree = {
    error: state.error,
    messageOrder: state.messageOrder,
    messages: {
      ...state.messages,
      [part.messageID]: {
        ...message,
        parts: nextParts,
      },
    },
    rootMessageIds: state.rootMessageIds,
    status: state.status,
  };

  setBackingState(runtime, nextState);
}

export function applyPartDelta(runtime: MiniRuntimeStore, delta: MiniRuntimePartDelta) {
  const { state, message } = getMessage(runtime, delta.messageID);

  if (!message) {
    return;
  }

  const existingPartIndex = getPartIndex(message.parts, delta.partID);

  if (existingPartIndex === -1) {
    return;
  }

  const existingPart = message.parts[existingPartIndex];
  const nextParts = [...message.parts];
  nextParts[existingPartIndex] = {
    ...existingPart,
    [delta.field]: existingPart[delta.field] + delta.delta,
  };

  setBackingState(runtime, {
    error: state.error,
    messageOrder: state.messageOrder,
    messages: {
      ...state.messages,
      [delta.messageID]: {
        ...message,
        parts: nextParts,
      },
    },
    rootMessageIds: state.rootMessageIds,
    status: state.status,
  });
}

export function applyPartRemoved(runtime: MiniRuntimeStore, removed: MiniRuntimePartRemoved) {
  const { state, message } = getMessage(runtime, removed.messageID);

  if (!message) {
    return;
  }

  const nextParts = message.parts.filter((part) => part.id !== removed.partID);

  if (nextParts.length === message.parts.length) {
    return;
  }

  setBackingState(runtime, {
    error: state.error,
    messageOrder: state.messageOrder,
    messages: {
      ...state.messages,
      [removed.messageID]: {
        ...message,
        parts: nextParts,
      },
    },
    rootMessageIds: state.rootMessageIds,
    status: state.status,
  });
}

export function applySessionIdle(runtime: MiniRuntimeStore) {
  const state = getBackingState(runtime);

  if (state.status === "idle" && state.error === null) {
    return;
  }

  setBackingState(runtime, {
    ...state,
    error: null,
    status: "idle",
  });
}

export function applySessionError(runtime: MiniRuntimeStore, error: string) {
  const state = getBackingState(runtime);

  if (state.status === "error" && state.error === error) {
    return;
  }

  setBackingState(runtime, {
    ...state,
    error,
    status: "error",
  });
}
