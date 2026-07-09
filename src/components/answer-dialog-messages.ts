import type { Part } from "@opencode-ai/sdk/v2";
import { getMiniRuntimeTranscript } from "../mini-runtime/transcript";
import type { AnswerDialogState } from "../types";

export type MiniPart =
  | { type: "text"; text: string; streaming?: boolean }
  | {
      type: "reasoning";
      id: string;
      text: string;
      time?: { start?: number; end?: number };
      metadata?: unknown;
    }
  | { type: "tool"; text: string; status: string }
  | { type: "meta"; text: string };

export type MiniMessage = {
  id: string;
  role: "user" | "assistant";
  parts: MiniPart[];
  modelName?: string;
};

export function buildMiniMessages(state: AnswerDialogState): MiniMessage[] {
  const legacyMessages = buildLegacyMiniMessages(state, {
    includeStreamingFallback: true,
  });
  const runtimeMessages = markStreamingAssistantTextParts(
    buildRuntimeMiniMessages(state, legacyMessages),
    state,
  );

  if (
    runtimeMessages.length > 0 ||
    state.runtime.rootMessageIds.length > 0 ||
    state.streamingAnswer.trim() ||
    state.loading
  ) {
    return runtimeMessages;
  }

  return markStreamingAssistantTextParts(legacyMessages, state);
}

export function extractAssistantTextFromState(state: AnswerDialogState): string {
  const chunks = buildMiniMessages(state)
    .filter((message) => message.role === "assistant")
    .flatMap((message) => message.parts)
    .filter((part): part is Extract<MiniPart, { type: "text" }> => part.type === "text")
    .map((part) => part.text.trim())
    .filter(Boolean);

  return chunks.join("\n\n").trim();
}

