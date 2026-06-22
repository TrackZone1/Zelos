import { ChatMessage } from './Agent';

export interface ModelDetails {
	id: string;
	displayName: string;
	family: 'codex' | 'claude' | 'gemini-native' | 'gemini-openai' | 'gpt-openai';
}

export const ALL_CHAT_MODELS: ModelDetails[] = [
	// Codex style models
	{ id: 'gpt-5-5', displayName: 'GPT 5.5 (Codex)', family: 'codex' },
	{ id: 'gpt-5-4', displayName: 'GPT 5.4 (Codex)', family: 'codex' },
	{ id: 'gpt-5-codex', displayName: 'GPT 5.0 Codex', family: 'codex' },
	{ id: 'gpt-5.1-codex', displayName: 'GPT 5.1 Codex', family: 'codex' },
	{ id: 'gpt-5.2-codex', displayName: 'GPT 5.2 Codex', family: 'codex' },
	{ id: 'gpt-5.3-codex', displayName: 'GPT 5.3 Codex', family: 'codex' },
	{ id: 'gpt-5.4-codex', displayName: 'GPT 5.4 Codex', family: 'codex' },

	// GPT chat-completions
	{ id: 'gpt-5-2', displayName: 'GPT 5.2 (OpenAI)', family: 'gpt-openai' },

	// Claude Models
	{ id: 'claude-opus-4-7', displayName: 'Claude Opus 4.7', family: 'claude' },
	{ id: 'claude-opus-4-8', displayName: 'Claude Opus 4.8', family: 'claude' },
	{ id: 'cluade-fable-5', displayName: 'Claude Fable 5', family: 'claude' },
	{ id: 'claude-haiku-4-5', displayName: 'Claude Haiku 4.5', family: 'claude' },
	{ id: 'claude-opus-4-5', displayName: 'Claude Opus 4.5', family: 'claude' },
	{ id: 'claude-opus-4-6', displayName: 'Claude Opus 4.6', family: 'claude' },
	{ id: 'claude-sonnet-4-5', displayName: 'Claude Sonnet 4.5', family: 'claude' },
	{ id: 'claude-sonnet-4-6', displayName: 'Claude Sonnet 4.6', family: 'claude' },

	// Gemini Native
	{ id: 'gemini-3.5-flash', displayName: 'Gemini 3.5 Flash (Native)', family: 'gemini-native' },
	{ id: 'gemini-3-flash-v1betamodels', displayName: 'Gemini 3 Flash (v1beta Native)', family: 'gemini-native' },
	{ id: 'gemini-3-flash-v1beta', displayName: 'Gemini 3 Flash (v1beta)', family: 'gemini-native' }, // alias to be safe

	// Gemini OpenAI-compatible
	{ id: 'gemini-2.5-pro-openai', displayName: 'Gemini 2.5 Pro (openai)', family: 'gemini-openai' },
	{ id: 'gemini-3-pro-openai', displayName: 'Gemini 3 Pro (openai)', family: 'gemini-openai' },
	{ id: 'gemini-3.1-pro-openai', displayName: 'Gemini 3.1 Pro (openai)', family: 'gemini-openai' },
	{ id: 'gemini-2.5-flash-openai', displayName: 'Gemini 2.5 Flash (openai)', family: 'gemini-openai' },
	{ id: 'gemini-3-flash-openai', displayName: 'Gemini 3 Flash (openai)', family: 'gemini-openai' },
	{ id: 'gemini-3.5-flash-openai', displayName: 'Gemini 3.5 Flash (openai)', family: 'gemini-openai' },
];

export class ModelProvider {
	/** Resolves the specific endpoint URL for a given model. */
	public static resolveApiUrl(baseUrl: string, model: string): string {
		const cleanUrl = baseUrl.replace(/\/+$/, '');
		const isKie = cleanUrl.includes('api.kie.ai') || cleanUrl.includes('kie.ai');

		if (!isKie) {
			return baseUrl;
		}

		// 1. Gemini Native Models
		if (model === 'gemini-3.5-flash') {
			return 'https://api.kie.ai/gemini/v1/models/gemini-3-5-flash:streamGenerateContent';
		}
		if (model === 'gemini-3-flash-v1betamodels' || model === 'gemini-3-flash-v1beta') {
			return 'https://api.kie.ai/gemini/v1/models/gemini-3-flash-v1betamodels:streamGenerateContent';
		}

		// 2. Gemini OpenAI-compatible Models
		if (model.startsWith('gemini-') && model.endsWith('-openai')) {
			const actualModel = model.replace('-openai', '').replace('2.5', '2.5').replace('3.5', '3-5');
			return `https://api.kie.ai/${actualModel}/v1/chat/completions`;
		}
		// Also support if it is already in standard format (e.g. gemini-2.5-pro or gemini-3.5-flash-openai)
		if (model === 'gemini-2.5-pro' || model === 'gemini-3-pro' || model === 'gemini-3.1-pro' || model === 'gemini-2.5-flash' || model === 'gemini-3-flash') {
			return `https://api.kie.ai/${model}/v1/chat/completions`;
		}
		if (model === 'gemini-3-5-flash-openai') {
			return `https://api.kie.ai/gemini-3-5-flash-openai/v1/chat/completions`;
		}

		// 3. Claude Models
		if (model.startsWith('claude-') || model === 'cluade-fable-5') {
			return 'https://api.kie.ai/claude/v1/messages';
		}

		// 4. GPT chat-completions
		if (model === 'gpt-5-2') {
			return 'https://api.kie.ai/gpt-5-2/v1/chat/completions';
		}

		// 5. Codex style models
		if (model === 'gpt-5-5' || model === 'gpt-5-4') {
			return 'https://api.kie.ai/codex/v1/responses';
		}
		if (model.endsWith('-codex')) {
			return 'https://api.kie.ai/api/v1/responses';
		}

		// Fallback to legacy default
		return 'https://api.kie.ai/api/v1/responses';
	}

