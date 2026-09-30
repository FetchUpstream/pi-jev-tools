// Transport and retry policy adapted from Ten Levels of Jev (MIT).
import { setTimeout as delay } from "node:timers/promises";
import { readConfig, PROVIDERS } from "./config.ts";
import { compactResponse, ContractError, validateResponse } from "./response.ts";
import { LIMITS, QuestionValidationError, validateRequest, type Questions, type State } from "./types.ts";

export type Decision = ReturnType<typeof compactResponse>;
export type Decide = (state: State, questions: Questions) => Promise<Decision>;
const RETRY_STATUSES = new Set([429, 502, 503, 529]);

export function retryAfterMs(header: string | null): number {
  if (!header?.trim()) return 0;
  const value = header.trim();
  if (/^\d+(?:\.\d+)?$/.test(value)) {
    const ms = Number(value) * 1000;
    return Number.isFinite(ms) ? ms : 0;
  }
  if (!/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)/i.test(value)) return 0;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : 0;
}

/** Credentials are resolved only on execution, not when Pi loads the extension. */
export class JevClient {
  constructor(private readonly options: {
    env?: NodeJS.ProcessEnv;
    fetch?: typeof fetch;
    timeoutMs?: number;
    retryDelayMs?: number;
  } = {}) {}

  async systemOne(state: State, questions: Questions, signal?: AbortSignal): Promise<Decision> {
    signal?.throwIfAborted();
    validateRequest({ state, questions });
    const config = readConfig(this.options.env);
    let body: string;
    try { body = JSON.stringify({ model: config.model, state, questions }); }
    catch { throw new QuestionValidationError("Request must be JSON-serializable (no cycles or BigInt)."); }
    const request: unknown = JSON.parse(body);
    validateRequest(request);
    // Preserve the 64k shared budget, including large question blocks and JSON overhead.
    if (Math.ceil(body.length / 4) > LIMITS.TOTAL_TOKEN_BUDGET) {
      throw new QuestionValidationError("Jev request exceeds the 64k shared token estimate. Narrow the input or split the questions.");
    }
    const timeout = this.options.timeoutMs ?? 30_000;
    if (!Number.isInteger(timeout) || timeout <= 0 || timeout > 2_147_483_647) throw new Error("Invalid request timeout.");
    const retryDelay = this.options.retryDelayMs ?? 500;
    if (!Number.isFinite(retryDelay) || retryDelay < 0) throw new Error("Invalid retry delay.");
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(new DOMException("Jev request timed out.", "TimeoutError")), timeout);
    const combined = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
    try {
      for (let attempt = 1; attempt <= 3; attempt++) {
        combined.throwIfAborted();
        let response: Response;
        try {
          response = await (this.options.fetch ?? fetch)(config.endpoint, {
            method: "POST", redirect: "error", signal: combined,
            headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" }, body,
          });
        } catch {
          combined.throwIfAborted();
          // Do not relay arbitrary transport messages that might include credentials.
          throw new Error(`Jev ${config.provider} request failed. Check network access.`);
        }
        if (RETRY_STATUSES.has(response.status) && attempt < 3) {
          const backoff = retryDelay * 2 ** (attempt - 1) * (1 + Math.random() * 0.2);
          const wait = Math.min(8000, Math.max(backoff, retryAfterMs(response.headers.get("retry-after"))));
          await response.body?.cancel();
          await delay(wait, undefined, { signal: combined });
          continue;
        }
        if (!response.ok) {
          await response.body?.cancel();
          let hint = "";
          if (response.status === 401) hint = ` Check ${PROVIDERS[config.provider].key}.`;
          else if (response.status === 402) hint = " Check account credits.";
          throw new Error(`Jev ${config.provider} HTTP ${response.status}.${hint}`);
        }
        let parsed: unknown;
        try { parsed = JSON.parse(await response.text()); }
        catch {
          combined.throwIfAborted();
          throw new ContractError("Invalid response JSON.");
        }
        combined.throwIfAborted();
        validateResponse(parsed, request.questions);
        return compactResponse(parsed, request.questions);
      }
      throw new Error("Jev retries exhausted.");
    } finally { clearTimeout(timer); }
  }
}
