# Mini Session Permission Prompt Overlay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically hide the mini-session overlay when OpenCode asks for permission in that mini session, then restore it after the permission flow finishes.

**Architecture:** Keep the behavior local to `startQuestion()` in `src/session.ts`, where the mini overlay lifecycle and event subscriptions already live. Track permission requests for the temporary mini session, suppress the normal manual-hide toast for auto-hide, and restore the overlay only after all pending permission requests for that mini session receive replies.

**Tech Stack:** TypeScript, Vitest, OpenCode TUI plugin event API

---

### Task 1: Add failing session tests for permission-prompt overlay handoff

**Files:**
- Modify: `tests/session.test.ts`
- Test: `tests/session.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
it("hides the mini overlay during a matching permission prompt and restores it after reply", async () => {
  handlers["permission.asked"]({
    properties: { sessionID: "mini-session", id: "perm-1", permission: "external_directory" },
  });
  expect(overlay).toBeUndefined();

  handlers["permission.replied"]({
    properties: { sessionID: "mini-session", requestID: "perm-1", reply: "once" },
  });
  expect(overlay).toBeDefined();
});

it("waits for all matching permission replies before restoring the mini overlay", async () => {
  handlers["permission.asked"]({
    properties: { sessionID: "mini-session", id: "perm-1", permission: "external_directory" },
  });
  handlers["permission.asked"]({
    properties: { sessionID: "mini-session", id: "perm-2", permission: "external_directory" },
  });

  handlers["permission.replied"]({
    properties: { sessionID: "mini-session", requestID: "perm-1", reply: "once" },
  });
  expect(overlay).toBeUndefined();

  handlers["permission.replied"]({
    properties: { sessionID: "mini-session", requestID: "perm-2", reply: "once" },
  });
  expect(overlay).toBeDefined();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/session.test.ts`
Expected: FAIL because `startQuestion()` does not yet react to `permission.asked` or `permission.replied` events.

- [ ] **Step 3: Write the minimal implementation**

```ts
const pendingPermissionRequestIDs = new Set<string>();
let hiddenForPermissionPrompt = false;

api.event.on("permission.asked", (event) => {
  if (event.properties.sessionID !== tempSessionID) return;
  pendingPermissionRequestIDs.add(event.properties.id);
  if (hidden || closed) return;
  hiddenForPermissionPrompt = true;
  hide({ showToast: false });
});

api.event.on("permission.replied", (event) => {
  if (event.properties.sessionID !== tempSessionID) return;
  pendingPermissionRequestIDs.delete(event.properties.requestID);
  if (!hiddenForPermissionPrompt || pendingPermissionRequestIDs.size > 0) return;
  hiddenForPermissionPrompt = false;
  show();
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/session.test.ts`
Expected: PASS for the new permission handoff tests and existing session behavior.

### Task 2: Verify no regressions in typing and session behavior

**Files:**
- Modify: `src/session.ts`
- Test: `tests/session.test.ts`

- [ ] **Step 1: Run targeted type and behavior checks**

Run: `npm run typecheck`
Expected: PASS with no TypeScript errors from the new permission-tracking state.

- [ ] **Step 2: Re-run focused session tests**

Run: `npm test -- tests/session.test.ts`
Expected: PASS, including existing hide/close/session-streaming behavior.
