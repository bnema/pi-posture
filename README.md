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

## Context policy

Built-in postures keep the full toolset available. Learning mode is cognitive guidance, not a permissions mode. Switching back to `default` restores previous active tools and thinking level when the extension changed them.

## Develop

```bash
npm install
npm run typecheck
pi -e .
```
