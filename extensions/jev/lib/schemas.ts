import { Type } from "typebox";

export const Text = Type.String({ minLength: 1, pattern: "\\S" });
export const Unit = Type.Number({ minimum: 0, maximum: 1 });
export const Count = Type.Integer({ minimum: 0 });
export const Probabilities = Type.Record(Type.String(), Unit);
export const Legend = Type.Record(Type.String(), Type.String());
export const Usage = Type.Object({ input_tokens: Count, output_tokens: Count, cost: Type.Optional(Type.Number({ minimum: 0 })) }, { additionalProperties: false });
export const Answer = Type.Union([
  Type.Object({ type: Type.Literal("noul"), noul: Unit }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("choice"), choice: Type.String(), confidence: Unit, probabilities: Probabilities }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("score"), score: Type.Number({ minimum: 0, maximum: 9 }), confidence: Unit, probabilities: Probabilities, legend: Legend }, { additionalProperties: false }),
]);
export const Answers = Type.Record(Type.String(), Answer);
export const Skipped = Type.Array(Type.Object({ path: Type.String(), reason: Type.String() }, { additionalProperties: false }));
export const Summary = Type.Object({
  own_fields: Type.Array(Type.String()), files: Type.Array(Type.String()),
  output: Type.Union([Type.String(), Type.Null()]), skipped: Skipped, tokens: Count,
}, { additionalProperties: false });
export const GeneralInput = Type.Object({
  questions_json: Text,
  state: Type.Optional(Type.String({ maxLength: 8000, description: "Short note or JSON object/array string; do not paste files or command output." })),
  paths: Type.Optional(Type.Array(Text, { minItems: 1, description: "Files, directories or globs in the workspace; at most 20 expanded files." })),
  command: Type.Optional(Text),
}, { additionalProperties: false });
export const BoolOutput = Type.Object({ path: Type.String(), answer: Type.Boolean(), noul: Unit, usage: Usage }, { additionalProperties: false });
export const ChoiceOutput = Type.Object({ path: Type.String(), choice: Type.String(), confidence: Unit, probabilities: Probabilities, usage: Usage }, { additionalProperties: false });
export const ScoreOutput = Type.Object({ path: Type.String(), score: Type.Number({ minimum: 0, maximum: 9 }), top: Type.Integer({ minimum: 1, maximum: 9 }), nearest: Type.String(), confidence: Unit, legend: Legend, usage: Usage }, { additionalProperties: false });
export const FilesOutput = Type.Object({
  results: Type.Array(Type.Object({ path: Type.String(), answers: Answers, usage: Usage }, { additionalProperties: false })),
  skipped: Skipped, calls: Count, attempts: Count,
}, { additionalProperties: false });
export const PickOutput = Type.Object({ path: Type.Union([Type.String(), Type.Null()]), confidence: Unit, probabilities: Probabilities }, { additionalProperties: false });
export const GeneralOutput = Type.Object({ answers: Answers, usage: Usage, model: Type.String(), state_summary: Summary }, { additionalProperties: false });
