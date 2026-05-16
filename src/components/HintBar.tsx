/** @jsxImportSource @opentui/solid */
import type { TuiPluginApi } from "@opencode-ai/plugin/tui";

function formatKeybinding(keybind: string): string {
  const parts = keybind.split("+");
  const base = parts[parts.length - 1];
  const mods = parts.slice(0, -1);
  const ctrl = mods.includes("ctrl") || mods.includes("control");
  const alt = mods.includes("alt") || mods.includes("meta");
  const shift = mods.includes("shift");
  let prefix = "";
  if (ctrl && shift) prefix = "C-S-";
  else if (ctrl) prefix = "C-";
  else if (alt && shift) prefix = "M-S-";
  else if (alt) prefix = "M-";
  else if (shift) prefix = "S-";
  const keyName = base;
  return `<${prefix}${keyName}>`;
}

export function HintBar(props: { api: TuiPluginApi; hideKey: string }) {
  const theme = props.api.theme.current;

  const hint = (key: string, label: string) => (
    <box flexDirection="row">
      <text fg={theme.primary}>{key}</text>
      <text fg={theme.textMuted}> {label}</text>
    </box>
  );

  const separator = () => <text fg={theme.textMuted}> · </text>;

  return (
    <box flexDirection="row">
      {hint("<S-CR>", "continue")}
      {separator()}
      {hint(formatKeybinding(props.hideKey), "hide")}
      {separator()}
      {hint("Esc/<C-c>", "cancel")}
    </box>
  );
}
