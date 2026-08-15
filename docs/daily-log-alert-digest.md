# Daily Log & Alert Digest

A scheduled job that pulls 24 hours of monitoring alerts, collapses the noise, has a model write a five-line digest, and emails it before the team starts their day.

**File:** [`workflows/daily-log-alert-digest.json`](../workflows/daily-log-alert-digest.json)
**Trigger:** Schedule (daily, 07:00)

## Node-by-node

### 1. Every Morning at 07:00

Schedule Trigger, `field: days`, `daysInterval: 1`, `triggerAtHour: 7`.

Fires in the workflow's timezone, which is set explicitly in `settings.timezone` rather than inherited from the instance. A digest that silently shifts by an hour twice a year teaches people to stop trusting the timestamp on it.

### 2. Fetch Last 24h of Alerts

HTTP Request with `since` and `until` computed from `$now` rather than hardcoded, and a 500-record limit.

Computing the window from `$now` means a run that was missed — instance restart, deploy, whatever — still asks for a full 24 hours when it next fires, instead of leaving a gap nobody notices.

### 3. Group & Deduplicate

A Code node, and the reason this workflow is cheap enough to run every day.

**Flapping is the normal failure mode of alerting.** One sick host emits the same alert 400 times overnight. Handing all 400 to a model costs real money, crowds the context window, and skews the summary toward whatever flapped loudest rather than whatever matters most.

The node:

- **Accepts several response shapes.** Monitoring APIs return a bare array, or `{alerts: []}`, or `{data: []}`, or `{result: []}`. All four are unwrapped.
- **Normalizes severity** across vendor vocabularies — `disaster`/`crit`/`p1`/`sev1` all become `critical`; `average`/`warn`/`p3` become `warning`.
- **Deduplicates** on `severity | host | alert name`. Timestamps and instance ids are deliberately *excluded* from the key, because those are exactly the fields that make duplicates look unique. Each group keeps a `count`, `first_seen`, and `last_seen`.
- **Sorts** by severity, then by count within a severity.
- **Caps at 60 groups** and sets `truncated: true` when it clips. Sixty deduplicated groups is already more than anyone will act on before lunch, and the cap bounds token spend on a genuinely bad night.

### 4. Summarize with LLM

An HTTP Request to an OpenAI-compatible `/v1/chat/completions` endpoint, `temperature: 0.2`, with `onError: continueErrorOutput`.

The prompt lives in the node in plain sight, as a system message plus a user message:

- The **system message** specifies the output format line by line — one health sentence, four issue lines in a fixed `severity — host: problem (Nx)` shape, then a literal `Needs human attention:` heading. It also forbids inventing alerts, hosts, or numbers, and specifies the exact string to use when nothing needs attention.
- The **user message** carries the window, the totals, the per-severity counts, a truncation notice when relevant, and the deduplicated groups as JSON.

Any OpenAI-compatible base URL works here — vLLM, Ollama, LiteLLM, Azure OpenAI. The credential attaches to the node; nothing is inlined.

### 5a. Build Digest (success path)

Extracts `choices[0].message.content` and builds the subject line.

**The counts in the subject come from the deduplication node, not from the model** — `$('Group & Deduplicate').first().json`. Numbers a human scans at a glance in an inbox should never be generated text. The model writes prose; arithmetic stays with the code that did the arithmetic.

### 5b. Digest Without LLM (error path)

If the model call fails, this branch assembles a plain digest from the deduplicated data: the error, the severity counts, and the top 10 alert groups formatted by hand.

An ops digest that silently stops arriving is worse than an ugly one. Nobody notices absence.

### 6. Email the Digest

`emailSend` with the SMTP credential, plain text. Both branches converge here, so there is exactly one delivery path to configure and test.

## JSON contract

**In:** whatever your monitoring API returns. The Code node accepts a bare array or a wrapper on `alerts`, `data`, or `result`, and reads these fields per alert (all optional, with fallbacks):

| Field | Fallbacks | Used for |
|---|---|---|
| `severity` | — | Normalized into critical/high/warning/info |
| `host` | `instance`, `resource` | Dedupe key, digest line |
| `name` | `alertname`, `message` | Dedupe key, digest line |
| `timestamp` | `startsAt`, `clock`, `time` | `first_seen` / `last_seen` |
| `message` | `description`, `summary` | Sample text, truncated to 200 chars |

**Out of Group & Deduplicate:**

```json
{
  "window_start": "2026-08-13T07:00:00.000-07:00",
  "window_end": "2026-08-14T07:00:00.000-07:00",
  "total_alerts": 412,
  "unique_alerts": 9,
  "counts_by_severity": { "critical": 1, "high": 2, "warning": 5, "info": 1 },
  "truncated": false,
  "groups": [
    {
      "severity": "critical",
      "host": "db-primary",
      "name": "Replication lag above threshold",
      "count": 187,
      "first_seen": "2026-08-13T23:14:02Z",
      "last_seen": "2026-08-14T06:58:31Z",
      "sample_message": "Replica is 940 seconds behind primary"
    }
  ]
}
```

That `total_alerts: 412` collapsing to `unique_alerts: 9` is the whole argument for the node.

**Out (the email):**

```
Subject: Ops digest 2026-08-14 — 1 critical, 9 unique alerts

Overnight was noisy but narrow: 412 alerts collapsed to 9 distinct issues, one critical.
critical — db-primary: replication lag above threshold (187x)
high — edge-fw-02: BGP session flapping (94x)
high — app-03: memory above 90% (61x)
warning — backup-01: nightly job exceeded window (22x)

Needs human attention:
- db-primary replication has been behind since 23:14 and is not recovering on its own.
- edge-fw-02 BGP flapping needs a circuit check with the carrier.
```

## What to swap for production

| Node | Replace | With |
|---|---|---|
| Fetch Last 24h of Alerts | `https://monitoring.example.com/api/v1/alerts` | Zabbix, Datadog, Prometheus Alertmanager, your endpoint — plus a credential |
| Group & Deduplicate | Field names in `dedupeKey` | Whatever your API actually calls host and alert name |
| Summarize with LLM | Base URL and `model` | Your gateway and model; attach the API credential |
| Email the Digest | `fromEmail` / `toEmail` | Real addresses, plus the SMTP credential |
| Workflow settings | `timezone: America/Phoenix` | Your team's timezone |

## Extension ideas

The highest-value change is comparing against yesterday: store each run's `counts_by_severity` and include the delta in the digest, because "one critical" reads very differently when yesterday had zero than when yesterday had thirty. After that — split the digest per team so the network group isn't reading storage alerts; add a second schedule at end of day for anything opened and not closed; and if the same group appears in the digest five days running, that's a chronic problem rather than an alert, so flag it differently. Sending the digest to chat instead of email is a one-node swap: replace the email node with an HTTP Request to an incoming webhook.
