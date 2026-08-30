# Result contract

Read this after a job is claimed. Submit exactly the schema version returned by
the job.

## Top-level object

```json
{
  "schema_version": 1,
  "assessment": {
    "overall_evidence": "insufficient | weak | moderate | strong",
    "notes": "Concise assessment of the supplied X evidence and research gaps"
  },
  "sources": [],
  "ideas": []
}
```

Unknown fields are not allowed. `ideas` may be empty and may contain at most
five candidates. `sources` may contain at most 40 entries. The complete JSON
result must be no larger than 1 MiB. `assessment.notes` may be empty and is
limited to 4,000 characters. A nonempty `ideas` array requires
`assessment.overall_evidence` to be `moderate` or `strong`.

## External source

Each source has:

```json
{
  "source_id": "src_competitor_1",
  "url": "https://public.example/page",
  "title": "Page title",
  "publisher": null,
  "published_at": null,
  "accessed_at": "ISO-8601 timestamp",
  "source_type": "competitor",
  "supported_claims": ["Short factual claim supported by this page"]
}
```

`source_id` must match `^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$` and be unique
within the result. URLs are normalized before comparison and must also be
unique. `url` is limited to 2,048 characters, `title` to 500, and non-null
`publisher` to 300. Timestamps must be valid ISO-8601 values; use JSON `null`
when publisher or publication time is unknown. Allowed `source_type` values
are:

- `competitor`
- `competitor_pricing`
- `customer_evidence`
- `feasibility`
- `distribution`
- `latam_fit`
- `risk`
- `other`

Use only public HTTP or HTTPS URLs without credentials or fragments. Each
source needs 1–20 unique supported claims, each at most 1,000 characters. Do
not include page bodies, search dumps, hidden prompts, or copied articles.

## Candidate

Each candidate preserves this exact product contract:

```json
{
  "rank": 1,
  "cluster_id": "UUID from the claimed payload",
  "title": "Specific product title",
  "target_customer": "Specific paying customer",
  "problem": "Recurring problem supported by the selected X cluster",
  "offer": "Narrow self-serve website and outcome",
  "why_pay": "Why the customer would pay",
  "why_now": "Why the opportunity is timely",
  "initial_price": "Plausible starting price",
  "differentiation": "Specific wedge against researched alternatives",
  "speed_to_first_revenue": "Plausible route to first revenue",
  "validation_plan": "Seven-day test with a measurable pass threshold",
  "product_spec": {
    "archetype": "one allowed value from the job product contract",
    "core_action": "Specific action the website completes",
    "value_mechanisms": ["one to three allowed values"],
    "delivery_mode": "self_serve_web_app",
    "sales_motion": "self_serve_checkout",
    "business_model": "one allowed value",
    "mvp_scope": "Narrow inclusions and exclusions",
    "mvp_build_weeks": 4,
    "recurring_trigger": "Concrete reason to return",
    "latam_fit": "none | adaptable | primary_wedge",
    "latam_rationale": "Evidence-aware rationale that is not translation"
  },
  "hard_filter_checks": {
    "website_deliverable": true,
    "self_serve_without_call": true,
    "solo_mvp_feasible": true,
    "recurring_use": true,
    "creates_allowed_value": true,
    "specific_action_not_chat": true,
    "no_hardware": true,
    "no_healthcare_therapy_or_medical": true,
    "no_consulting_agency_audit_or_workshop": true,
    "no_custom_implementation": true,
    "no_enterprise_sales": true,
    "no_translation": true,
    "no_generic_chat_or_companion": true
  },
  "risks": ["Material risk or uncertainty"],
  "assumptions": ["Inference that still needs validation"],
  "evidence_score": 75,
  "source_post_ids": ["three to five IDs from this cluster"],
  "research_source_ids": ["one to ten IDs from sources"],
  "claim_source_map": [
    {
      "claim": "Candidate claim supported by external research",
      "research_source_ids": ["src_competitor_1"]
    }
  ]
}
```

Use the exact enum values supplied in the claimed job's `product_contract`.
Every hard check must honestly be true or the candidate must be omitted.
`product_spec.delivery_mode` must be `self_serve_web_app`; the job's scalar
delivery mode is authoritative. A candidate's `evidence_score` must meet
`product_contract.minimum_x_evidence_score`.
`source_post_ids` must contain three to five unique posts from the candidate's
own `cluster_id` and represent at least three authors. Every
`research_source_id` must exist in `sources`, and every cited source must appear
in at least one `claim_source_map` entry. Each mapped `claim` must exactly match
one string in that source's `supported_claims` array. Every externally
verifiable factual claim used in any candidate field must appear in this map;
uncited reasoning belongs in `assumptions` or `risks`.

Use 1–10 unique `research_source_ids` and 1–12 unique claim mappings per idea.
Use 1–5 unique `risks` and 1–5 unique `assumptions`, each string at most 1,000
characters. Field limits are: title 200; target customer and initial price 500;
speed to first revenue and each of core action, recurring trigger, and LATAM
rationale 1,000; problem, offer, why-pay, why-now, differentiation, validation
plan, and MVP scope 2,000. Use consecutive ranks beginning at one.

The final website may reject candidates or publish only the strongest three.
Do not compensate by weakening the result.
