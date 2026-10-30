export const llmConfig = () => ({
  llm: {
    provider: process.env.LLM_PROVIDER ?? 'openai',
    apiKey: process.env.LLM_API_KEY ?? '',
    model: process.env.LLM_MODEL ?? '',
    requestTimeoutMs: Number(process.env.LLM_REQUEST_TIMEOUT_MS ?? 30_000),
  },
});
