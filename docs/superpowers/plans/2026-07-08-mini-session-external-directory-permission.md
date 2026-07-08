# Mini Session External Directory Permission Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make plugin-managed mini sessions stop hard-denying `external_directory` so OpenCode can surface its normal permission request flow for project-external paths.

**Architecture:** Keep the existing plugin-managed permission model, but carve out `external_directory` from the blanket deny branch in `buildPermissionRules()`. Validate the new behavior with focused agent permission tests while keeping all other plugin-managed restrictions unchanged.

**Tech Stack:** TypeScript, Vitest, OpenCode SDK permission rules

---

### Task 1: Add a failing permission test

**Files:**
- Modify: `tests/agent.test.ts`
- Test: `tests/agent.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it("does not hard-deny external_directory in plugin-managed mode", () => {
  const resolved = asPluginManaged(resolveMiniAgent(config(), [], availableTools));
  expect(actionFor(resolved.permission, "external_directory")).not.toBe("deny");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/agent.test.ts`
Expected: FAIL because `external_directory` is currently generated as `deny`.

- [ ] **Step 3: Write minimal implementation**

```ts
if (permission === "external_directory") return undefined;
```

Apply the real change inside `buildPermissionRules()` so the generated ruleset no longer hard-denies `external_directory`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/agent.test.ts`
Expected: PASS and all other permission assertions remain green.

- [ ] **Step 5: Commit**

```bash
git add tests/agent.test.ts src/agent.ts docs/superpowers/specs/2026-07-08-mini-session-external-directory-permission-design.md docs/superpowers/plans/2026-07-08-mini-session-external-directory-permission.md
git commit -m "fix: allow mini external directory prompts"
```

### Task 2: Verify no regressions in agent/session typing and behavior

**Files:**
- Modify: `src/agent.ts`
- Test: `tests/agent.test.ts`
- Test: `tests/session.test.ts`

- [ ] **Step 1: Add a guard assertion for other restricted permissions**

```ts
expect(actionFor(resolved.permission, "edit")).toBe("deny");
expect(actionFor(resolved.permission, "bash")).toBe("deny");
```

- [ ] **Step 2: Run the targeted regression tests**

Run: `npm test -- tests/agent.test.ts tests/session.test.ts`
Expected: PASS. The new change should affect only `external_directory` handling.

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: PASS with no TypeScript errors.

- [ ] **Step 4: Commit**

```bash
git add tests/agent.test.ts src/agent.ts docs/superpowers/specs/2026-07-08-mini-session-external-directory-permission-design.md docs/superpowers/plans/2026-07-08-mini-session-external-directory-permission.md
git commit -m "fix: allow mini external directory prompts"
```
