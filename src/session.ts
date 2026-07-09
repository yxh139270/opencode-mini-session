import type { ScrollBoxRenderable } from "@opentui/core";
import type {
  TuiDialogSelectOption,
  TuiPluginApi,
} from "@opencode-ai/plugin/tui";
import type { Setter } from "solid-js";
import { version } from "../package.json";
import {
  buildMiniSessionTranscript,
  extractAssistantTextFromState,
} from "./components/answer-dialog-messages";
import { buildFooterCounterState } from "./counter";
import {
  buildMiniErrorDetail,
  buildMiniPromptPayload,
  buildMiniSessionCreatePayload,
  buildMiniSystemPrompt,
  formatMiniNotice,
  resolveRuntimeMiniAgent,
  type ResolvedMiniAgent,
} from "./agent";
import { buildCopiedContext, getSessionEntries } from "./context";
import { getErrorMessage } from "./diagnostics";
import { hydrateMiniRuntimeFromEntries } from "./mini-runtime/hydrate";
import { applySyncEvent } from "./mini-runtime/sync";
import {
  applyMessageUpdated,
  applyPartUpdated,
  applySessionError,
  applySessionIdle,
  createMiniRuntimeStore,
} from "./mini-runtime/store";
import {
  resolveDefaultModel,
  formatResolvedModel,
  resolveModelContextWindow,
  type ModelSource,
} from "./model";
import type {
  ActiveDialog,
  AnswerDialogState,
  MiniConfig,
  MiniMode,
  ModelPreferenceState,
  OverlayState,
  PromptInputRenderable,
  ResolvedModel,
  ThinkingPreferenceState,
} from "./types";
import type { MiniRuntimeStateSnapshot } from "./mini-runtime/types";

type ModelSelectValue =
  | { type: "default" }
  | {
      type: "model";
      model: NonNullable<ResolvedModel["model"]>;
      variant?: string;
    };

type ErrorPath =
  | "promptAsync throw"
  | "session.error event"
  | "session.create throw";


export function openMiniSession(
  api: TuiPluginApi,
  config: MiniConfig,
  mode: MiniMode,
  setOverlay: Setter<OverlayState | undefined>,
  active: ActiveDialog,
  modelPreference: ModelPreferenceState,
  thinkingPreference: ThinkingPreferenceState,
  openPickerFn: (onAfterSelect: () => void) => void,
  getUpdateWarning?: () => string | undefined,
): boolean {
  const currentRoute = api.route.current;

  if (currentRoute.name !== "session") {
    api.ui.toast({
      variant: "error",
      message: "mini only works inside a session.",
    });
    return false;
  }

  const activeDialog = active.get();
  if (activeDialog) {
    activeDialog.show();
    return false;
  }

  const { sessionID } = currentRoute.params as { sessionID: string };
  void startQuestion(
    api,
    config,
    mode,
    sessionID,
    setOverlay,
    active,
    modelPreference,
    thinkingPreference,
    openPickerFn,
    getUpdateWarning,
  );
  return true;
}