	/** Builds the request body for the KIE API. */
	public static async buildPayload(history: ChatMessage[], model: string): Promise<any> {
		const modelDetails = ALL_CHAT_MODELS.find(m => m.id === model) || { id: model, family: 'codex' as const };

		// ── 1. Gemini Native ──────────────────────────────────────────────
		if (modelDetails.family === 'gemini-native') {
			return {
				contents: await this._buildGeminiContents(history),
				stream: false
			};
		}

		// ── 2. Claude ─────────────────────────────────────────────────────
		if (modelDetails.family === 'claude') {
			const { messages, system } = this._buildOpenAiLikeMessages(history, true);
			return {
				model: model === 'gemini-3-flash-v1beta' ? 'gemini-3-flash-v1beta' : model,
				messages,
				stream: false,
				max_tokens: 4096
			};
		}

		// ── 3. OpenAI Chat Completions (GPT & Gemini OpenAI-compatible) ──
		if (modelDetails.family === 'gemini-openai' || modelDetails.family === 'gpt-openai') {
			// Extract correct model ID for request body (if needed)
			let actualModelId = model;
			if (model.endsWith('-openai')) {
				actualModelId = model.replace('-openai', '').replace('3.5', '3.5');
			}
			const { messages } = this._buildOpenAiLikeMessages(history, false);
			return {
				model: actualModelId,
				messages,
				stream: false
			};
		}

		// ── 4. Codex/Responses ────────────────────────────────────────────
		// Standard multi-turn/condensed Codex payload
		let input: any[];
		if (model === 'gpt-5-5' || model === 'gpt-5-4') {
			const systemPrompt = history.find(m => m.role === 'system')?.content || '';
			const conversationTurns: string[] = [];

			for (const msg of history) {
				if (msg.role === 'system') continue;
				const roleLabel = msg.role === 'user' ? 'User' : 'Assistant (Zelos)';
				if (typeof msg.content === 'string') {
					conversationTurns.push(`${roleLabel}: ${msg.content}`);
				} else {
					let textParts = '';
					let imageUrls: string[] = [];
					for (const part of msg.content) {
						if (part.type === 'input_text' && part.text) {
							textParts += part.text;
						} else if (part.type === 'input_image' && part.image_url) {
							imageUrls.push(part.image_url);
						}
					}
					let turnStr = `${roleLabel}: ${textParts}`;
					if (imageUrls.length > 0) {
						turnStr += ` [Attached Images: ${imageUrls.join(', ')}]`;
					}
					conversationTurns.push(turnStr);
				}
			}

			const condensedPrompt = [
				systemPrompt,
				'',
				'## Conversation History',
				...conversationTurns,
				'',
				'## Instruction',
				'Continue the task by executing the next step (using tool tags) or reply with a short summary if complete.'
			].join('\n');

			const contentParts: any[] = [{ type: 'input_text', text: condensedPrompt }];
			for (const msg of history) {
				if (msg.role === 'user' && Array.isArray(msg.content)) {
					for (const part of msg.content) {
						if (part.type === 'input_image' && part.image_url) {
							contentParts.push({ type: 'input_image', image_url: part.image_url });
						}
					}
				}
			}

			input = [
				{
					role: 'user',
					content: contentParts
				}
			];
		} else {
			// Standard Codex format for other codex models
			input = history.map(msg => {
				if (typeof msg.content === 'string') {
					return {
						role: msg.role,
						content: [{ type: 'input_text', text: msg.content }],
					};
				} else {
					return {
						role: msg.role,
						content: msg.content
					};
				}
			});
		}

		return {
			model,
			stream: false,
			input
		};
	}

