# pi-posture

Switch Pi's working posture live.

## What it does

A posture is a small runtime overlay that can add guidance, filter loaded context, adjust tools, adjust thinking level, and show state in Pi's UI.

Built-in postures:

- `default` — normal Pi behavior
- `agent` — delegated execution
- `assist` — human-led pair programming
- `learn` — tutoring and guided understanding
- `review` — critique before editing

## Install

```bash
pi install git:github.com/bnema/pi-posture
```

## Commands

```text
/posture
/posture list
/posture status
/posture inspect
/posture default
/posture agent
/posture assist
/posture learn
/posture review
```

Aliases include `off`, `reset`, `vanilla`, `teacher`, `tutor`, `study`, `pair`, `autonomous`, and `execute`.

## Custom postures

Optional config files:

```text
~/.pi/agent/postures.json
.pi/postures.json
```

Project config overrides global config. Config errors do not break Pi startup; use `/posture inspect` to see effective overlay details.

Example:

```json
{
  "postures": {
    "coach": {
      "label": "Coach",
      "description": "Ask Socratic questions before giving implementation advice.",
      "promptOverlay": "Ask one concise guiding question before proposing a solution.",
      "contextPolicy": {
        "global": "inherit",
        "project": "inherit"
      },
      "thinking": "medium"
    }
  },
  "aliases": {
    "socratic": "coach"
  },
  "startupPicker": {
    "enabled": true,
    "onlyWhenUnset": true,
    "include": ["default", "agent", "assist", "learn", "review"],
    "reasons": ["startup", "new", "resume", "fork"],
    "timeoutMs": 10000
  }
}
```

Supported posture fields: `label`, `description`, `promptOverlay`, `contextPolicy.global`, `contextPolicy.project`, `activeTools`, and `thinking`. `startupPicker` can also be `true` or `false`.

## Context policy

Built-in postures keep the full toolset available. Learning mode is cognitive guidance, not a permissions mode. Switching back to `default` restores previous active tools and thinking level when the extension changed them.

## Develop

```bash
npm install
npm run typecheck
pi -e .
```
