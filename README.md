# pi-posture

`pi-posture` lets Pi switch working modes during a session. A posture can add prompt guidance, filter project context, override active tools or thinking level, persist posture state, and update Pi status UI or widgets.

## Install

```bash
pi install git:github.com/bnema/pi-posture
```

## Built-in postures

| Posture | Use it for |
| --- | --- |
| `default` | Normal Pi behavior. Removes posture overlays and restores tool/thinking overrides when possible. |
| `orchestrator` | Approved plans where Pi should coordinate sub-agents and keep working until done or blocked. |
| `assist` | Human-led pairing where the user keeps implementation ownership. |
| `learn` | Socratic, hint-first teaching with the normal toolset still available. |
| `review` | Evidence-first critique. It is read-mostly unless the user explicitly asks for edits. |

Each non-default built-in adds a static `<pi_posture>` prompt overlay and dynamic guidance through internal policy hooks, such as turn tracking, review guidance, Socratic guidance, or autonomous execution guidance.

## Commands

```text
/posture             pick a posture in the UI, or list postures headlessly
/posture list        list registered postures
/posture status      show the active posture summary
/posture inspect     show active posture details and config errors
/posture state       show active posture runtime state
/posture clear-state reset runtime state for the active posture
/posture objective   show, set, or clear the active posture objective
/posture <name>      switch by posture id or alias
```

Objective examples:

```text
/posture objective Ship the README cleanup
/posture objective show
/posture objective clear
```

Built-in aliases:

| Alias | Posture |
| --- | --- |
| `off`, `reset`, `vanilla` | `default` |
| `autonomous`, `execute` | `orchestrator` |
| `pair` | `assist` |
| `teacher`, `tutor`, `study` | `learn` |

## Custom postures

Define postures in either file:

- `~/.pi/agent/postures.json` for global config
- `.pi/postures.json` for project config, which overrides global config when the project is trusted

Config errors do not stop Pi from starting. Use `/posture inspect` to see them.

```json
{
  "postures": {
    "coach": {
      "label": "Coach",
      "description": "Ask one guiding question before implementation advice.",
      "promptOverlay": "Ask one concise guiding question before proposing a solution.",
      "contextPolicy": { "global": "inherit", "project": "inherit" },
      "activeTools": ["read", "bash"],
      "thinking": "medium",
      "interactionStyle": "socratic",
      "mutationPolicy": "guarded",
      "answerPolicy": "hint-first",
      "statusLabel": "coach",
      "dynamicPrompt": "socratic"
    }
  },
  "aliases": {
    "socratic": "coach"
  }
}
```

Supported posture fields:

| Field | Values |
| --- | --- |
| `label`, `description`, `statusLabel` | strings |
| `promptOverlay` | string injected into `<pi_posture>` tags |
| `contextPolicy` | `{ "global": "inherit" \| "suppress", "project": "inherit" \| "suppress" }` |
| `activeTools` | tool name array; unknown tools are reported in `/posture inspect` |
| `thinking` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh` |
| `interactionStyle` | `autonomous`, `assistive`, `review`, `socratic`, `custom` |
| `mutationPolicy` | `allow`, `guarded`, `read-mostly` |
| `answerPolicy` | `direct`, `hint-first`, `explicit-request` |
| `dynamicPrompt` | `none`, `objective-aware`, `verification-focused`, `socratic`, `review-focused` |

`interactionStyle`, `mutationPolicy`, `answerPolicy`, `statusLabel`, and `dynamicPrompt` are declarative metadata. They appear in inspection output but do not create runtime hooks by themselves.

The executable `policy` field is reserved for built-in or programmatic postures. JSON config cannot define policy hooks.

## Startup picker

The startup picker is enabled by default. It opens when Pi has a UI, the session reason is `startup`, `new`, `resume`, or `fork`, and no posture was restored from the session branch yet. It never opens on `reload`.

Disable it:

```json
{ "startupPicker": false }
```

Or configure it:

```json
{
  "startupPicker": {
    "enabled": true,
    "onlyWhenUnset": true,
    "include": ["default", "orchestrator", "assist", "learn", "review"],
    "reasons": ["startup", "new", "resume", "fork"],
    "timeoutMs": 10000
  }
}
```

Set `onlyWhenUnset` to `false` to ask even when a posture was restored. `include` accepts posture ids or aliases. Duplicate, empty, or unknown entries are reported by `/posture inspect`.

## Runtime behavior

- Active posture and per-posture runtime state are persisted in the session branch.
- Switching postures can update active tools, thinking level, status text, and widget content.
- Tool and thinking overrides are restored only if the user has not changed them since the posture applied them.
- `contextPolicy` filters rendered project context. Global context means files under Pi's agent directories; project context means other project context files.
- Project-local config loads only when Pi marks the project trusted. Extensions without the trust API skip project config by default.

## Develop

```bash
npm install
npm run typecheck
npm test
pi -e .
```
