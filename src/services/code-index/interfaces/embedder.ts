/**
 * Interface for code index embedders.
 * This interface is implemented by both OpenAI and Ollama embedders.
 */
export interface IEmbedder {
	/**
	 * Creates embeddings for the given texts.
	 * @param texts Array of text strings to create embeddings for
	 * @param model Optional model ID to use for embeddings
	 * @returns Promise resolving to an EmbeddingResponse
	 */
	createEmbeddings(texts: string[], model?: string): Promise<EmbeddingResponse>

	/**
	 * Validates the embedder configuration by testing connectivity and credentials.
	 * @returns Promise resolving to validation result with success status and optional error message
	 */
	validateConfiguration(): Promise<EmbedderValidationResult>

	get embedderInfo(): EmbedderInfo
}

/**
 * Outcome of an embedder validation.
 *
 * Validation issues a probe embedding, so implementations can report the vector length the
 * model actually returned. Callers use it to catch a configured dimension that disagrees with
 * the model before indexing starts — otherwise the mismatch only surfaces as a rejected upsert.
 */
export interface EmbedderValidationResult {
	valid: boolean
	error?: string
	/** Length of the probe embedding, when the implementation observed one. */
	dimension?: number
}

export interface EmbeddingResponse {
	embeddings: number[][]
	usage?: {
		promptTokens: number
		totalTokens: number
	}
}

export type AvailableEmbedders =
	| "openai"
	| "ollama"
	| "openai-compatible"
	| "gemini"
	| "mistral"
	| "vercel-ai-gateway"
	| "bedrock"
	| "openrouter"

export interface EmbedderInfo {
	name: AvailableEmbedders
}
