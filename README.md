# n8n-ops-workflows

Three importable [n8n](https://n8n.io) workflows covering patterns that come up constantly in operations automation: a capture → enrich → score → route pipeline, a scheduled digest that summarizes overnight noise, and a synchronous LLM triage endpoint.

They are written to be read, not just run. Each one carries its design decisions in node notes and code comments, and each has a walkthrough in [`docs/`](docs/) explaining the JSON contract and what to swap for production.

Built with **built-in nodes only** — no community-node installs. Anywhere a credential is needed it's referenced by name, never inlined.

## The workflows

| Workflow | Trigger | What it demonstrates |
|---|---|---|
| [Lead Capture → Enrich → Score → Route](docs/lead-capture-enrich-score-route.md) | Webhook (POST) | Graceful degradation around a third-party API, transparent rule-based scoring, branch routing by band |
| [Daily Log & Alert Digest](docs/daily-log-alert-digest.md) | Schedule (07:00 daily) | Deduplicating noisy alerts before they reach a model, prompt design for a fixed output format, a fallback that still delivers when the model is down |
| [Ticket LLM Summarizer & Router](docs/ticket-llm-summarizer.md) | Webhook (POST, synchronous) | Strict-JSON prompting with real schema validation, a malformed-output fallback branch, category routing with a human-reviewed catch-all |

## Import

In the n8n UI: **Workflows → ⋯ → Import from File**, and pick a file from [`workflows/`](workflows/). Repeat per workflow.

From the CLI, if you're self-hosting:

```bash
n8n import:workflow --input=workflows/lead-capture-enrich-score-route.json
```

Every workflow imports inactive with no credentials attached. Wire up the placeholders below before activating.

## Credential placeholders

No keys, tokens, or real endpoints are in these files. Every external call points at an `example.com` URL and expects a credential you attach in the n8n UI.

| Placeholder | Nodes | What to attach |
|---|---|---|
| `OpenAI-or-compatible API` | Summarize with LLM, Classify & Summarize | Header Auth or OpenAI credential. Any OpenAI-compatible base URL works — vLLM, Ollama, LiteLLM, Azure OpenAI |
| `SMTP` | Email the Digest | SMTP credential for digest delivery |
| Enrichment provider | Enrich Contact | Clearbit / Apollo / your provider |
| CRM | Upsert CRM Record | Your CRM's API credential |
| Ticketing system | The four assignment nodes | Your service desk's API credential |
| Monitoring API | Fetch Last 24h of Alerts | Zabbix / Datadog / Alertmanager / your endpoint |

Each node's notes name what to swap. The per-workflow docs list them in a table.

## Validation

```bash
node scripts/validate-workflows.mjs
```

Checks that each export parses, that every node has the fields n8n requires, that ids and names are unique and well-formed, that every node named in `connections` exists, that no node is orphaned on the canvas, and that nothing looks like an inline API key.

With `n8n-nodes-base` available it also verifies every node `type` is real and every `typeVersion` is one the installed n8n actually implements — the check that catches "unknown node type" on import:

```bash
npm install --no-save n8n-nodes-base n8n-core
node scripts/validate-workflows.mjs
```

Current status: **structurally validated against n8n-nodes-base 2.15.1 (438 node types); interactive import-test pending.** All three workflows pass every check above. They have not yet been opened in a running n8n instance, so this README does not claim they have been.

## Design notes

The decisions worth arguing about, and why they went the way they did.

- **Scoring is a rules Code node, not an LLM call.** A score that routes revenue has to be auditable, free, and instant. Rules give you all three: you can point at the line that awarded 40 points, it costs nothing to run a million times, and it returns in microseconds. An LLM would give you a defensible-sounding number that's expensive, slightly different every time, and impossible to explain to the sales lead who wants to know why their lead scored 65. The workflow ships `score_reasons` alongside the score for exactly that conversation.

- **LLM output is validated structurally, not just parsed.** `response_format: json_object` makes well-formed JSON very likely, and says nothing about whether the keys are right. The ticket workflow checks the parse, the object shape, the category against an allowlist, and the presence of a summary — then falls back to a human-reviewed queue on any failure. Trusting the model's *format* while validating its *content* is the only combination that survives contact with production.

- **Enrichment failures degrade instead of dropping leads.** A lead is a thing a human typed their name into. The enrichment node has an error output wired to a branch that sets `enriched: false` and continues, so a vendor's 503 costs the lead ten points rather than its existence. The general rule: when an optional enrichment step fails, the pipeline should get less accurate, not shorter.

- **Deduplicate before the model, not after.** One flapping host emits the same alert 400 times overnight. Sending all 400 to an LLM costs real money and skews the summary toward whatever was loudest rather than whatever mattered. Collapsing them first turned 412 alerts into 9 distinct issues in the example run — that's the difference between a digest that's cheap to run daily and one that isn't.

- **Numbers come from code; prose comes from the model.** The digest's subject line counts are read from the deduplication node, not from the model's text. Anything a human scans at a glance and acts on should be arithmetic, not generation.

- **Failure paths preserve the contract.** The triage webhook returns 200 with `category: "other"` and `needs_review: true` when the classifier is down, rather than a 500. The digest sends an unsummarized email rather than none. In both cases the consumer handles one shape and nothing silently stops arriving — an automation that fails quietly is worse than one that fails loudly.

## License

MIT
