/** Fails closed if a runtime bypasses the shared environment validation. */
export function assertSupportedLlmProvider(provider: string | undefined): void {
  if (provider !== undefined && provider !== 'openai') {
    throw new Error('Only the configured OpenAI LLM provider is supported');
  }
}
