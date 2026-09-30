import { JevClient } from "../extensions/jev/lib/client.ts";
import { readConfig } from "../extensions/jev/lib/config.ts";

// Outside tests/ and not imported by any unit test. Paid calls require explicit opt-in.
if (process.env.JEV_LIVE !== "1") throw new Error("Live tests are opt-in. Run bun run test:integration.");
if (!process.env.TYPESAFE_API_KEY?.trim() && !process.env.OPENROUTER_API_KEY?.trim()) {
  console.log("SKIP: set TYPESAFE_API_KEY or OPENROUTER_API_KEY for a small paid integration call.");
} else {
  const config = readConfig();
  const result = await new JevClient().systemOne({ message: "The token is valid." }, {
    valid: { type: "noul", instructions: ["Does `message` say the token is valid?"], criteria: { true: { description: "Valid token" }, false: ["Invalid or unspecified"] } },
    kind: { type: "choice", instructions: { question: "What does `message` report?" }, criteria: { valid: { description: "Valid token" }, invalid: ["Invalid token"], other: null } },
    certainty: { type: "score", instructions: "How clear is `message`?", criteria: [{ description: "Ambiguous" }, ["Explicit"]] },
  });
  console.log(JSON.stringify({ provider: config.provider, ...result }));
}