export async function startQuestion(
  api: TuiPluginApi,
  config: MiniConfig,
  mode: MiniMode,
  sessionID: string,
  setOverlay: Setter<OverlayState | undefined>,
  active: ActiveDialog,
  modelPreference: ModelPreferenceState,
  thinkingPreference: ThinkingPreferenceState,
  openPickerFn: (onAfterSelect: () => void) => void,
  getUpdateWarning?: () => string | undefined,
) {
  const entries = getSessionEntries(api, sessionID);
  const copiedContext =
    mode === "main"
      ? buildCopiedContext(entries, config.tokenLimit)
      : { text: "", usedTokens: undefined, totalAvailableTokens: undefined };
  const context = copiedContext.text;
  const defaultResolvedModel = resolveDefaultModel(
    api.state.provider,
    config.model,
    config.variant,
    entries,
  );
  const getResolvedModel = () =>
    modelPreference.get() ?? defaultResolvedModel.model;
  const getModelName = () => formatResolvedModel(getResolvedModel());
  const hideKey = mode === "fresh" ? config.freshKeybind : config.keybind;
  const hiddenCommand = mode === "fresh" ? "/mini-fresh" : "/mini";
  const title = mode === "fresh" ? "mini fresh" : "mini session";
  const previousFocus = api.renderer.currentFocusedRenderable;
  let resolvedAgent: ResolvedMiniAgent;
  let system = "";

  const dialogState: AnswerDialogState = {
    mode,
    entries: [],
    runtime: createMiniRuntimeStore().getState(),
    streamingAnswer: "",
    emptyResponseNotice: undefined,
    loading: false,
    scrollbarVisible: false,
    spinnerFrame: 0,
    copiedContextTokens: copiedContext.usedTokens,
    copiedContextTotalTokens: copiedContext.totalAvailableTokens,
    lastCompletedMiniInputTokens: undefined,
    modelContextWindow: undefined,
    footerCounter: {},
    inputPlaceholder: undefined,
    thinkingEnabled: thinkingPreference.get(),
    expandedThinkingPartIDs: {},
    update: getUpdateWarning?.(),
    notice: undefined,
    errorDetail: undefined,
    messageModels: {},
  };

  const submissionModelQueue: string[] = [];
  let runtime = createMiniRuntimeStore();

  const unsubscribers: Array<() => void> = [];
  let tempSessionID: string | undefined;
  let closed = false;
  let hidden = false;
  let continuing = false;
  let renderTimer: ReturnType<typeof setTimeout> | undefined;
  let scrollTimer: ReturnType<typeof setTimeout> | undefined;
  let focusTimer: ReturnType<typeof setTimeout> | undefined;
  let spinnerTimer: ReturnType<typeof setInterval> | undefined;
  let overlayInput: PromptInputRenderable | undefined;
  let overlayScroller: ScrollBoxRenderable | undefined;
  let followStreamingToBottom = true;
  let forceScrollToBottom = true;
  let pendingScrollToBottom = false;
  let hiddenForPermissionPrompt = false;
  const pendingPermissionRequestIDs = new Set<string>();

  const readOverlayInput = () => {
    if (!overlayInput) return "";
    return overlayInput.plainText;
  };

  const clearOverlayInput = () => {
    if (!overlayInput) return;
    if ("clear" in overlayInput && typeof overlayInput.clear === "function") {
      overlayInput.clear();
      return;
    }
    overlayInput.setText("");
  };
  let lastScrollTop = 0;
  let lastScrollHeight = 0;
  let currentTokenMessageID: string | undefined;
  const incrementedTokenMessageIDs = new Set<string>();
  const runtimeTextDirtyMessageIDs = new Set<string>();
  const liveTextSlotIndexes = new Map<string, number>();
  const assistantTextSlots = new Map<
    string,
    Array<{
      hydratedID: string;
      text: string;
      livePartID?: string;
      liveText?: string;
    }>
  >();

  const syncRuntimeSnapshot = () => {
    dialogState.runtime = runtime.getState();
    if (extractAssistantTextFromState(dialogState)) {
      dialogState.emptyResponseNotice = undefined;
    }
  };

  const rebuildRuntimeFromEntries = () => {
    const currentRuntime = runtime.getState();
    const hydratedRuntime = hydrateMiniRuntimeFromEntries(dialogState.entries, {
      error: currentRuntime.error,
      status: currentRuntime.status,
    });
    syncAssistantTextSlotsFromHydrated(hydratedRuntime.getState(), assistantTextSlots);
    runtime = mergeHydratedRuntimeSnapshot(
      hydratedRuntime.getState(),
      currentRuntime,
      runtimeTextDirtyMessageIDs,
      liveTextSlotIndexes,
      assistantTextSlots,
    );
    reconcileRuntimeTextDirtyMessageIDs(
      runtimeTextDirtyMessageIDs,
      hydratedRuntime.getState(),
      currentRuntime,
    );
    syncRuntimeSnapshot();
  };

  const syncCounterState = () => {
    dialogState.modelContextWindow = resolveModelContextWindow(
      api.state.provider,
      getResolvedModel(),
    );
    dialogState.footerCounter = buildFooterCounterState({
      mode: dialogState.mode,
      copiedContextTokens: dialogState.copiedContextTokens,
      copiedContextTotalTokens: dialogState.copiedContextTotalTokens,
      tokenLimit: config.tokenLimit,
      lastCompletedMiniInputTokens: dialogState.lastCompletedMiniInputTokens,
      modelContextWindow: dialogState.modelContextWindow,
    });
    dialogState.inputPlaceholder = dialogState.footerCounter.placeholder;
  };

  const clearScrollTimer = () => {
    pendingScrollToBottom = false;
    if (!scrollTimer) return;
    clearTimeout(scrollTimer);
    scrollTimer = undefined;
  };

  const clearFocusTimer = () => {
    if (!focusTimer) return;
    clearTimeout(focusTimer);
    focusTimer = undefined;
  };

  const clearSpinnerTimer = () => {
    if (!spinnerTimer) return;
    clearInterval(spinnerTimer);
    spinnerTimer = undefined;
  };

  const startSpinnerTimer = () => {
    if (spinnerTimer || closed || hidden || !dialogState.loading) return;
    spinnerTimer = setInterval(() => {
      if (closed || hidden || !dialogState.loading) {
        clearSpinnerTimer();
        return;
      }
      dialogState.spinnerFrame = (dialogState.spinnerFrame + 1) % 10;
      renderOverlay();
    }, 80);
  };

  const scheduleInputFocus = () => {
    if (closed || hidden) return;
    clearFocusTimer();
    focusTimer = setTimeout(() => {
      focusTimer = undefined;
      if (closed || hidden) return;
      overlayInput?.focus();
      api.renderer.requestRender();
    }, 0);
  };

  const isScrollerAtBottom = () => {
    if (!overlayScroller) return true;
    const maxScrollTop = Math.max(
      0,
      overlayScroller.scrollHeight - overlayScroller.viewport.height,
    );
    return overlayScroller.scrollTop >= maxScrollTop - 1;
  };

  const updateScrollSnapshot = () => {
    lastScrollTop = overlayScroller?.scrollTop ?? 0;
    lastScrollHeight = overlayScroller?.scrollHeight ?? 0;
  };

  const scheduleScrollToBottom = () => {
    if (closed || hidden) return;
    clearScrollTimer();
    pendingScrollToBottom = true;
    scrollTimer = setTimeout(() => {
      scrollTimer = undefined;
      if (closed || hidden) {
        pendingScrollToBottom = false;
        return;
      }
      overlayScroller?.scrollTo(Number.MAX_SAFE_INTEGER);
      updateScrollSnapshot();
      pendingScrollToBottom = false;
      api.renderer.requestRender();
    }, 0);
  };

  const scrollBy = (delta: number) => {
    followStreamingToBottom = false;
    forceScrollToBottom = false;
    pendingScrollToBottom = false;
    clearScrollTimer();
    overlayScroller?.scrollBy(delta);
    updateScrollSnapshot();
  };

  const scrollTo = (position: number) => {
    followStreamingToBottom = position === Number.MAX_SAFE_INTEGER;
    forceScrollToBottom = position === Number.MAX_SAFE_INTEGER;
    pendingScrollToBottom = false;
    if (position !== Number.MAX_SAFE_INTEGER) clearScrollTimer();
    overlayScroller?.scrollTo(position);
    updateScrollSnapshot();
  };

  const restorePreviousFocus = () => {
    setTimeout(() => {
      if (previousFocus && !previousFocus.isDestroyed) {
        previousFocus.focus();
      }
      api.renderer.requestRender();
    }, 0);
  };

  const hide = (options: { showToast?: boolean } = {}) => {
    if (closed || hidden) return;
    const showToast = options.showToast ?? true;
    hidden = true;
    if (renderTimer) {
      clearTimeout(renderTimer);
      renderTimer = undefined;
    }
    clearScrollTimer();
    clearFocusTimer();
    clearSpinnerTimer();
    setOverlay(undefined);
    restorePreviousFocus();
    if (showToast) {
      api.ui.toast({
        variant: "info",
        message: hideKey
          ? `mini hidden. Press ${hideKey} to show it.`
          : `mini hidden. Run ${hiddenCommand} to show it.`,
        duration: 1000,
      });
    }
  };

  const closeFromUser = async () => {
    api.ui.toast({
      variant: "info",
      message: "mini session closed.",
      duration: 1000,
    });
    await cleanup();
  };

  const cleanup = async () => {
    if (closed) return;
    closed = true;
    if (active.get() === controller) active.set(undefined);
    while (unsubscribers.length > 0) {
      try {
        unsubscribers.pop()?.();
      } catch {}
    }
    if (renderTimer) clearTimeout(renderTimer);
    clearScrollTimer();
    clearFocusTimer();
    clearSpinnerTimer();
    setOverlay(undefined);
    restorePreviousFocus();
    if (!tempSessionID) return;
    const ephemeralSessionID = tempSessionID;
    tempSessionID = undefined;
    try {
      await api.client.session.abort(
        { sessionID: ephemeralSessionID },
        { throwOnError: true },
      );
    } catch {}
    try {
      await api.client.session.delete(
        { sessionID: ephemeralSessionID },
        { throwOnError: true },
      );
    } catch {}
  };

  const continueInMainThread = async () => {
        const transcript = buildMiniSessionTranscript(dialogState);
    if (continuing || dialogState.loading || dialogState.error || !transcript)
      return;
    continuing = true;

    try {
      await api.client.tui.appendPrompt(
        { text: buildContinuePrompt(transcript) },
        { throwOnError: true },
      );
      api.ui.toast({
        variant: "success",
        message: "Side answer added to prompt.",
      });
      await cleanup();
    } catch (cause) {
      api.ui.toast({
        variant: "error",
        message: `Failed to continue in main thread: ${getErrorMessage(cause)}`,
      });
    } finally {
      continuing = false;
    }
  };

  const toggleThinking = () => {
    dialogState.thinkingEnabled = !dialogState.thinkingEnabled;
    thinkingPreference.set(dialogState.thinkingEnabled);
    dialogState.expandedThinkingPartIDs = {};
    renderOverlay();
  };

  const toggleThinkingPart = (partID: string) => {
    if (dialogState.expandedThinkingPartIDs[partID]) {
      delete dialogState.expandedThinkingPartIDs[partID];
    } else {
      dialogState.expandedThinkingPartIDs[partID] = true;
    }
    renderOverlay();
  };

  const renderOverlay = (options: { focusInput?: boolean } = {}) => {
    if (closed) return;
    syncCounterState();
    const streamingActive =
      dialogState.loading || Boolean(dialogState.streamingAnswer);
    const currentScrollTop = overlayScroller?.scrollTop ?? 0;
    const currentScrollHeight = overlayScroller?.scrollHeight ?? 0;
    if (streamingActive && !forceScrollToBottom && !pendingScrollToBottom) {
      if (isScrollerAtBottom()) {
        followStreamingToBottom = true;
      } else if (
        currentScrollTop < lastScrollTop ||
        currentScrollHeight <= lastScrollHeight
      ) {
        followStreamingToBottom = false;
      }
    }
    const shouldScrollToBottom =
      forceScrollToBottom || (streamingActive && followStreamingToBottom);
    forceScrollToBottom = false;
    updateScrollSnapshot();
    if (renderTimer) {
      clearTimeout(renderTimer);
      renderTimer = undefined;
    }
    if (hidden) return;
    setOverlay({
      api,
      title,
      version,
      modelName: getModelName(),
      hideKey,
      toggleThinkingKeybind: config.toggleThinkingKeybind,
      state: dialogState,
      onScroller: (scroller) => {
        overlayScroller = scroller;
      },
      onInput: (input) => {
        overlayInput = input;
      },
      onHide: () => hide(),
      onClose: () => void closeFromUser(),
      onContinue: () => void continueInMainThread(),
      onChangeModel: () =>
        openPickerFn(() => renderOverlay({ focusInput: true })),
      onToggleThinking: toggleThinking,
      onToggleThinkingPart: toggleThinkingPart,
      onSubmit: submitPrompt,
      scrollBy,
      scrollTo,
      submit: () => {
        const value = readOverlayInput().trim();
        if (value && !dialogState.loading && submitPrompt(value)) {
          clearOverlayInput();
        }
      },
    });
    if (options.focusInput) scheduleInputFocus();
    if (dialogState.loading) startSpinnerTimer();
    else clearSpinnerTimer();
    if (shouldScrollToBottom) scheduleScrollToBottom();
  };

  const setPromptError = (path: ErrorPath, cause: unknown) => {
    dialogState.error = getErrorMessage(cause);
    dialogState.errorDetail = buildMiniErrorDetail({
      path,
      sessionID: tempSessionID,
      resolvedModel: getResolvedModel(),
      resolvedAgent,
    });
    dialogState.loading = false;
    clearSpinnerTimer();
  };

  const show = () => {
    if (closed) return;
    hidden = false;
    renderOverlay({ focusInput: true });
  };

  const controller = {
    close: cleanup,
    hide,
    show,
    isVisible: () => !hidden,
  };

  const scheduleRenderOverlay = () => {
    if (closed || renderTimer) return;
    renderTimer = setTimeout(() => {
      renderTimer = undefined;
      renderOverlay();
    }, 50);
  };

  active.set(controller);
  renderOverlay({ focusInput: true });

  try {
    resolvedAgent = await resolveRuntimeMiniAgent(api, config);
  } catch (cause) {
    if (closed) return;
    api.ui.toast({
      variant: "error",
      message: `Failed to open mini session: ${getErrorMessage(cause)}`,
    });
    await cleanup();
    return;
  }

  if (closed) return;
  system = buildMiniSystemPrompt(context, resolvedAgent, mode);
  dialogState.notice = formatMiniNotice(
    defaultResolvedModel.notice,
    ...resolvedAgent.notices,
  );
  renderOverlay();

  function submitPrompt(value: string) {
    const prompt = value.trim();
    if (!prompt || closed) return false;
    if (dialogState.loading) {
      api.ui.toast({
        variant: "warning",
        message: "Wait for the current response.",
      });
      return false;
    }
    if (!tempSessionID) {
      api.ui.toast({
        variant: "warning",
        message: "mini session is still opening.",
      });
      return false;
    }
    const promptSessionID = tempSessionID;

    dialogState.error = undefined;
    dialogState.errorDetail = undefined;
    dialogState.loading = true;
    dialogState.spinnerFrame = 0;
    dialogState.streamingAnswer = "";
    dialogState.emptyResponseNotice = undefined;
    followStreamingToBottom = true;
    forceScrollToBottom = true;
    submissionModelQueue.push(getModelName());

    renderOverlay({ focusInput: true });

    void (async () => {
      try {
        const resolvedModel = getResolvedModel();
        await api.client.session.promptAsync(
          buildMiniPromptPayload(resolvedAgent, {
            sessionID: promptSessionID,
            system,
            prompt,
            resolvedModel,
          }),
          { throwOnError: true },
        );
      } catch (cause) {
        if (closed) return;
        setPromptError("promptAsync throw", cause);
        renderOverlay();
      }
    })();

    return true;
  }

  try {
    const created = await api.client.session.create(
      buildMiniSessionCreatePayload(resolvedAgent, {
        parentID: sessionID,
        title: "mini session",
        directory: api.state.path.directory,
      }),
      { throwOnError: true },
    );
    tempSessionID = created.data.id;
    const ephemeralSessionID = tempSessionID;

    const refreshSession = () => {
      dialogState.entries = getSessionEntries(api, ephemeralSessionID);
      if (hasLatestAssistantTextEntry(dialogState.entries)) {
        dialogState.streamingAnswer = "";
      }
      rebuildRuntimeFromEntries();
      if (extractAssistantTextFromState(dialogState)) {
        dialogState.emptyResponseNotice = undefined;
      }
      refreshLastCompletedMiniInputTokens();
    };

    const refreshLastCompletedMiniInputTokens = () => {
      const latest = getLastCompletedMiniInputUsage(dialogState.entries);
      if (!latest) return;

      const current = dialogState.lastCompletedMiniInputTokens;
      if (current === undefined || latest.totalTokens > current) {
        dialogState.lastCompletedMiniInputTokens = latest.totalTokens;
        currentTokenMessageID = latest.messageID;
        return;
      }

      if (latest.messageID === currentTokenMessageID) {
        return;
      }

      if (incrementedTokenMessageIDs.has(latest.messageID)) {
        return;
      }

      incrementedTokenMessageIDs.add(latest.messageID);
      dialogState.lastCompletedMiniInputTokens = current + latest.inputTokens;
      currentTokenMessageID = latest.messageID;
    };

    if (closed) {
      try {
        await api.client.session.delete(
          { sessionID: ephemeralSessionID },
          { throwOnError: true },
        );
      } catch {}
      return;
    }

      unsubscribers.push(
        api.event.on("permission.asked", (event) => {
          if (event.properties.sessionID !== tempSessionID) return;
          pendingPermissionRequestIDs.add(event.properties.id);
          if (closed || hidden) return;
          hiddenForPermissionPrompt = true;
          hide({ showToast: false });
        }),
      );

      unsubscribers.push(
        api.event.on("permission.replied", (event) => {
          if (event.properties.sessionID !== tempSessionID) return;
          pendingPermissionRequestIDs.delete(event.properties.requestID);
          if (pendingPermissionRequestIDs.size > 0) return;
          if (!hiddenForPermissionPrompt || closed) return;
          hiddenForPermissionPrompt = false;
          show();
        }),
      );

      unsubscribers.push(
        api.event.on("session.idle", (event) => {
          if (event.properties.sessionID !== tempSessionID) return;
          const usedModel = submissionModelQueue.shift();
          applySyncEvent(runtime, {
            type: "session.idle",
            properties: {},
          });
          refreshSession();
          if (usedModel) {
            for (const entry of dialogState.entries) {
              if (
                entry.info.role === "assistant" &&
                !dialogState.messageModels[entry.info.id]
              ) {
                dialogState.messageModels[entry.info.id] = usedModel;
              }
            }
          }
          if (!extractAssistantTextFromState(dialogState)) {
            dialogState.emptyResponseNotice = "No response generated.";
          }
          dialogState.loading = false;
          clearSpinnerTimer();
          renderOverlay();
        }),
      );

      unsubscribers.push(
        api.event.on("message.updated", (event) => {
          if (event.properties.sessionID !== tempSessionID) return;
          if (
            event.properties.info &&
            (event.properties.info.role === "assistant" ||
              event.properties.info.role === "user")
          ) {
              applySyncEvent(runtime, {
                type: "message.updated",
                properties: {
                info: {
                  id: event.properties.info.id,
                  role: event.properties.info.role,
                },
              },
            });
            syncRuntimeSnapshot();
          }
          refreshSession();
          renderOverlay();
        }),
      );

      unsubscribers.push(
        api.event.on("session.next.text.delta", (event) => {
          if (event.properties.sessionID !== tempSessionID) return;
          if (event.properties.assistantMessageID && event.properties.textID) {
            applySyncEvent(runtime, {
              type: "message.updated",
              properties: {
                info: {
                  id: event.properties.assistantMessageID,
                  role: "assistant",
                },
              },
            });
            const existingMessage =
              runtime.getState().messages[event.properties.assistantMessageID];
            const hasPart = existingMessage?.parts.some(
              (part) => part.id === event.properties.textID,
            );
            if (!hasPart) {
              replaceHydratedTextPartForLivePart(
                runtime,
                event.properties.assistantMessageID,
                event.properties.textID,
                event.properties.delta,
                liveTextSlotIndexes,
                assistantTextSlots,
              );
              applySyncEvent(runtime, {
                type: "message.part.updated",
                properties: {
                  part: {
                    id: event.properties.textID,
                    messageID: event.properties.assistantMessageID,
                    type: "text",
                    text: "",
                  },
                },
              });
            }
            runtimeTextDirtyMessageIDs.add(event.properties.assistantMessageID);
            applySyncEvent(runtime, {
              type: "message.part.delta",
              properties: {
                messageID: event.properties.assistantMessageID,
                partID: event.properties.textID,
                field: "text",
                delta: event.properties.delta,
              },
            });
            syncRuntimeSnapshot();
          } else {
            dialogState.streamingAnswer += event.properties.delta;
          }
          scheduleRenderOverlay();
        }),
      );

      unsubscribers.push(
        api.event.on("message.part.updated", (event) => {
          if (event.properties.sessionID !== tempSessionID) return;
          if (
            event.properties.part?.type === "text" &&
            event.properties.part?.messageID
          ) {
            replaceHydratedTextPartForLivePart(
              runtime,
              event.properties.part.messageID,
              event.properties.part.id,
              event.properties.part.text,
              liveTextSlotIndexes,
              assistantTextSlots,
            );
            applySyncEvent(runtime, {
              type: "message.part.updated",
              properties: {
                part: {
                  id: event.properties.part.id,
                  messageID: event.properties.part.messageID,
                  type: "text",
                  text: event.properties.part.text,
                },
              },
            });
            runtimeTextDirtyMessageIDs.add(event.properties.part.messageID);
            syncRuntimeSnapshot();
          }
          refreshSession();
          renderOverlay();
        }),
      );

      unsubscribers.push(
        api.event.on("message.part.removed", (event) => {
          if (event.properties.sessionID !== tempSessionID) return;
          if (event.properties.messageID && event.properties.partID) {
            removeAssistantLiveTextPart(
              event.properties.messageID,
              event.properties.partID,
              liveTextSlotIndexes,
              assistantTextSlots,
            );
            applySyncEvent(runtime, {
              type: "message.part.removed",
              properties: {
                messageID: event.properties.messageID,
                partID: event.properties.partID,
              },
            });
            syncRuntimeSnapshot();
          }
          refreshSession();
          renderOverlay();
        }),
      );

      unsubscribers.push(
        api.event.on("message.part.delta", (event) => {
          if (event.properties.sessionID !== tempSessionID) return;
          if (
            event.properties.messageID &&
            event.properties.partID &&
            event.properties.field === "text"
          ) {
            applySyncEvent(runtime, {
              type: "message.part.delta",
              properties: {
                messageID: event.properties.messageID,
                partID: event.properties.partID,
                field: "text",
                delta: event.properties.delta,
              },
            });
            runtimeTextDirtyMessageIDs.add(event.properties.messageID);
            syncRuntimeSnapshot();
          }
          scheduleRenderOverlay();
        }),
      );

      unsubscribers.push(
        api.event.on("session.error", (event) => {
          if (event.properties.sessionID !== tempSessionID) return;
          applySyncEvent(runtime, {
            type: "session.error",
            properties: {
              error: event.properties.error,
            },
          });
          syncRuntimeSnapshot();
          setPromptError("session.error event", event.properties.error);
          renderOverlay();
        }),
      );
  } catch (cause) {
    if (closed) return;
    setPromptError("session.create throw", cause);
    renderOverlay();
  }
}

