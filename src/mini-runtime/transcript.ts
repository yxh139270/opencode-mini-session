import type {
  MiniRuntimeMessageInfo,
  MiniRuntimePart,
  MiniRuntimeStateSnapshot,
  MiniRuntimeTextPart,
} from "./types";

export type MiniRuntimeTranscriptEntry = Readonly<{
  info: Readonly<MiniRuntimeMessageInfo>;
  parts: readonly Readonly<MiniRuntimePart>[];
}>;

export type MiniRuntimeAssistantTextPartContext = Readonly<{
  entry: MiniRuntimeTranscriptEntry;
  entryIndex: number;
  message: Readonly<MiniRuntimeMessageInfo>;
  part: Readonly<MiniRuntimeTextPart> | undefined;
  partIndex: number | undefined;
}>;

function isTextPart(part: MiniRuntimePart): part is MiniRuntimeTextPart {
  return part.type === "text";
}

export function getMiniRuntimeTranscript(
  state: MiniRuntimeStateSnapshot,
): MiniRuntimeTranscriptEntry[] {
  const transcript: MiniRuntimeTranscriptEntry[] = [];

  for (const messageID of state.rootMessageIds) {
    const message = state.messages[messageID];

    if (!message) {
      continue;
    }

    transcript.push({
      info: message.info,
      parts: message.parts,
    });
  }

  return transcript;
}

export function getLastAssistantTextPartContext(
  transcript: readonly MiniRuntimeTranscriptEntry[],
): MiniRuntimeAssistantTextPartContext | undefined {
  for (let entryIndex = transcript.length - 1; entryIndex >= 0; entryIndex -= 1) {
    const entry = transcript[entryIndex];

    if (entry.info.role !== "assistant") {
      continue;
    }

    for (let partIndex = entry.parts.length - 1; partIndex >= 0; partIndex -= 1) {
      const part = entry.parts[partIndex];

      if (isTextPart(part)) {
        return {
          entry,
          entryIndex,
          message: entry.info,
          part,
          partIndex,
        };
      }
    }

    return {
      entry,
      entryIndex,
      message: entry.info,
      part: undefined,
      partIndex: undefined,
    };
  }

  return undefined;
}
