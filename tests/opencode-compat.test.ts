import { afterEach, describe, expect, it, vi } from "vitest";
import { CMD_SUBMIT } from "../src/constants";
import { registerMiniBindings } from "../src/opencode-compat";
import { buildPanelActions } from "../src/keybinds";

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
  vi.doUnmock("../src/opencode-compat");
  vi.doUnmock("../src/components/AnswerDialog");
  vi.doUnmock("../src/session");
  vi.doUnmock("../src/update");
});

function fakeIndexApi() {
  return {
    app: { version: "1.17.15" },
    lifecycle: { onDispose: vi.fn() },
    route: { current: { name: "home", params: {} } },
    slots: { register: vi.fn() },
    ui: { toast: vi.fn() },
  } as any;
}

describe("registerMiniBindings", () => {
  it("keeps shift+return mapped to continue in normal panel actions", () => {
    const onContinue = vi.fn();
    const submit = vi.fn();

    const actions = buildPanelActions({
      api: {
        ui: { dialog: { clear: vi.fn() } },
        route: { current: { name: "session", params: {} } },
      },
      config: {
        toggleThinkingKeybind: undefined,
        keybind: undefined,
        freshKeybind: undefined,
      },
      overlay: () => ({ onContinue, submit }),
      modelPickerOpen: { get: () => false, set: vi.fn() },
      triggerMiniMode: vi.fn(),
      openModelPicker: vi.fn(),
    } as any);

    const continueAction = actions.find((action) => action.key === "shift+return");

    expect(continueAction?.cmd).toBe("mini.continue");
    continueAction?.run();
    expect(onContinue).toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });

  it("uses keymap layers when the host supports keymap", () => {
    const api = {
      app: { version: "1.17.15" },
      keymap: { registerLayer: vi.fn() },
      command: { register: vi.fn() },
      lifecycle: { onDispose: vi.fn() },
    } as any;
    const panelRun = vi.fn();
    const globalRun = vi.fn();

    const result = registerMiniBindings({
      api,
      panelActions: [{ cmd: "close", key: "escape", run: panelRun }],
      globalCommands: [{ cmd: "open", title: "mini", keybind: "alt+b", run: globalRun }],
      isOverlayOpen: () => false,
    });

    expect(result).toEqual({ strategy: "keymap" });
    expect(api.keymap.registerLayer).toHaveBeenCalled();
    expect(api.command.register).not.toHaveBeenCalled();
    expect(api.lifecycle.onDispose).not.toHaveBeenCalled();
  });

  it("registers legacy global commands when keymap is unavailable", () => {
    const globalDispose = vi.fn();
    const globalRun = vi.fn();
    const api = {
      app: { version: "1.14.41" },
      lifecycle: { onDispose: vi.fn() },
      command: { register: vi.fn(() => globalDispose) },
    } as any;

    const result = registerMiniBindings({
      api,
      panelActions: [{ cmd: "close", key: "escape", run: vi.fn() }],
      globalCommands: [{ cmd: "open", title: "mini", run: globalRun }],
      isOverlayOpen: () => false,
    });

    expect(api.command.register).toHaveBeenCalledWith(expect.any(Function));
    expect(api.lifecycle.onDispose).toHaveBeenCalledWith(globalDispose);
    expect(result.strategy).toBe("legacy");
  });

  it("registers and releases legacy panel keybinds as overlay visibility changes", () => {
    const globalDispose = vi.fn();
    const panelDispose = vi.fn();
    const overlaySubmit = vi.fn();
    let overlayOpen = false;
    let rerunOverlayEffect: (() => void) | undefined;
    const registeredCommandSources: Array<() => unknown> = [];
    const api = {
      app: { version: "1.14.41" },
      lifecycle: { onDispose: vi.fn() },
      command: {
        register: vi.fn((source: () => unknown) => {
          registeredCommandSources.push(source);
          return registeredCommandSources.length === 1 ? globalDispose : panelDispose;
        }),
      },
    } as any;

    registerMiniBindings({
      api,
      panelActions: [
        { cmd: "close", key: "escape", run: vi.fn() },
        { cmd: CMD_SUBMIT, legacyKey: "return", run: overlaySubmit },
      ],
      globalCommands: [{ cmd: "open", title: "mini", run: vi.fn() }],
      isOverlayOpen: () => overlayOpen,
      watchOverlay: (run) => {
        rerunOverlayEffect = run;
        run();
      },
    });

    expect(api.command.register).toHaveBeenCalledWith(expect.any(Function));
    expect(panelDispose).not.toHaveBeenCalled();

    overlayOpen = true;
    rerunOverlayEffect?.();

    expect(api.command.register).toHaveBeenLastCalledWith(expect.any(Function));
    const panelEntries = registeredCommandSources[1]?.() as Array<{
      keybind: string;
      onSelect: () => void;
    }>;
    const submitEntry = panelEntries.find((entry) => entry.keybind === "return");
    expect(submitEntry).toBeDefined();
    submitEntry?.onSelect();
    expect(overlaySubmit).toHaveBeenCalled();

    overlayOpen = false;
    rerunOverlayEffect?.();

    expect(panelDispose).toHaveBeenCalled();
  });

  it("releases legacy panel keybinds on plugin dispose when overlay is still open", () => {
    const panelDispose = vi.fn();
    let rerunOverlayEffect: (() => void) | undefined;
    let registerCallCount = 0;
    const api = {
      app: { version: "1.14.41" },
      lifecycle: { onDispose: vi.fn() },
      command: {
        register: vi.fn(() => {
          registerCallCount += 1;
          return registerCallCount === 1 ? vi.fn() : panelDispose;
        }),
      },
    } as any;

    registerMiniBindings({
      api,
      panelActions: [{ cmd: CMD_SUBMIT, legacyKey: "return", run: vi.fn() }],
      globalCommands: [{ cmd: "open", title: "mini", run: vi.fn() }],
      isOverlayOpen: () => true,
      watchOverlay: (run) => {
        rerunOverlayEffect = run;
        run();
      },
    });

    expect(rerunOverlayEffect).toBeTypeOf("function");

    const disposeCallbacks = api.lifecycle.onDispose.mock.calls.map(
      ([callback]: [() => void]) => callback,
    );
    for (const callback of disposeCallbacks) {
      callback();
    }

    expect(panelDispose).toHaveBeenCalled();
  });

  it("returns legacy panel actions without registrations when legacy command api is unavailable", () => {
    const panelAction = { cmd: "close", key: "escape", run: vi.fn() };
    const api = {
      app: { version: "1.14.41" },
      keymap: { registerLayer: vi.fn() },
      lifecycle: { onDispose: vi.fn() },
    } as any;

    const result = registerMiniBindings({
      api,
      panelActions: [panelAction],
      globalCommands: [{ cmd: "open", title: "mini", run: vi.fn() }],
      isOverlayOpen: () => false,
    });

    expect(result).toEqual({
      strategy: "legacy",
      panelActions: [panelAction],
    });
    expect(api.command).toBeUndefined();
    expect(api.lifecycle.onDispose).not.toHaveBeenCalled();
  });
});

