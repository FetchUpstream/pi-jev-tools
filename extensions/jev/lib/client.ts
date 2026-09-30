// Transport and retry policy adapted from Ten Levels of Jev (MIT).
import { setTimeout as delay } from "node:timers/promises";
import { readConfig, PROVIDERS } from "./config.ts";
import { compactResponse, ContractError, validateResponse } from "./response.ts";
import { QuestionValidationError, validateRequest, type Questions, type State } from "./types.ts";
import { validateBudget } from "./budget.ts";

export type Decision = ReturnType<typeof compactResponse>;
export type Decide = (state: State, questions: Questions) => Promise<Decision>;
export const isRetryableStatus = (status: number): boolean => status === 408 || status === 429 || (status >= 500 && status <= 599);

export function parseRetryAfter(headers: Headers, now = Date.now()): number | undefined {
  const rawMs = headers.get("retry-after-ms");
  if (rawMs?.trim() && Number.isFinite(Number(rawMs)) && Number(rawMs) >= 0) return Number(rawMs);
  const raw = headers.get("retry-after")?.trim();
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return seconds >= 0 ? seconds * 1000 : undefined;
  if (!/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)/i.test(raw)) return undefined;
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}
export function retryAfterMs(header: string | null): number {
  return parseRetryAfter(new Headers(header === null ? {} : { "retry-after": header })) ?? 0;
}
export function retryWaitMs(attempt: number, initial: number, headers?: Headers, random = Math.random()): number {
  const server = headers ? parseRetryAfter(headers) : undefined;
  if (server !== undefined && server <= 60_000) return server;
  return Math.round(Math.min(5000, initial * 2 ** (attempt - 1)) * (1 - random * 0.25));
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
    validateBudget(request);
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
          if (attempt < 3) {
            await delay(retryWaitMs(attempt, retryDelay), undefined, { signal: combined });
            continue;
          }
          // Do not relay arbitrary transport messages that might include credentials.
          throw new Error(`Jev ${config.provider} request failed. Check network access.`);
        }
        if (isRetryableStatus(response.status) && attempt < 3) {
          const wait = retryWaitMs(attempt, retryDelay, response.headers);
          await response.body?.cancel().catch(() => {});
          await delay(wait, undefined, { signal: combined });
          continue;
        }
        if (!response.ok) {
          await response.body?.cancel().catch(() => {});
          let hint = "";
          if (response.status === 401) hint = ` Check ${PROVIDERS[config.provider].key}.`;
          else if (response.status === 402) hint = " Check account credits.";
          throw new Error(`Jev ${config.provider} HTTP ${response.status}.${hint}`);
        }
        let text: string;
        try { text = await response.text(); }
        catch {
          combined.throwIfAborted();
          if (attempt < 3) {
            await delay(retryWaitMs(attempt, retryDelay), undefined, { signal: combined });
            continue;
          }
          throw new Error(`Jev ${config.provider} response delivery failed. Check network access.`);
        }
        let parsed: unknown;
        try { parsed = JSON.parse(text); }
        catch { throw new ContractError("Invalid response JSON."); }
        combined.throwIfAborted();
        validateResponse(parsed, request.questions);
        return compactResponse(parsed, request.questions);
      }
      throw new Error("Jev retries exhausted.");
    } catch (error) {
      combined.throwIfAborted();
      throw error;
    } finally { clearTimeout(timer); }
  }
}
