export type ProviderId = "anthropic" | "openai" | "openrouter";

export type ProviderConfig = {
  id: ProviderId;
  apiKey: string;
  model: string;
};

export type StreamParams = {
  config: ProviderConfig;
  systemPrompt: string;
  userContent: string;
  maxTokens: number;
  onTextDelta: (text: string) => void;
  signal?: AbortSignal;
};

export type ProviderMeta = {
  id: ProviderId;
  label: string;
  defaultModel: string;
  keyPlaceholder: string;
  keyHelpUrl: string;
};

export const PROVIDERS: Record<ProviderId, ProviderMeta> = {
  anthropic: {
    id: "anthropic",
    label: "Anthropic (Claude)",
    defaultModel: "claude-sonnet-4-6",
    keyPlaceholder: "sk-ant-...",
    keyHelpUrl: "https://console.anthropic.com/settings/keys",
  },
  openai: {
    id: "openai",
    label: "OpenAI (GPT)",
    defaultModel: "gpt-4.1",
    keyPlaceholder: "sk-...",
    keyHelpUrl: "https://platform.openai.com/api-keys",
  },
  openrouter: {
    id: "openrouter",
    label: "OpenRouter",
    defaultModel: "anthropic/claude-sonnet-4.6",
    keyPlaceholder: "sk-or-...",
    keyHelpUrl: "https://openrouter.ai/keys",
  },
};

export class ProviderHttpError extends Error {
  status: number;
  retryAfterMs?: number;
  constructor(message: string, status: number, retryAfterMs?: number) {
    super(message);
    this.name = "ProviderHttpError";
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

export function httpErrorFromResponse(
  providerLabel: string,
  res: Response,
  body: string,
): ProviderHttpError {
  const ra = res.headers.get("retry-after");
  let retryAfterMs: number | undefined;
  if (ra) {
    const n = Number(ra);
    if (Number.isFinite(n) && n > 0) retryAfterMs = n * 1000;
  }
  return new ProviderHttpError(
    `${providerLabel} API ${res.status}: ${body}`,
    res.status,
    retryAfterMs,
  );
}
