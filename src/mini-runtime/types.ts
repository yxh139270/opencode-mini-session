export type MiniRuntimeMessageInfo = {
  id: string;
  role: "assistant" | "user";
};

export type MiniRuntimeTextPart = {
  id: string;
  messageID: string;
  type: "text";
  text: string;
};

export type MiniRuntimePart = MiniRuntimeTextPart;

export type MiniRuntimePartDelta = {
  messageID: string;
  partID: string;
  field: "text";
  delta: string;
};

export type MiniRuntimePartRemoved = {
  messageID: string;
  partID: string;
};

export type MiniRuntimeSessionStatus = "loading" | "idle" | "error";

export type MiniRuntimeMessageNode = {
  info: MiniRuntimeMessageInfo;
  parts: MiniRuntimePart[];
};

export type MiniRuntimeMessages = {
  [messageID: string]: MiniRuntimeMessageNode | undefined;
};

export type MiniRuntimeMessageTree = {
  error: string | null;
  messages: MiniRuntimeMessages;
  messageOrder: {
    [messageID: string]: number | undefined;
  };
  rootMessageIds: string[];
  status: MiniRuntimeSessionStatus;
};

export type MiniRuntimeStateSnapshot = Readonly<{
  error: string | null;
  messages: Readonly<{
    [messageID: string]:
      | Readonly<{
          info: Readonly<MiniRuntimeMessageInfo>;
          parts: readonly Readonly<MiniRuntimePart>[];
        }>
      | undefined;
  }>;
  rootMessageIds: readonly string[];
  status: MiniRuntimeSessionStatus;
}>;

export type MiniRuntimeStore = {
  getState: () => MiniRuntimeStateSnapshot;
};
