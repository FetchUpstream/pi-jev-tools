# TypeSafe contract alignment

Sources checked: [docs index](https://docs.typesafe.ai/), [API](https://docs.typesafe.ai/api), [models](https://docs.typesafe.ai/models), [confidence](https://docs.typesafe.ai/confidence), [state](https://docs.typesafe.ai/concepts/state), [building guide](https://docs.typesafe.ai/concepts/how-to-build-with-system-one), all three primitive pages, [Jev 1.13 jaggedness](https://docs.typesafe.ai/model-jaggedness/jev-1.13), and [first-party skills](https://github.com/typesafe-ai/skills).

Wire source: https://api.typesafe.ai/openapi.json. SDK reference: https://github.com/typesafe-ai/typesafe-sdk-js/tree/66880ccded6cb642dc1809620c2b108c33730214/src (`types.ts`, `client.ts`, `retry.ts`).

## Content

Nested content supports all JSON values, including finite numbers, booleans and null. Top-level entries are string/object/array, not scalar numbers or booleans. Instructions can be omitted or null; Noul criteria can be null and either description can be omitted or null; Choice descriptions can be null.

The current SDK is broader than the wire schema: its EntryType allows null state and null Score levels/legends. The live OpenAPI excludes those nulls; this package follows the wire contract. Conversely, OpenAPI accepts one Score level (minItems=1), whereas the SDK and prose recommend two. General questions accept one; the scoring convenience helper retains the documented 2–10 useful ordered levels. The documented maximum of 10 Score levels and 255 Choice options remains enforced even though OpenAPI does not encode those maxima.

Provider responses are validated at the transport boundary; structured legends retain the existing canonicalization from the original rubric. No generated prose or arbitrary provider extensions reach Pi.

## Context and retries

Models documents 64k state + all questions, and 32k state + longest question. The serialized state, each question (including ID/map framing), all questions and envelope overhead use one four-characters/token estimator with upward rounding. This is approximate, not an exact tokenizer or a guarantee for every language. Files have an early raw-size ceiling, but escaped JSON, paths and questions are checked again before network transport. Nothing is truncated.

Retry classification matches SDK defaults (408, 429, all 5xx, connection/timeouts, interrupted bodies), two retries, capped jittered exponential backoff and server timing headers with millisecond precedence. Unlike the SDK, which has per-attempt timeouts and no total budget, we retain a 30s total deadline covering delivery and waits. A deadline expiry or caller cancellation is terminal; arbitrary transport messages/bodies remain sanitized.

## Why keep questions_json?

TypeBox can express the discriminated question union and recursive JSON, but installed Pi 0.99.1's `pi-ai/dist/api/constrained-sampling.js` rejects `$ref`, `$defs` and `patternProperties` for strict schemas. Its Google OpenAPI sanitizer strips `$defs`. A full recursive question contract therefore is not reliably portable across primary providers. Keep the validated JSON string boundary rather than a truncated-depth or weaker union schema. Recursive schemas are used for local output validation, not model-callable input declarations. The single-file convenience inputs intentionally remain simple text; the general and batch tools expose the full wire content contract.

Noul is P(yes); display P(no)=1-P(yes) for a no answer. The file boolean's >0.5 boundary and candidate helper's Choice confidence floor are separate convenience policies, not universal or interchangeable thresholds.
