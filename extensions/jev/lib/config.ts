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
  let provider: Provider | undefined;
  if (selected === "typesafe" || selected === "openrouter") provider = selected;
  else if (env.TYPESAFE_API_KEY?.trim()) provider = "typesafe";
  else if (env.OPENROUTER_API_KEY?.trim()) provider = "openrouter";
  if (!provider) throw new Error(NOT_CONFIGURED);
  const config = PROVIDERS[provider];
  const apiKey = env[config.key]?.trim();
  if (!apiKey) throw new Error(`${NOT_CONFIGURED} Selected provider ${provider} requires ${config.key}.`);
  const override = env.JEV_MODEL?.trim() || (provider === "typesafe" ? env.TYPESAFE_DEFAULT_MODEL?.trim() : env.OPENROUTER_MODEL?.trim());
  let model = override || config.model;
  if (provider === "openrouter" && model.startsWith("jev-")) model = `~typesafe/${model}`;
  return { provider, apiKey, endpoint: config.endpoint, model };
}
