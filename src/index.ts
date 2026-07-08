import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui";
import { createEffect, createSignal, untrack } from "solid-js";
import { createOverlaySlot } from "./components/AnswerDialog";
import { parseConfig } from "./config";
import { PLUGIN_ID } from "./constants";
import {
  buildGlobalCommands,
  buildPanelActions,
  type KeybindContext,
} from "./keybinds";
import { registerMiniBindings } from "./opencode-compat";
import { openMiniSession, openModelPicker } from "./session";
import { resolveMiniRouteAction, runMiniRouteAction } from "./routing";
import type {
  ActiveDialogController,
  MiniMode,
  ModelPreference,
  OverlayState,
  ThinkingPreferenceState,
} from "./types";
import { startAutoUpdate } from "./update";

const tui: TuiPlugin = async (api, options, meta) => {
  const config = parseConfig(options);
  const [overlay, setOverlay] = createSignal<OverlayState | undefined>(
    undefined,
    { equals: false },
  );
  const [selectedModel, setSelectedModel] = createSignal<ModelPreference>(
    undefined,
    { equals: false },
  );
  const [thinkingEnabled, setThinkingEnabled] = createSignal(
    config.enableThinking,
  );
  const [originSessionID, setOriginSessionID] = createSignal<string | undefined>(undefined);
  const [updateWarning, setUpdateWarning] = createSignal<string | undefined>(undefined);
  let activeDialog: ActiveDialogController | undefined;
  let activeMode: MiniMode | undefined;
  let modelPickerOpen = false;
  const thinkingPreference: ThinkingPreferenceState = {
    get: thinkingEnabled,
    set: setThinkingEnabled,
  };

  api.lifecycle.onDispose(() => activeDialog?.close());
  startAutoUpdate(api, meta, setUpdateWarning);

  createEffect(() => {
    const warning = updateWarning();
    const current = untrack(overlay);
    if (!current || current.state.update === warning) return;
    setOverlay({ ...current, state: { ...current.state, update: warning } });
  });

  createEffect(() => {
    const origin = originSessionID();
    if (!origin) return;
    const route = api.route.current;
    if (route.name !== "session" || (route.params as { sessionID: string } | undefined)?.sessionID !== origin) {
      setOriginSessionID(undefined);
      api.ui.toast({
        variant: "info",
        message: "mini session closed.",
        duration: 1000,
      });
      void activeDialog?.close();
    }
  });

  api.slots.register({
    slots: { app: createOverlaySlot(overlay) },
  });

  const ctx: KeybindContext = {
    api,
    config,
    overlay,
    modelPickerOpen: {
      get: () => modelPickerOpen,
      set: (v) => { modelPickerOpen = v; },
    },
    triggerMiniMode: (mode, source) => triggerMiniMode(mode, source),
    openModelPicker: () => {
      const currentRoute = api.route.current;
      if (currentRoute.name !== "session") return;
      const { sessionID } = currentRoute.params as { sessionID: string };
      openModelPicker(api, config, sessionID, {
        get: selectedModel,
        set: setSelectedModel,
      });
    },
  };

  registerMiniBindings({
    api,
    panelActions: buildPanelActions(ctx),
    globalCommands: buildGlobalCommands(ctx),
    isOverlayOpen: () => Boolean(overlay()),
  });

  async function triggerMiniMode(mode: MiniMode, source: "command" | "keybind") {
    const currentRoute = api.route.current;
    if (currentRoute.name !== "session") return;
    const { sessionID } = currentRoute.params as { sessionID: string };
    const nextAction = resolveMiniRouteAction({
      source,
      requestedMode: mode,
      activeMode,
      isVisible: activeDialog?.isVisible(),
    });

    await runMiniRouteAction({
      action: nextAction,
      activeDialog,
      open: () => {
        const opened = openMiniSession(api, config, mode, setOverlay, {
          get: () => activeDialog,
          set: (dialog) => {
            activeDialog = dialog;
            if (!dialog) {
              activeMode = undefined;
              setOriginSessionID(undefined);
            }
          },
        }, {
          get: selectedModel,
          set: setSelectedModel,
        }, thinkingPreference, (onAfterSelect) => openModelPicker(api, config, sessionID, { get: selectedModel, set: setSelectedModel }, () => {
            modelPickerOpen = false;
            onAfterSelect();
          }), updateWarning);
        if (opened) {
          setOriginSessionID(sessionID);
          activeMode = mode;
        }
      },
    });
  }
};

const plugin: TuiPluginModule & { id: string } = {
  id: PLUGIN_ID,
  tui,
};

export default plugin;
