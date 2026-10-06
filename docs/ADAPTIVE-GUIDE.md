# Adaptive

Adaptive makes FlupCode watch how your sessions go and help from what it sees: it points the agent to
the skills that fit a task, warns you when the agent repeats itself, and proposes new skills from
finished sessions. It never widens a permission, it installs nothing without your approval, and
turning it off puts FlupCode back exactly as it was.

This page is how to turn it on and set it up. How it works inside is in the
[reference](ADAPTIVE.md).

## Turn it on

Open **Settings → Adaptive** and pick a **Level**:

| Level   | What it does                                                                 |
| ------- | ---------------------------------------------------------------------------- |
| Off     | Nothing runs. Your choices are kept for when you turn it back on.            |
| Observe | Watches your sessions and notes what it would do, without changing anything. |
| Assist  | Suggests skills and warns about loops while you work.                        |
| Custom  | Your own mix of the four capabilities below.                                 |

Observe is the safe place to start: nothing the agent sees changes.

## The four capabilities

Each one has its own switch under the level, so you can turn on only what you want.

| Capability       | Choices                  | What you get                                                                            |
| ---------------- | ------------------------ | --------------------------------------------------------------------------------------- |
| Context          | Off, Observing, Acting\* | Works out which earlier parts of the conversation the agent still needs.                |
| Skill suggestion | Off, Suggesting          | Points the agent to the skills that fit the task.                                       |
| Loop warnings    | Off, Warning             | Warns you when the agent repeats the same step. It never pauses the turn.               |
| Learning         | Off, Proposing           | Proposes new skills from finished sessions. Nothing is installed without your approval. |

\* Acting changes what the agent sees, and it has not passed its offline evaluation yet. Leave
Context on Observing unless you are testing it.

**Freeze learning** stops new proposals without turning Learning off: you can still review the
pending ones, and the skills you already approved stay in use.

## Choose a predictive model

Out of the box every decision is made by built-in rules, and nothing leaves your machine. A
predictive model can answer some of those decisions instead. This step is optional.

Under **Predictive model**, _Which model answers each decision_ has one selector per decision:

| Decision                                  | Jev | Small model |
| ----------------------------------------- | --- | ----------- |
| Which skills fit                          | Yes | Yes         |
| Whether the task is finished              | Yes | Yes         |
| Why a step failed                         | Yes | Yes         |
| Which context to keep                     | Yes | No          |
| Whether a session is worth learning from  | Yes | No          |
| Whether a run moves to its fallback model | Yes | No          |

Each selector offers **None (built-in rules)** and the models that can answer that decision. A row
tells you what its model is still waiting for: a project, the decision, permission to send data, or
the key. Until all of them are there, the built-in rules keep deciding.

There are two models to choose from.

### Jev

Jev is a hosted predictive model (`api.typesafe.ai`). It answers every decision, and it needs an
API key from its provider.

1. In **Predictive model**, find **Model key** in Jev's section and paste the key. If a key is
   already saved, choose **Change** first.
2. Choose **Save key**, then confirm. The key is stored encrypted on this machine and is never shown
   again. It is read on every request, so there is nothing to restart.
3. Under _Data shared with the predictive model_, in **Sharing with Jev**, choose **Add project** and
   enter the path of each project Jev may be asked about.
4. In the same section, turn on each decision Jev may answer. Each one asks you to confirm, and
   covers Jev only.
5. Back in _Which model answers each decision_, pick Jev for those decisions.

To set the key from the environment instead, start FlupCode with `FLUPCODE_TYPESAFE_API_KEY` set.
The environment wins over a saved key, and the panel then shows **Key set by the environment** and
can no longer change it.

### Small model

The small model is the `small_model` of your OpenCode config, asked through the engine with the
provider you already connected. It needs no key of its own, and it appears in the selectors only when
`small_model` is set.

It still sends your data to that provider, so it needs the same consent as Jev: add the project and
turn on the decisions under its own sharing section, then pick it in the selectors.

One thing to know: each answer is a full round trip through the engine and takes seconds, while a
decision waits 400 ms by default. With that default the small model almost always answers too late
and the built-in rules decide. To use it for a decision, raise that decision's deadline in the config
file (the panel shows it read-only):

```jsonc
// ~/.config/opencode/opencode.json
{
  "flupcode": {
    "adaptive": {
      "decisions": { "completion": { "timeoutMs": 60000 } },
    },
  },
}
```

## What is sent, and to whom

Consent is given per provider, per project and per decision. Allowing the small model never lets
anything reach Jev, and the reverse. What a model receives is redacted first, and a model that is not
allowed for a project is simply not asked there.

The same settings, written by hand:

```jsonc
// ~/.config/opencode/opencode.json
{
  "flupcode": {
    "adaptive": {
      "models": { "skillRelevance": "jev" },
      "egress": {
        "providers": {
          "jev": { "enabled": true, "projects": ["/work/app"], "kinds": { "skillRelevance": true } },
        },
      },
    },
  },
}
```

A key is never written to this file: it lives in the encrypted vault or in the environment.

## Check that it works

- The summary of **Predictive model** names each decision and its model, with the reason when one is
  not ready, for example _Whether the task is finished: Jev (key missing)_. A decision that is ready
  shows only its model.
- **Is it worth asking?** shows, per decision, whether the model is being asked: _Measuring its
  value_ while it warms up, then _Asked_. _Paused: it does not help here_ means its answers did not
  pay for themselves, and the built-in rules took over again.
- **Data & budget** shows the tokens spent this month and the predictive model's cost over its recent
  decisions.

## Budget and history

Under **Data & budget** you can set a **Monthly budget (tokens)** for the predictive model. When it
is spent, the built-in rules decide until the next month. The same section can remove decision
history older than a number of days.

## Turn it off

Set the level to **Off**: every capability stops at once, nothing is deleted, and the skills you
already learned still load.

To force it off from outside the app, start FlupCode with `FLUPCODE_ADAPTIVE_DISABLED=1`. The level
then stays Off and the panel says the environment set it.
