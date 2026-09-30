// Provider contract adapted from Ten Levels of Jev (MIT).
export const PROVIDERS = {
  typesafe: { key: "TYPESAFE_API_KEY", endpoint: "https://api.typesafe.ai/v1/systemone", model: "jev-latest" },
  openrouter: { key: "OPENROUTER_API_KEY", endpoint: "https://openrouter.ai/api/alpha/decisions", model: "~typesafe/jev-latest" },
} as const;
export type Provider = keyof typeof PROVIDERS;
export const NOT_CONFIGURED = "Jev is not configured. Set TYPESAFE_API_KEY or OPENROUTER_API_KEY.";

export function readConfig(env: NodeJS.ProcessEnv = process.env) {
  const selected = env.JEV_BACKEND?.trim();
  if (selected && selected !== "typesafe" && selected !== "openrouter") {
    throw new Error("JEV_BACKEND must be typesafe or openrouter. Offline mocks are test-only.");
  }
  const provider: Provider | undefined = selected || (env.TYPESAFE_API_KEY?.trim() ? "typesafe"
    : env.OPENROUTER_API_KEY?.trim() ? "openrouter" : undefined);
  if (!provider) throw new Error(NOT_CONFIGURED);
  const config = PROVIDERS[provider];
  const apiKey = env[config.key]?.trim();
  if (!apiKey) throw new Error(`${NOT_CONFIGURED} Selected provider ${provider} requires ${config.key}.`);
  return { provider, apiKey, endpoint: config.endpoint, model: config.model };
}