export function openModelPicker(
  api: TuiPluginApi,
  config: MiniConfig,
  sessionID: string,
  modelPreference: ModelPreferenceState,
  onAfterSelect?: () => void,
) {
  const { model: defaultModel, source: defaultSource } = resolveDefaultModel(
    api.state.provider,
    config.model,
    config.variant,
    getSessionEntries(api, sessionID),
  );
  const options = buildModelOptions(api, defaultModel, defaultSource);

  api.ui.dialog.setSize("large");
  api.ui.dialog.replace(() =>
    api.ui.DialogSelect<ModelSelectValue>({
      title: "mini model",
      placeholder: "Select model for future mini-session questions",
      options,
      onSelect: (option) => {
        if (option.value.type === "default") {
          modelPreference.set(undefined);
          api.ui.toast({
            variant: "success",
            message: "mini model reset to default.",
          });
        } else {
          modelPreference.set({
            model: option.value.model,
            variant: option.value.variant,
          });
          api.ui.toast({
            variant: "success",
            message: `mini model set to ${formatResolvedModel({
              model: option.value.model,
              variant: option.value.variant,
            })}.`,
          });
        }
        api.ui.dialog.clear();
        onAfterSelect?.();
      },
    }),
  );
}

function buildModelOptions(
  api: TuiPluginApi,
  defaultModel: ResolvedModel,
  defaultSource: ModelSource,
): TuiDialogSelectOption<ModelSelectValue>[] {
  const providers = [...api.state.provider].sort((left, right) =>
    left.name.localeCompare(right.name),
  );

  const defaultModelName = defaultModel.model
    ? providers.find((p) => p.id === defaultModel.model!.providerID)?.models[
        defaultModel.model!.modelID
      ]?.name || defaultModel.model!.modelID
    : "default";

  const sourceLabel: Record<ModelSource, string> = {
    config: "config",
    session: "main session",
    unknown: "unknown",
  };

  const options: TuiDialogSelectOption<ModelSelectValue>[] = [
    {
      title:
        defaultModelName +
        (defaultModel.variant ? ` (${defaultModel.variant})` : ""),
      value: { type: "default" },
      description: `${formatResolvedModel(defaultModel)}`,
      category: `Default [${sourceLabel[defaultSource]}]`,
    },
  ];

  for (const provider of providers) {
    const models = Object.values(provider.models).sort((left, right) =>
      left.name.localeCompare(right.name),
    );
    for (const model of models) {
      const resolved = {
        providerID: model.providerID,
        modelID: model.id,
      };
      options.push({
        title: model.name || model.id,
        value: { type: "model", model: resolved },
        description: `${provider.id}/${model.id}`,
        category: provider.name,
      });

      for (const variant of Object.keys(model.variants ?? {}).sort()) {
        options.push({
          title: `${model.name || model.id} (${variant})`,
          value: { type: "model", model: resolved, variant },
          description: `${provider.id}/${model.id}`,
          category: provider.name,
        });
      }
    }
  }

  return options;
}