describe("index compatibility delegation", () => {
  it("delegates host-specific registration to the compatibility layer", async () => {
    const registerMiniBindingsMock = vi.fn(() => ({ strategy: "keymap" }));

    vi.doMock("../src/opencode-compat", () => ({
      registerMiniBindings: registerMiniBindingsMock,
    }));
    vi.doMock("../src/components/AnswerDialog", () => ({
      createOverlaySlot: vi.fn(() => "overlay-slot"),
    }));
    vi.doMock("../src/session", () => ({
      openMiniSession: vi.fn(),
      openModelPicker: vi.fn(),
    }));
    vi.doMock("../src/update", () => ({
      startAutoUpdate: vi.fn(),
    }));

    const plugin = (await import("../src/index")).default;
    const api = fakeIndexApi();

    await plugin.tui(api, {}, { version: "1.1.0" } as any);

    expect(registerMiniBindingsMock).toHaveBeenCalled();
    const calls = registerMiniBindingsMock.mock.calls as unknown as Array<[
      Record<string, unknown>,
    ]>;
    const options = calls[0]?.[0];
    expect(options).toEqual(
      expect.objectContaining({
        api,
        isOverlayOpen: expect.any(Function),
      }),
    );
    expect(options).not.toHaveProperty("legacyPanelActions");
    expect(options).not.toHaveProperty("keybindContext");
  });
});
