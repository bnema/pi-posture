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

## Use

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

Optional config files:

```text
~/.pi/agent/postures.json
.pi/postures.json
```

## Develop

```bash
npm install
npm run typecheck
pi -e .
```