function buildContinuePrompt(transcript: string) {
  return ["[Context from a mini session]", transcript, "---\n"].join("\n\n");
}

function getLastCompletedMiniInputUsage(entries: AnswerDialogState["entries"]) {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const info = entries[index]?.info;
    if (info.role !== "assistant") continue;
    if (!info.time?.completed) continue;
    if (info.tokens) {
      return {
        messageID: info.id,
        inputTokens: info.tokens.input,
        totalTokens: getAssistantInputTokens(info.tokens),
      };
    }
  }
  return undefined;
}

function hasLatestAssistantTextEntry(entries: AnswerDialogState["entries"]) {
  const latest = entries[entries.length - 1];

  if (!latest || latest.info.role !== "assistant") {
    return false;
  }

  return latest.parts.some(
    (part) => part.type === "text" && part.text.trim().length > 0,
  );
}

function mergeHydratedRuntimeSnapshot(
  hydrated: MiniRuntimeStateSnapshot,
  live: MiniRuntimeStateSnapshot,
  preferLiveMessageIDs: ReadonlySet<string>,
  liveTextSlotIndexes: Map<string, number>,
  assistantTextSlots: Map<
    string,
    Array<{
      hydratedID: string;
      text: string;
      livePartID?: string;
      liveText?: string;
    }>
  >,
) {
  const merged = createMiniRuntimeStore();

  for (const messageID of hydrated.rootMessageIds) {
    const hydratedMessage = hydrated.messages[messageID];
    if (!hydratedMessage) continue;

    applyMessageUpdated(merged, hydratedMessage.info);

    const liveMessage = live.messages[messageID];
    const prefersLive = shouldPreferLiveAssistantParts(
      messageID,
      hydratedMessage,
      liveMessage,
      preferLiveMessageIDs,
    );
    const parts = prefersLive
      ? buildPreferredAssistantParts(
          messageID,
          hydratedMessage.parts,
          liveMessage?.parts ?? [],
          preferLiveMessageIDs.has(messageID),
          liveTextSlotIndexes,
          assistantTextSlots,
        )
      : hydratedMessage.parts;

    for (const part of parts) {
      applyPartUpdated(merged, part);
    }
  }

  for (const messageID of live.rootMessageIds) {
    if (hydrated.messages[messageID]) {
      continue;
    }

    const liveMessage = live.messages[messageID];
    if (!liveMessage) continue;

    applyMessageUpdated(merged, liveMessage.info);
    for (const part of liveMessage.parts) {
      applyPartUpdated(merged, part);
    }
  }

  if (live.status === "error" && live.error) {
    applySessionError(merged, live.error);
  } else if (hydrated.status === "error" && hydrated.error) {
    applySessionError(merged, hydrated.error);
  } else if (hydrated.status === "idle" || live.status === "idle") {
    applySessionIdle(merged);
  }

  return merged;
}

