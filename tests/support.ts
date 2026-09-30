import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Decide } from "../extensions/jev/lib/client.ts";
import type { Answer, Questions, SystemOneResponse } from "../extensions/jev/lib/types.ts";

export const Q: Questions = { q: { type: "noul", instructions: "Does the content validate tokens?" } };
export const Q_JSON = JSON.stringify(Q);
export function response(questions: Questions = Q): SystemOneResponse {
  const answers: Record<string, Answer> = Object.fromEntries(Object.entries(questions).map(([id, q]) => {
    if (q.type === "noul") return [id, { type: "noul", noul: 0.8 }];
    if (q.type === "choice") {
      const keys = Object.keys(q.criteria);
      return [id, { type: "choice", choice: keys[0], confidence: 0.9, probabilities: Object.fromEntries(keys.map((key, i) => [key, i === 0 ? 1 : 0])) }];
    }
    return [id, { type: "score", score: q.criteria.length - 1, confidence: 0.9, legend: Object.fromEntries(q.criteria.map((level, i) => [String(i), level])), probabilities: Object.fromEntries(q.criteria.map((_, i) => [String(i), i === q.criteria.length - 1 ? 1 : 0])) }];
  }));
  return { answers, model: "jev-unit-test", usage: { input_tokens: 20, output_tokens: 5, cost: 0 } };
}
export const fakeDecide: Decide = async (_state, questions) => {
  const r = response(questions);
  return { answers: r.answers, model: r.model, usage: { input_tokens: 20, output_tokens: 5, cost: 0 } };
};
export async function fixture(files: Record<string, string | Buffer> = { "src/a.ts": "export const checkToken = true;", "src/b.ts": "export const route = 1;" }) {
  const dir = await mkdtemp(join(tmpdir(), "pi-jev-test-"));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), content);
  }
  return dir;
}
