import type { TuiPluginApi } from "@opencode-ai/plugin/tui";
import { createEffect } from "solid-js";
import {
  registerKeymapGlobalLayer,
  registerKeymapPanelLayer,
  registerLegacyGlobalCommands,
  registerLegacyPanelKeybinds,
  type MiniCommand,
  type PanelAction,
} from "./keybinds";
import { isVersionAtLeast, MIN_KEYMAP_VERSION } from "./version";

type RegisterMiniBindingsOptions = {
  api: TuiPluginApi;
  panelActions: PanelAction[];
  globalCommands: MiniCommand[];
  isOverlayOpen: () => boolean;
  watchOverlay?: (run: () => void) => void;
};

type RegisterMiniBindingsResult =
  | { strategy: "keymap" }
  | { strategy: "legacy"; panelActions: PanelAction[] };

export function registerMiniBindings(
  options: RegisterMiniBindingsOptions,
): RegisterMiniBindingsResult {
  if (supportsKeymap(options.api)) {
    registerKeymapPanelLayer(
      options.api,
      options.panelActions,
      options.isOverlayOpen,
    );
    registerKeymapGlobalLayer(options.api, options.globalCommands);
    return { strategy: "keymap" };
  }

  if (!options.api.command) {
    return { strategy: "legacy", panelActions: options.panelActions };
  }

  const globalDispose = registerLegacyGlobalCommands(
    options.api,
    options.globalCommands,
  );
  options.api.lifecycle.onDispose(globalDispose);

  registerLegacyPanelBindingsEffect(
    options.api,
    buildLegacyPanelActions(options),
    options.isOverlayOpen,
    options.watchOverlay ?? ((run) => createEffect(run)),
  );

  return { strategy: "legacy", panelActions: options.panelActions };
}

function buildLegacyPanelActions(options: RegisterMiniBindingsOptions) {
  return options.panelActions.flatMap((action) => {
    if (!action.legacyKey) return [action];
    const { legacyCmd, legacyKey, ...rest } = action;
    return {
      ...rest,
      cmd: legacyCmd ?? rest.cmd,
      key: legacyKey,
    } satisfies PanelAction;
  });
}

function supportsKeymap(api: TuiPluginApi) {
  return isVersionAtLeast(api.app.version, MIN_KEYMAP_VERSION) && Boolean(api.keymap);
}

function registerLegacyPanelBindingsEffect(
  api: TuiPluginApi,
  panelActions: PanelAction[],
  isOverlayOpen: () => boolean,
  watchOverlay: (run: () => void) => void,
) {
  let panelDispose: (() => void) | undefined;

  watchOverlay(() => {
    if (isOverlayOpen()) {
      panelDispose?.();
      panelDispose = registerLegacyPanelKeybinds(api, panelActions);
    } else if (panelDispose) {
      panelDispose();
      panelDispose = undefined;
    }
  });

  api.lifecycle.onDispose(() => panelDispose?.());
}