	/** Extracts the generated text from KIE API response. */
	public static extractReply(data: any): string {
		if (!data) return '';

		// 1. Gemini Native format
		if (data.candidates?.[0]?.content?.parts?.[0]) {
			const textPart = data.candidates[0].content.parts.find((p: any) => p.text !== undefined);
			if (textPart) return textPart.text;
		}

		// 2. Claude format (e.g. content: [{ type: 'text', text: '...' }])
		if (data.content && Array.isArray(data.content)) {
			const textPart = data.content.find((c: any) => c.type === 'text');
			if (textPart && textPart.text !== undefined) return textPart.text;
			
			const textDirect = data.content.find((c: any) => c.text !== undefined);
			if (textDirect && textDirect.text !== undefined) return textDirect.text;
		}

		// 3. KIE Codex format
		if (data.output && Array.isArray(data.output)) {
			const msg = data.output.find((o: any) => o.role === 'assistant');
			if (msg?.content && Array.isArray(msg.content)) {
				const text = msg.content.find((c: any) => c.type === 'output_text');
				if (text) return text.text;
			}
		}

		// 4. OpenAI standard format
		if (data.choices?.[0]?.message?.content !== undefined) {
			return data.choices[0].message.content;
		}

		// 5. Raw string response or stringified fallback
		if (typeof data === 'string') {
			return data;
		}

		return JSON.stringify(data);
	}

	// ── Private Helpers ──────────────────────────────────────────────────

	/** Builds Gemini-native content structure. */
	private static async _buildGeminiContents(history: ChatMessage[]): Promise<any[]> {
		const geminiContents: any[] = [];
		let systemPrompt = '';

		for (const msg of history) {
			if (msg.role === 'system') {
				if (typeof msg.content === 'string') {
					systemPrompt += msg.content + '\n\n';
				} else {
					for (const part of msg.content) {
						if (part.type === 'input_text' && part.text) {
							systemPrompt += part.text + '\n\n';
						}
					}
				}
				continue;
			}

			const role = msg.role === 'assistant' ? 'model' : 'user';
			const parts: any[] = [];

			if (typeof msg.content === 'string') {
				let text = msg.content;
				if (systemPrompt && role === 'user' && geminiContents.length === 0) {
					text = systemPrompt + text;
					systemPrompt = '';
				}
				parts.push({ text });
			} else {
				for (const part of msg.content) {
					if (part.type === 'input_text' && part.text) {
						let text = part.text;
						if (systemPrompt && role === 'user' && geminiContents.length === 0) {
							text = systemPrompt + text;
							systemPrompt = '';
						}
						parts.push({ text });
					} else if (part.type === 'input_image' && part.image_url) {
						if (part.image_url.startsWith('data:')) {
							const mimeTypeMatch = part.image_url.match(/data:(.*?);base64,/);
							const base64Data = part.image_url.split(';base64,')[1];
							if (base64Data) {
								parts.push({
									inline_data: {
										mime_type: mimeTypeMatch ? mimeTypeMatch[1] : 'image/png',
										data: base64Data
									}
								});
							}
						} else if (part.image_url.startsWith('http')) {
							try {
								const imgRes = await fetch(part.image_url);
								if (imgRes.ok) {
									const arrayBuffer = await imgRes.arrayBuffer();
									const base64Data = Buffer.from(arrayBuffer).toString('base64');
									const mimeType = imgRes.headers.get('content-type') || 'image/png';
									parts.push({
										inline_data: {
											mime_type: mimeType,
											data: base64Data
										}
									});
								}
							} catch (err) {
								console.error('Failed to download image for Gemini Native input:', err);
							}
						}
					}
				}
			}

			if (parts.length > 0) {
				geminiContents.push({ role, parts });
			}
		}

		return geminiContents;
	}

	/** Builds standard OpenAI/Claude message format. Prepend system message to first user msg if systemNotAllowed in array. */
	private static _buildOpenAiLikeMessages(history: ChatMessage[], systemNotAllowed: boolean): { messages: any[], system?: string } {
		const messages: any[] = [];
		let systemPrompt = '';

		for (const msg of history) {
			if (msg.role === 'system') {
				if (typeof msg.content === 'string') {
					systemPrompt += msg.content + '\n\n';
				} else {
					for (const part of msg.content) {
						if (part.type === 'input_text' && part.text) {
							systemPrompt += part.text + '\n\n';
						}
					}
				}
				continue;
			}

			// Format content
			let content: any;
			if (typeof msg.content === 'string') {
				content = msg.content;
			} else {
				content = msg.content.map(part => {
					if (part.type === 'input_image' || part.type === 'image_url') {
						return {
							type: 'image_url',
							image_url: { url: part.image_url }
						};
					} else {
						return {
							type: 'text',
							text: part.text || ''
						};
					}
				});
			}

			messages.push({
				role: msg.role,
				content
			});
		}

		// Inject system prompt into first user message if systemNotAllowed (e.g. Claude)
		if (systemPrompt) {
			if (systemNotAllowed) {
				const firstUserIdx = messages.findIndex(m => m.role === 'user');
				if (firstUserIdx !== -1) {
					const firstUser = messages[firstUserIdx];
					if (typeof firstUser.content === 'string') {
						firstUser.content = systemPrompt + firstUser.content;
					} else if (Array.isArray(firstUser.content)) {
						const textPart = firstUser.content.find((p: any) => p.type === 'text');
						if (textPart) {
							textPart.text = systemPrompt + textPart.text;
						} else {
							firstUser.content.unshift({ type: 'text', text: systemPrompt });
						}
					}
				}
			} else {
				// Standard system role insertion at front
				messages.unshift({
					role: 'system',
					content: systemPrompt.trim()
				});
			}
		}

		return { messages, system: systemPrompt.trim() || undefined };
	}
}