function shouldPreferLiveAssistantParts(
  messageID: string,
  hydratedMessage: MiniRuntimeStateSnapshot["messages"][string],
  liveMessage: MiniRuntimeStateSnapshot["messages"][string],
  preferLiveMessageIDs: ReadonlySet<string>,
) {
  if (!hydratedMessage || hydratedMessage.info.role !== "assistant" || !liveMessage) {
    return false;
  }

  if (preferLiveMessageIDs.has(messageID)) {
    return true;
  }

  const hydratedText = getMessageTextContent(hydratedMessage.parts);
  const liveText = getMessageTextContent(liveMessage.parts);

  if (!liveText.trim()) {
    return false;
  }

  if (!hydratedText.trim()) {
    return true;
  }

  if (liveText === hydratedText) {
    return false;
  }

  if (liveText.startsWith(hydratedText) && liveText.length > hydratedText.length) {
    return true;
  }

  return hydratedText.startsWith(liveText) && hydratedText.length > liveText.length;
}

function getMessageTextContent(
  parts: readonly Readonly<{ type: "text"; text: string }>[],
) {
  return parts.map((part) => part.text).join("");
}

function buildPreferredAssistantParts(
  messageID: string,
  hydratedParts: readonly Readonly<{
    id: string;
    messageID: string;
    type: "text";
    text: string;
  }>[],
  liveParts: readonly Readonly<{
    id: string;
    messageID: string;
    type: "text";
    text: string;
  }>[],
  dirtyPreferred: boolean,
  liveTextSlotIndexes: Map<string, number>,
  assistantTextSlots: Map<
    string,
    Array<{
      hydratedID: string;
      text: string;
      livePartID?: string;
      liveText?: string;
    }>
  >,
) {
  const slots = assistantTextSlots.get(messageID);
  if (slots && slots.length > 0) {
    return slots.map((slot, index) => ({
      id: slot.livePartID ?? slot.hydratedID,
      messageID,
      type: "text" as const,
      text: slot.liveText ?? slot.text,
    }));
  }

  if (liveParts.length === 0) {
    return hydratedParts;
  }

  if (hydratedParts.length === 0) {
    return liveParts;
  }

  const hydratedPrefix = `${messageID}:text:`;
  const liveOnlyParts = liveParts.filter((part) => !part.id.startsWith(hydratedPrefix));
  if (liveOnlyParts.length === 0) {
    return liveParts;
  }

  const liveBySlotIndex = new Map<number, (typeof liveOnlyParts)[number]>();
  const pendingLiveParts: (typeof liveOnlyParts)[number][] = [];

  for (const livePart of liveOnlyParts) {
    const slotIndex = liveTextSlotIndexes.get(`${messageID}:${livePart.id}`);
    if (slotIndex !== undefined && hydratedParts[slotIndex]) {
      liveBySlotIndex.set(slotIndex, livePart);
      continue;
    }
    pendingLiveParts.push(livePart);
  }

  if (dirtyPreferred) {
    for (const livePart of pendingLiveParts.splice(0, pendingLiveParts.length)) {
      const slotIndex = chooseHydratedTextSlotIndexForLivePart(
        hydratedParts,
        liveBySlotIndex,
        livePart.text,
      );
      if (slotIndex === undefined) {
        pendingLiveParts.push(livePart);
        continue;
      }

      liveTextSlotIndexes.set(`${messageID}:${livePart.id}`, slotIndex);
      liveBySlotIndex.set(slotIndex, livePart);
    }
  }

  const merged: (typeof liveOnlyParts)[number][] = [];

  for (const [slotIndex, hydratedPart] of hydratedParts.entries()) {
    const replacement = liveBySlotIndex.get(slotIndex);
    if (replacement) {
      merged.push(replacement);
      continue;
    }

    merged.push(hydratedPart);
  }

  merged.push(...pendingLiveParts);
  return merged;
}