export function buildMiniSessionTranscript(state: AnswerDialogState) {
  return buildMiniMessages(state)
    .map((message) => {
      const chunks = message.parts
        .filter((part): part is Extract<MiniPart, { type: "text" }> => part.type === "text")
        .map((part) => part.text.trim())
        .filter(Boolean);

      if (chunks.length === 0) {
        return "";
      }

      return `${message.role}:\n${chunks.join("\n\n")}`;
    })
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

function buildRuntimeMiniMessages(
  state: AnswerDialogState,
  legacyMessages: MiniMessage[],
): MiniMessage[] {
  const legacyById = new Map(legacyMessages.map((message) => [message.id, message]));
  const messages = getMiniRuntimeTranscript(state.runtime).map((entry) => {
    const legacyMessage = legacyById.get(entry.info.id);

    return {
      id: entry.info.id,
      role: entry.info.role,
      parts: mergeRuntimeAndLegacyParts(entry.parts, legacyMessage?.parts ?? []),
      modelName:
        entry.info.role === "assistant"
          ? state.messageModels[entry.info.id]
          : undefined,
    };
  });

  const streamingAnswer = state.streamingAnswer;

  if (!streamingAnswer.trim()) {
    return messages;
  }

  const lastMessage = messages[messages.length - 1];
  const lastAssistantMessage = [...messages]
    .reverse()
    .find((message) => message.role === "assistant");

  if (!lastAssistantMessage) {
    messages.push({
      id: "streaming-assistant",
      role: "assistant",
      parts: [{ type: "text", text: streamingAnswer }],
      modelName: undefined,
    });
    return messages;
  }

  const lastTextPart = [...lastAssistantMessage.parts]
    .reverse()
    .find((part): part is Extract<MiniPart, { type: "text" }> => part.type === "text");

  if (!lastTextPart) {
    lastAssistantMessage.parts.push({ type: "text", text: streamingAnswer });
    return messages;
  }

  if (!lastMessage || lastMessage.id !== lastAssistantMessage.id) {
    messages.push({
      id: "streaming-assistant",
      role: "assistant",
      parts: [{ type: "text", text: streamingAnswer }],
      modelName: undefined,
    });
    return messages;
  }

  const streamingTrimmed = streamingAnswer.trim();
  const lastTextTrimmed = lastTextPart.text.trim();

  if (streamingTrimmed === lastTextTrimmed) {
    return messages;
  }

  if (
    streamingTrimmed.startsWith(lastTextTrimmed) &&
    streamingTrimmed.length > lastTextTrimmed.length
  ) {
    lastTextPart.text = streamingAnswer;
    return messages;
  }

  if (!lastTextTrimmed.endsWith(streamingTrimmed)) {
    lastTextPart.text += streamingAnswer;
  }

  return messages;
}

function markStreamingAssistantTextParts(
  messages: MiniMessage[],
  state: AnswerDialogState,
) {
  if (!state.loading) {
    return messages;
  }

  const lastMessage = messages[messages.length - 1];
  if (!lastMessage || lastMessage.role !== "assistant") {
    return messages;
  }

  let targetPartIndex = -1;
  for (let index = lastMessage.parts.length - 1; index >= 0; index -= 1) {
    if (lastMessage.parts[index]?.type === "text") {
      targetPartIndex = index;
      break;
    }
  }

  if (targetPartIndex < 0) {
    return messages;
  }

  const targetPart = lastMessage.parts[targetPartIndex];
  if (targetPart?.type !== "text") {
    return messages;
  }

  if (targetPart.streaming) {
    return messages;
  }

  const nextMessages = [...messages];
  nextMessages[nextMessages.length - 1] = {
    ...lastMessage,
    parts: lastMessage.parts.map((part, partIndex) =>
      partIndex === targetPartIndex && part.type === "text"
        ? { ...part, streaming: true }
        : part,
    ),
  };
  return nextMessages;
}

function buildLegacyMiniMessages(
  state: AnswerDialogState,
  options: { includeStreamingFallback: boolean },
): MiniMessage[] {
  const messages: MiniMessage[] = [];

  for (const entry of state.entries) {
    const message: MiniMessage = {
      id: entry.info.id,
      role: entry.info.role,
      parts: entry.parts
        .flatMap(toMiniParts)
        .filter((part): part is MiniPart => Boolean(part)),
      modelName:
        entry.info.role === "assistant"
          ? state.messageModels[entry.info.id]
          : undefined,
    };

    if (message.parts.length === 0) continue;

    const previous = messages[messages.length - 1];
    if (shouldMergeMiniMessages(previous, message)) {
      previous.parts.push(...message.parts);
      previous.modelName ??= message.modelName;
      continue;
    }

    messages.push(message);
  }

  if (!options.includeStreamingFallback || !state.streamingAnswer) return messages;

  const lastAssistant = [...messages]
    .reverse()
    .find((message) => message.role === "assistant");

  if (!lastAssistant) {
    messages.push({
      id: "streaming-assistant",
      role: "assistant",
      parts: [{ type: "text", text: state.streamingAnswer }],
      modelName: undefined,
    });
    return messages;
  }

  const lastText = [...lastAssistant.parts]
    .reverse()
    .find(
      (part): part is Extract<MiniPart, { type: "text" }> =>
        part.type === "text",
    );

  if (lastText) {
    const streamingTrimmed = state.streamingAnswer.trim();
    const lastTextTrimmed = lastText.text.trim();

    if (streamingTrimmed === lastTextTrimmed) {
      // 保持现有内容不变。
    } else if (
      streamingTrimmed.startsWith(lastTextTrimmed) &&
      streamingTrimmed.length > lastTextTrimmed.length
    ) {
      lastText.text = state.streamingAnswer;
    } else if (!lastTextTrimmed.endsWith(streamingTrimmed)) {
      lastText.text += state.streamingAnswer;
    }
  } else {
    const lastReasoning = [...lastAssistant.parts]
      .reverse()
      .find((part) => part.type === "reasoning");

    if (
      !lastReasoning ||
      lastReasoning.text.trim() !== state.streamingAnswer.trim()
    ) {
      lastAssistant.parts.push({ type: "text", text: state.streamingAnswer });
    }
  }

  return messages;
}

function mergeRuntimeAndLegacyParts(
  runtimeParts: readonly Readonly<{ type: "text"; text: string }>[],
  legacyParts: MiniPart[],
): MiniPart[] {
  const legacyTextPositions = legacyParts.flatMap((part, index) =>
    part.type === "text" ? [index] : [],
  );
  const keptLegacyTextPositions =
    runtimeParts.length < legacyTextPositions.length
      ? chooseLegacyTextPositions(legacyParts, legacyTextPositions, runtimeParts.length)
      : new Set(legacyTextPositions);
  const merged: MiniPart[] = [];
  let runtimeTextIndex = 0;

  for (const [index, legacyPart] of legacyParts.entries()) {
    if (legacyPart.type !== "text") {
      merged.push(legacyPart);
      continue;
    }

    if (!keptLegacyTextPositions.has(index)) {
      continue;
    }

    const runtimePart = runtimeParts[runtimeTextIndex];
    if (runtimePart) {
      merged.push({ type: "text", text: runtimePart.text });
      runtimeTextIndex += 1;
    }
  }

  while (runtimeTextIndex < runtimeParts.length) {
    merged.push({
      type: "text",
      text: runtimeParts[runtimeTextIndex].text,
    });
    runtimeTextIndex += 1;
  }

  return merged;
}

function chooseLegacyTextPositions(
  legacyParts: MiniPart[],
  textPositions: number[],
  keepCount: number,
) {
  if (keepCount <= 0) {
    return new Set<number>();
  }

  const candidates = buildTextPositionCombinations(textPositions, keepCount);
  let best = candidates[0] ?? [];
  let bestScore = Number.POSITIVE_INFINITY;

  for (const candidate of candidates) {
    const score = scoreLegacyTextPositions(legacyParts, candidate);
    if (score < bestScore) {
      best = candidate;
      bestScore = score;
    }
  }

  return new Set(best);
}

function buildTextPositionCombinations(
  positions: number[],
  keepCount: number,
): number[][] {
  if (keepCount >= positions.length) {
    return [positions];
  }

  const results: number[][] = [];
  const current: number[] = [];

  const visit = (start: number) => {
    if (current.length === keepCount) {
      results.push([...current]);
      return;
    }

    for (let index = start; index < positions.length; index += 1) {
      current.push(positions[index]);
      visit(index + 1);
      current.pop();
    }
  };

  visit(0);
  return results;
}

function scoreLegacyTextPositions(legacyParts: MiniPart[], keptTextPositions: number[]) {
  if (keptTextPositions.length === 0) {
    return 0;
  }

  const firstText = keptTextPositions[0];
  const lastText = keptTextPositions[keptTextPositions.length - 1];
  let score = 0;

  for (const [index, part] of legacyParts.entries()) {
    if (part.type === "reasoning" || part.type === "meta") {
      if (index > lastText) {
        score += 10;
      }
      continue;
    }

    if (part.type === "tool" && index < firstText) {
      score += 10;
    }
  }

  return score;
}

function shouldMergeMiniMessages(
  previous: MiniMessage | undefined,
  current: MiniMessage,
) {
  return Boolean(
    previous && previous.role === "assistant" && current.role === "assistant",
  );
}

function toMiniParts(part: Part): MiniPart[] {
  if (part.type === "reasoning" && part.text.trim()) {
    return toReasoningMiniParts(part);
  }

  const miniPart = toMiniPart(part);
  return miniPart ? [miniPart] : [];
}

function toMiniPart(part: Part): MiniPart | undefined {
  if (part.type === "text" && part.text.trim()) {
    return { type: "text", text: part.text.trim() };
  }
  if (part.type === "tool") {
    const toolName = part.tool.charAt(0).toUpperCase() + part.tool.slice(1);
    const inputSummary = summarizeToolInput(part.state.input);
    const stateTitle =
      "title" in part.state && typeof part.state.title === "string"
        ? part.state.title
        : undefined;
    const detail = inputSummary || stateTitle;
    return {
      type: "tool",
      status: part.state.status,
      text: detail ? `→ ${toolName} ${detail}` : `→ ${toolName}`,
    };
  }
  if (part.type === "file") {
    return { type: "meta", text: `file: ${part.filename ?? part.url}` };
  }
  if (part.type === "agent") {
    return { type: "meta", text: `agent: ${part.name}` };
  }
  if (part.type === "patch") {
    return { type: "meta", text: `patch: ${part.files.join(", ")}` };
  }
  if (part.type === "retry") {
    return { type: "meta", text: `retry ${part.attempt}` };
  }
  return undefined;
}

function toReasoningMiniParts(part: Extract<Part, { type: "reasoning" }>) {
  const baseID = getReasoningPartID(part);
  const time = "time" in part && isReasoningTime(part.time) ? part.time : undefined;
  const metadata = "metadata" in part ? part.metadata : undefined;
  const segments = splitReasoningText(part.text.trim());

  return segments.map((text, index) => ({
    type: "reasoning" as const,
    id: segments.length === 1 ? baseID : `${baseID}:${index}`,
    text,
    time: index === 0 ? time : undefined,
    metadata,
  }));
}

function splitReasoningText(text: string) {
  const titlePattern = /\*\*([^*\n]+)\*\*/g;
  const matches = [...text.matchAll(titlePattern)].filter((match) =>
    isReasoningTitleMatch(text, match.index ?? -1),
  );

  if (matches.length <= 1) return [text];

  const segments: string[] = [];
  if ((matches[0].index ?? 0) > 0) {
    const intro = text.slice(0, matches[0].index).trim();
    if (intro) segments.push(intro);
  }

  for (let index = 0; index < matches.length; index++) {
    const start = matches[index].index ?? 0;
    const end = matches[index + 1]?.index ?? text.length;
    const segment = text.slice(start, end).trim();
    if (segment) segments.push(segment);
  }

  return segments.length > 0 ? segments : [text];
}

function isReasoningTitleMatch(text: string, index: number) {
  if (index < 0) return false;
  if (index === 0) return true;
  const before = text.slice(0, index).trimEnd();
  if (!before) return true;
  return /[.!?)]$/.test(before) || before.endsWith("...");
}

function summarizeToolInput(
  input: { [key: string]: unknown } | undefined,
): string {
  if (!input) return "";
  const entries = Object.entries(input).slice(0, 2);
  if (entries.length === 0) return "";
  return entries
    .map(([, value]) => {
      const str = typeof value === "string" ? value : String(value);
      return str.length > 60 ? `${str.slice(0, 57)}...` : str;
    })
    .join(" ");
}

function getReasoningPartID(part: Extract<Part, { type: "reasoning" }>) {
  return "id" in part && typeof part.id === "string" ? part.id : part.text;
}

function isReasoningTime(
  value: unknown,
): value is { start?: number; end?: number } {
  return Boolean(value && typeof value === "object");
}
