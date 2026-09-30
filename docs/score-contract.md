# Score response normalization

Sources inspected for this change:

- First-party [Score](https://docs.typesafe.ai/primitives/score) documentation: score is the sum of level number × probability; legend maps requested criteria to level numbers.
- First-party [Confidence](https://docs.typesafe.ai/confidence): confidence is a distribution statistic, but no exact formula is published.
- [System One OpenAPI](https://api.typesafe.ai/openapi.json), `ScoreAnswer`: all five fields are required, score is the expected weighted average, probabilities sum approximately to one.
- [Ten Levels of Jev client](https://github.com/disler/ten-levels-of-jev/blob/main/apps/ten-levels/src/core/client.ts): validates score range and legend but does not impose score/distribution equality.

The original review's four rejected raw responses were not retained. A new live reproduction against `jev-1.13.0`, using public repository source, captured this same failure shape:

| Returned score | Returned probabilities (levels 0, 1, 2) | Weighted mean |
| --- | --- | --- |
| 0.09 | 0.94, 0.04, 0.02 | 0.08 |
| 0.61 | 0.45, 0.48, 0.07 | 0.62 |

These exact answer values are regression-tested. They demonstrate that independently rounded score and probabilities can differ by 0.01: the former 0.005 equality tolerance rejected otherwise valid distributions. The provider's internal rounding implementation and the original four values cannot be proven from these observations.

## Narrow normalization

Validate the entire envelope, answer type, confidence range, exact probability keys, finite unit probabilities, and the existing approximate-sum tolerance (0.025). Missing/invalid/out-of-range provider scores still fail. Legends must still be objects with exactly the declared level keys and string values; malformed/missing legends fail.

After validation, construct a new compact score answer:

- Keep provider probabilities unchanged so model consumers can inspect the actual distribution.
- Compute score as `sum(level × probability) / sum(probabilities)`, accounting for the permitted rounded probability sum. Bound the derived result at the rubric's top level to prevent infinitesimal floating-point overshoot (for example, `9 × 0.992 / 0.992` yields `9.000000000000002`). This happens only after all wire values are validated.
- Construct legend from the original request criteria; ignore harmless provider description differences.
- Keep validated provider confidence. Do **not** substitute maximum probability, entropy, or an undocumented formula.

No raw response is mutated. Choice maximum-probability consistency, undeclared-choice rejection, and all other validation remain intact. Result schemas and usage accounting do not change; only redundant score/legend values become canonical.