function replaceHydratedTextPartForLivePart(
  runtime: ReturnType<typeof createMiniRuntimeStore>,
  messageID: string,
  incomingPartID: string,
  incomingText: string,
  liveTextSlotIndexes: Map<string, number>,
  assistantTextSlots: Map<
    string,
    Array<{
      hydratedID: string;
      text: string;
      livePartID?: string;
      liveText?: string;
    }>
  >,
) {
  const hydratedPrefix = `${messageID}:text:`;
  if (incomingPartID.startsWith(hydratedPrefix)) {
    return;
  }

  const mappingKey = `${messageID}:${incomingPartID}`;
  const mappedSlotIndex = liveTextSlotIndexes.get(mappingKey);

  const message = runtime.getState().messages[messageID];
  if (!message) {
    return;
  }

  let slots = assistantTextSlots.get(messageID);
  if (!slots) {
    slots = message.parts.map((part, index) => {
      const hydratedID = `${messageID}:text:${index}`;
      if (part.id.startsWith(hydratedPrefix)) {
        return {
          hydratedID: part.id,
          text: part.text,
        };
      }

      return {
        hydratedID,
        text: "",
        livePartID: part.id,
        liveText: part.text,
      };
    });
    assistantTextSlots.set(messageID, slots);
  }

  const hydratedParts = message.parts.filter((part) => part.id.startsWith(hydratedPrefix));
  let targetSlotIndex = mappedSlotIndex;

  if (targetSlotIndex === undefined) {
    targetSlotIndex = slots.findIndex((slot) => slot.livePartID === incomingPartID);
    if (targetSlotIndex < 0) {
      targetSlotIndex = undefined;
    }
  }

  if (targetSlotIndex === undefined && hydratedParts.length > 0) {
    targetSlotIndex = inferTextSlotIndexFromPartID(
      messageID,
      incomingPartID,
      hydratedParts.length,
    );
  }

  if (targetSlotIndex === undefined && hydratedParts.length > 0) {
    targetSlotIndex = chooseHydratedTextSlotIndexForLivePart(
      hydratedParts,
      getClaimedLiveTextSlotIndexes(messageID, liveTextSlotIndexes),
      incomingText,
    );
  }

  if (targetSlotIndex === undefined) {
    const claimedSlotIndexes = getClaimedLiveTextSlotIndexes(
      messageID,
      liveTextSlotIndexes,
    );
    const slotCandidates = slots.flatMap((slot, index) =>
      claimedSlotIndexes.has(index) && slot.livePartID !== incomingPartID
        ? []
        : [{ index, slot }],
    );

    if (slotCandidates.length === 1) {
      targetSlotIndex = slotCandidates[0].index;
    } else if (slotCandidates.length > 1) {
      targetSlotIndex = chooseMostSimilarHydratedTextSlotIndex(
        slotCandidates.map(({ index, slot }) => ({
          index,
          part: {
            id: slot.hydratedID,
            text: slot.liveText ?? slot.text,
          },
        })),
        incomingText,
      );
    }
  }

  if (targetSlotIndex === undefined) {
    targetSlotIndex = slots.length;
    slots.push({
      hydratedID: `${messageID}:text:${targetSlotIndex}`,
      text: "",
    });
  }

  const target = hydratedParts[targetSlotIndex];

  liveTextSlotIndexes.set(mappingKey, targetSlotIndex);
  const slot = slots[targetSlotIndex];
  if (slot) {
    slot.livePartID = incomingPartID;
    slot.liveText = incomingText;
  }

  if (target) {
    applySyncEvent(runtime, {
      type: "message.part.removed",
      properties: {
        messageID,
        partID: target.id,
      },
    });
  }
}

