# Ticket LLM Summarizer & Router

A synchronous triage endpoint. Post a ticket, get back a category, a three-sentence summary, and a suggested first diagnostic step — and the ticket lands in the right queue on the way out.

**File:** [`workflows/ticket-llm-summarizer.json`](../workflows/ticket-llm-summarizer.json)
**Trigger:** Webhook (`POST /webhook/ticket-triage`), responds synchronously

![The workflow on the n8n canvas: a webhook and normalize step feed an LLM classification request, whose success path goes to JSON validation and whose error path goes to a fallback, both converging on a switch that fans out to voice, network, infrastructure, and triage-review queues before responding to the webhook.](img/ticket-llm-summarizer.png)

## Node-by-node

### 1. New Ticket Webhook

`POST` on path `ticket-triage`, `responseMode: responseNode`.

Synchronous on purpose. A ticketing system that calls this on create can act on the answer immediately — set the queue, show the summary to the person who opened it, decide whether to page someone — instead of waiting for a callback it would have to build a receiver for.

### 2. Normalize Ticket

Set node pulling `ticket_id`, `subject`, `ticket_body`, and `requester` out of the webhook body, each with a fallback key (`id` for `ticket_id`, `description` for `body`, `from` for `requester`).

**The body is truncated to 6000 characters here, not in the prompt.** Someone will eventually paste a 40-page log into a ticket, and that should cost a bounded number of tokens. Doing it in a Set node rather than asking the model to ignore the excess means the limit is enforced before you pay for it.

### 3. Classify & Summarize

HTTP Request to an OpenAI-compatible `/v1/chat/completions`, with three settings that matter:

- **`temperature: 0`** — triage must be repeatable. The same ticket submitted twice must not land in two different queues.
- **`response_format: { type: "json_object" }`** — makes well-formed JSON very likely.
- **`onError: continueErrorOutput`** — the error branch keeps the endpoint's contract intact when the model is unreachable.

The prompt defines all four categories explicitly (voice / network / infrastructure / other) with the kinds of issues each covers, names the exact keys required, and instructs the model to lower `confidence` rather than invent a fifth category when a ticket is ambiguous.

### 4a. Parse & Validate JSON (success path)

A Code node, and the most important node in the workflow.

`response_format: json_object` makes well-formed JSON very likely — **not certain — and it says nothing about whether the keys are right.** Models drop fields, wrap output in code fences despite instructions, invent categories, and occasionally return prose when they decide the request was unusual. Any of those would otherwise route a real ticket into a queue that doesn't exist.

The node checks, in order:

1. Content is a non-empty string
2. Strips ` ```json ` fences if present
3. `JSON.parse` succeeds
4. Result is a plain object, not an array or `null`
5. `category` is one of the four valid values
6. `summary` is non-empty
7. `confidence` is coerced to a finite number and clamped to 0–1

Every failure produces the same fallback shape: category `other`, `confidence: 0`, `needs_review: true`, and a `classifier_error` naming what went wrong. **Degraded, never dropped.**

Classifications that parse cleanly but come back under 0.5 confidence are routed normally and flagged `needs_review`, so the queue owner knows to sanity-check before spending time on it.

### 4b. Classifier Unreachable (error path)

When the HTTP call itself fails — network, auth, rate limit, 5xx — this node builds the same fallback shape with the transport error attached.

A triage endpoint that returns a 500 when the model is down turns one outage into two: now the ticketing system's create hook is failing too.

### 5. Route by Category

Switch node with three rules and a fallback output. The fallback is doing real work: it catches both genuine `other` tickets and every validation failure from the two nodes before it.

### 6. The four assignment nodes

Voice, network, and infrastructure each POST to the ticketing system's assignment endpoint with their queue name. The fourth, `Assign to Triage Review`, forces `needs_review: true` and passes `classifier_error` through.

The summary and first diagnostic step are **written back onto the ticket**, not sent to a chat channel. The engineer who picks it up reads them in context, where they're still useful a week later.

Keeping genuine `other` tickets and classifier failures in one human-reviewed queue is what makes this safe to leave running unattended.

### 7. Respond with Classification

Returns the classification as JSON with `responseCode: 200`.

**Always 200, even on a classifier failure.** Category `other` with `needs_review: true` is a real answer, not an error the caller has to write a handler for.

## JSON contract

**In** (`POST /webhook/ticket-triage`):

```json
{
  "ticket_id": "INC-48213",
  "subject": "Phones dropping calls at the Mesa office",
  "body": "Since about 9am staff at Mesa report calls disconnecting after roughly 30 seconds. Affects all handsets. Internet seems fine.",
  "requester": "jgarza@client.example.com"
}
```

**Out** (HTTP 200):

```json
{
  "ticket_id": "INC-48213",
  "category": "voice",
  "confidence": 0.92,
  "summary": "Staff at the Mesa office report calls disconnecting after approximately 30 seconds, beginning around 9am. All handsets at the site are affected while general internet connectivity appears unaffected. The site-wide scope and consistent timing suggest a service-level fault rather than individual handset failures.",
  "first_diagnostic_step": "Check the SIP trunk registration and session timer settings on the Mesa PBX.",
  "needs_review": false
}
```

**Out when classification failed** (still HTTP 200):

```json
{
  "ticket_id": "INC-48213",
  "category": "other",
  "confidence": 0,
  "summary": "Automatic classification failed (malformed JSON: Unexpected token < in JSON at position 0). Subject: Phones dropping calls at the Mesa office",
  "first_diagnostic_step": "Read the ticket manually — the classifier did not return usable output.",
  "needs_review": true
}
```

The caller handles one shape either way.

## What to swap for production

| Node | Replace | With |
|---|---|---|
| Classify & Summarize | Base URL and `model` | Your gateway and model; attach the API credential |
| Classify & Summarize | Category definitions in the system prompt | Your actual queues — this is the main thing to edit |
| Parse & Validate JSON | `VALID_CATEGORIES` | The same list, kept in sync with the prompt |
| The four assign nodes | `https://desk.example.com/...` | Your ticketing system's assignment endpoint |

`VALID_CATEGORIES` in the Code node and the category list in the prompt have to agree. If you add a queue, change both — the validator will otherwise reject the model's correct answer and dump a perfectly good ticket into triage review.

## Extension ideas

The obvious next step is measuring the thing: log every classification alongside the queue a human ultimately moved the ticket to, and you have a labelled dataset telling you both the real accuracy and which category pairs get confused. That's also what tells you whether the 0.5 confidence threshold is set anywhere near the right place. Beyond that — add a severity or urgency field to the same call, since the model has already read the ticket and a second call would be wasted; feed the requester's recent ticket history into the prompt so recurring problems get recognized as recurring; and route `needs_review` tickets to a channel rather than a queue if the volume is low enough that someone will actually look.
