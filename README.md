# pi-posture

`pi-posture` is a Pi extension for switching the coding-agent harness posture live.

A posture is a small runtime overlay: it can add prompt guidance, optionally filter loaded context files, optionally override active tools or thinking level, and show the active state in Pi's UI. Built-in postures keep the full toolset available; learning mode is not a permissions mode.

## Install

```bash
pi install git:github.com/bnema/pi-posture
```

For local development:

```bash
pi -e ./src/index.ts
```

## Commands

```text
/posture                 # open an interactive selector when UI is available
/posture list            # list available postures
/posture status          # show active posture
/posture inspect         # show effective overlay details
/posture default         # restore normal Pi behavior
/posture agent
/posture assist
/posture learn
/posture review
```

Aliases:

```text
off, reset, vanilla -> default
teacher, tutor, study -> learn
pair -> assist
autonomous, execute -> agent
```

## Built-in postures

### `default`

Plugin-off behavior. No prompt overlay, no context filtering, no tool changes, and no status residue. If a custom posture changed active tools or thinking level, switching to `default` restores the previous values captured by the plugin.

### `agent`

Delegated agentic execution. Pi moves work forward with code changes, commands, and verification when appropriate.

### `assist`

Human-led pair programming. Pi uses tools freely to inspect, research, and verify, but does not take over core implementation unless asked.

### `learn`

Tutor posture. Pi still uses tools freely to inspect code, fetch official/up-to-date documentation, search examples, and run verification. The difference is cognitive: it teaches concepts, gives hints and micro-steps, and avoids dumping a complete implementation unless asked.

### `review`

Critique-oriented posture. Pi inspects work, explains risks, and suggests improvements before editing.

## Custom postures

`pi-posture` loads optional config from both locations, in this order:

1. `~/.pi/agent/postures.json`
2. `.pi/postures.json` in the current project

Project config overrides global config. Both files are optional. Config errors do not break Pi startup; run `/posture inspect` to see them.

Example:

```json
{
  "postures": {
    "coach": {
      "label": "Coach",
      "description": "Ask Socratic questions before giving implementation advice.",
      "promptOverlay": "You are in coach posture. Ask one concise guiding question before proposing a solution.",
      "contextPolicy": {
        "global": "inherit",
        "project": "inherit"
      },
      "thinking": "medium"
    },
    "clean-room": {
      "label": "Clean Room",
      "description": "Ignore project context files for this turn family.",
      "promptOverlay": "Reason from the user's prompt only unless you inspect files yourself.",
      "contextPolicy": {
        "global": "suppress",
        "project": "suppress"
      }
    }
  },
  "aliases": {
    "socratic": "coach"
  }
}
```

Supported posture fields:

```ts
type Posture = {
  label?: string;
  description?: string;
  promptOverlay?: string;
  contextPolicy?: {
    global?: "inherit" | "suppress";
    project?: "inherit" | "suppress";
  };
  activeTools?: string[];
  thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
};
```

## Context policy

`AGENTS.md` and other Pi context files are not moved or edited. Context suppression, when configured, only filters the system prompt generated for future turns.

Built-in postures inherit all context. Suppression is an advanced custom-posture option and is visible in `/posture inspect` and the status line.

## Development

```bash
npm install
npm run typecheck
```

## License

MIT