function chooseHydratedTextSlotIndexForLivePart(
  hydratedParts: readonly Readonly<{ id: string; text: string }>[],
  claimedSlotIndexes: ReadonlySet<number>,
  incomingText: string,
) {
  const unclaimed = hydratedParts.flatMap((part, index) =>
    claimedSlotIndexes.has(index) ? [] : [{ index, part }],
  );

  if (unclaimed.length === 1) {
    return unclaimed[0].index;
  }

  if (unclaimed.length > 1) {
    return chooseMostSimilarHydratedTextSlotIndex(unclaimed, incomingText);
  }

  return chooseMostSimilarHydratedTextSlotIndex(
    hydratedParts.map((part, index) => ({ index, part })),
    incomingText,
  );
}

function chooseMostSimilarHydratedTextSlotIndex(
  hydratedParts: readonly { index: number; part: Readonly<{ id: string; text: string }> }[],
  incomingText: string,
) {
  let bestSlotIndex: number | undefined;
  let bestScore = Number.NEGATIVE_INFINITY;

  for (const entry of hydratedParts) {
    const score = scoreTextSimilarity(entry.part.text, incomingText);
    if (score > bestScore) {
      bestSlotIndex = entry.index;
      bestScore = score;
    }
  }

  return bestSlotIndex;
}

function getClaimedLiveTextSlotIndexes(
  messageID: string,
  liveTextSlotIndexes: Map<string, number>,
) {
  return new Set(
    [...liveTextSlotIndexes.entries()]
      .filter(([key]) => key.startsWith(`${messageID}:`))
      .map(([, slotIndex]) => slotIndex),
  );
}

function syncAssistantTextSlotsFromHydrated(
  hydrated: MiniRuntimeStateSnapshot,
  assistantTextSlots: Map<
    string,
    Array<{
      hydratedID: string;
      text: string;
      livePartID?: string;
      liveText?: string;
    }>
  >,
) {
  for (const messageID of hydrated.rootMessageIds) {
    const message = hydrated.messages[messageID];
    if (!message || message.info.role !== "assistant") {
      continue;
    }

    const nextSlots = message.parts.map((part) => ({
      hydratedID: part.id,
      text: part.text,
    }));
    const existingSlots = assistantTextSlots.get(messageID);

    if (!existingSlots) {
      assistantTextSlots.set(messageID, nextSlots);
      continue;
    }

    const merged = nextSlots.map((slot) => ({ ...slot }));

    for (const [index, existingSlot] of existingSlots.entries()) {
      if (!existingSlot?.livePartID) {
        continue;
      }

      const inferredIndex = inferTextSlotIndexFromPartID(
        messageID,
        existingSlot.livePartID,
        merged.length,
      );
      const targetIndex = inferredIndex ?? index;
      const targetSlot = merged[targetIndex];
      if (!targetSlot) {
        continue;
      }

      const persistedChanged = targetSlot.text !== existingSlot.text;
      const persistedCaughtUpToLive = targetSlot.text === existingSlot.liveText;
      const hadPersistedBaseline = existingSlot.text.trim().length > 0;
      const persistedReplacedLive =
        hadPersistedBaseline &&
        persistedChanged &&
        targetSlot.text !== existingSlot.text &&
        targetSlot.text !== existingSlot.liveText;

      if (persistedCaughtUpToLive || persistedReplacedLive) {
        continue;
      }

      targetSlot.livePartID = existingSlot.livePartID;
      targetSlot.liveText = existingSlot.liveText;
    }

    assistantTextSlots.set(messageID, merged);
  }
}

function inferTextSlotIndexFromPartID(
  messageID: string,
  partID: string,
  slotCount: number,
) {
  const hydratedMatch = partID.match(new RegExp(`^${escapeRegExp(messageID)}:text:(\\d+)$`));
  if (hydratedMatch) {
    const index = Number(hydratedMatch[1]);
    return Number.isInteger(index) && index >= 0 && index < slotCount
      ? index
      : undefined;
  }

  const numericSuffixMatch = partID.match(/(?:-|:)(\d+)$/);
  if (!numericSuffixMatch) {
    return undefined;
  }

  const oneBasedIndex = Number(numericSuffixMatch[1]);
  const zeroBasedIndex = oneBasedIndex - 1;
  return Number.isInteger(zeroBasedIndex) && zeroBasedIndex >= 0 && zeroBasedIndex < slotCount
    ? zeroBasedIndex
    : undefined;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function scoreTextSimilarity(left: string, right: string) {
  const leftWords = new Set(left.trim().split(/\s+/).filter(Boolean));
  const rightWords = new Set(right.trim().split(/\s+/).filter(Boolean));
  let sharedWords = 0;

  for (const word of leftWords) {
    if (rightWords.has(word)) {
      sharedWords += 1;
    }
  }

  if (sharedWords > 0) {
    return sharedWords;
  }

  return longestCommonSubstringLength(left, right);
}

function longestCommonSubstringLength(left: string, right: string) {
  let best = 0;

  for (let leftIndex = 0; leftIndex < left.length; leftIndex += 1) {
    for (let rightIndex = 0; rightIndex < right.length; rightIndex += 1) {
      let length = 0;
      while (
        left[leftIndex + length] &&
        left[leftIndex + length] === right[rightIndex + length]
      ) {
        length += 1;
      }
      if (length > best) {
        best = length;
      }
    }
  }

  return best;
}

function getPreferredLiveAssistantParts(
  messageID: string,
  parts: readonly Readonly<{ id: string; messageID: string; type: "text"; text: string }>[],
  dirtyPreferred: boolean,
) {
  const hydratedPrefix = `${messageID}:text:`;
  const hydratedParts = parts.filter((part) => part.id.startsWith(hydratedPrefix));
  const runtimeParts = parts.filter((part) => !part.id.startsWith(hydratedPrefix));

  if (runtimeParts.length === 0 || hydratedParts.length === 0) {
    return parts;
  }

  if (dirtyPreferred) {
    const coveredHydratedPartIDs = new Set(
      runtimeParts.flatMap((part) => {
        const match = part.id.match(/:(\d+)$/);
        if (!match) {
          return [];
        }
        return [`${messageID}:text:${match[1]}`];
      }),
    );

    return [
      ...hydratedParts.filter((part) => !coveredHydratedPartIDs.has(part.id)),
      ...runtimeParts,
    ];
  }

  const merged = [...runtimeParts];
  const existingTexts = new Set(runtimeParts.map((part) => part.text));

  for (const part of hydratedParts) {
    if (existingTexts.has(part.text)) {
      continue;
    }
    merged.push(part);
  }

  return merged;
}

function reconcileRuntimeTextDirtyMessageIDs(
  dirtyMessageIDs: Set<string>,
  hydrated: MiniRuntimeStateSnapshot,
  live: MiniRuntimeStateSnapshot,
) {
  for (const messageID of [...dirtyMessageIDs]) {
    const hydratedMessage = hydrated.messages[messageID];
    const liveMessage = live.messages[messageID];

    if (!hydratedMessage || !liveMessage) {
      continue;
    }

    if (
      getMessageTextContent(hydratedMessage.parts) ===
      getMessageTextContent(liveMessage.parts)
    ) {
      dirtyMessageIDs.delete(messageID);
      continue;
    }

    if (!shouldPreferLiveAssistantParts(messageID, hydratedMessage, liveMessage, dirtyMessageIDs)) {
      dirtyMessageIDs.delete(messageID);
    }
  }
}

function removeAssistantLiveTextPart(
  messageID: string,
  partID: string,
  liveTextSlotIndexes: Map<string, number>,
  assistantTextSlots: Map<
    string,
    Array<{
      hydratedID: string;
      text: string;
      livePartID?: string;
      liveText?: string;
    }>
  >,
) {
  liveTextSlotIndexes.delete(`${messageID}:${partID}`);

  const slots = assistantTextSlots.get(messageID);
  if (!slots) {
    return;
  }

  for (const slot of slots) {
    if (slot.livePartID !== partID) {
      continue;
    }

    slot.livePartID = undefined;
    slot.liveText = undefined;
  }
}

function getAssistantInputTokens(tokens: {
  input: number;
  cache?: { read?: number; write?: number };
}) {
  return tokens.input + (tokens.cache?.read ?? 0) + (tokens.cache?.write ?? 0);
}
