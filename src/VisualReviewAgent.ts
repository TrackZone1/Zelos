import { CDPClient } from './CDPClient';

interface VisualMessage {
	role: 'system' | 'user' | 'assistant';
	content: string | { type: string; text?: string; image_url?: string }[];
}

export class VisualReviewAgent {
	private _history: VisualMessage[] = [];
	private _cdpClient: CDPClient;
	private _model: string;
	private _apiUrl: string;
	private _apiKey: string;
	private _emitStatus: (status: string) => void;

	constructor(options: {
		cdpClient: CDPClient;
		model: string;
		apiUrl: string;
		apiKey: string;
		emitStatus: (status: string) => void;
	}) {
		this._cdpClient = options.cdpClient;
		this._model = options.model;
		this._apiUrl = options.apiUrl;
		this._apiKey = options.apiKey;
		this._emitStatus = options.emitStatus;
	}

	public async run(initialUrl: string, instruction: string): Promise<string> {
		this._emitStatus('Initializing visual review session...');
		
		// 1. Initialize system prompt
		const systemPrompt = [
			'You are a visual review and browser navigation subagent collaborating with a coding agent.',
			'Your goal is to inspect web pages, click around, perform inputs, scroll, and verify the UI looks and behaves correctly.',
			'You MUST interact with the page step-by-step using these XML tool tags:',
			'',
			'  - Click an element:',
			'    <click selector="css_selector"></click>',
			'  - Type text into a field:',
			'    <type selector="css_selector" text="text_to_type"></type>',
			'  - Navigate to a new URL:',
			'    <navigate url="url"></navigate>',
			'  - Scroll page up or down:',
			'    <scroll direction="up|down"></scroll>',
			'  - Wait for animations/load:',
			'    <wait ms="1000"></wait>',
			'',
			'Rules:',
			'- Perform one or two actions at a time. After executing your actions, you will receive a new screenshot of the page.',
			'- Carefully check the screenshot for visual bugs (alignment issues, cut-off text, bad styling, overlaps, layout failures).',
			'- When you have completed the review or found critical layout bugs, do NOT output any tool tags. Instead, write a detailed visual review report in markdown describing what you observed, what works, what fails, and recommendations for fixing the CSS/code.',
			'- Keep explanations between actions extremely brief (1 sentence).'
		].join('\n');

		this._history = [{ role: 'system', content: systemPrompt }];

		// Navigate to the starting URL first
		this._emitStatus(`Navigating to starting URL: ${initialUrl}`);
		try {
			await this._cdpClient.navigate(initialUrl);
		} catch (err: any) {
			return `Failed to navigate to starting URL ${initialUrl}: ${err.message}`;
		}

		let currentUrl = initialUrl;
		const maxSteps = 6;

		for (let step = 1; step <= maxSteps; step++) {
			this._emitStatus(`Visual Review (step ${step}/${maxSteps}): Capturing page state...`);

			let screenshotBase64 = '';
			try {
				screenshotBase64 = await this._cdpClient.captureScreenshot();
			} catch (err: any) {
				return `Failed to capture screenshot at step ${step}: ${err.message}`;
			}

			// Extract interactive elements to guide the model
			let interactiveElementsText = '';
			try {
				const elements = await this._cdpClient.evaluate(`
					(() => {
						const els = Array.from(document.querySelectorAll('a, button, input, select, textarea, [role="button"], [onclick]'));
						return els.map(el => {
							const rect = el.getBoundingClientRect();
							let text = el.innerText || el.placeholder || el.value || el.title || '';
							text = text.trim().substring(0, 40);
							const selector = el.id ? '#' + el.id : 
							                 el.tagName.toLowerCase() + (el.className ? '.' + el.className.split(' ').filter(Boolean).slice(0, 2).join('.') : '');
							return {
								tag: el.tagName.toLowerCase(),
								selector,
								text,
								visible: rect.width > 0 && rect.height > 0
							};
						}).filter(e => e.visible).slice(0, 30);
					})()
				`);
				if (Array.isArray(elements)) {
					interactiveElementsText = elements
						.map(e => `- [${e.tag}] \`${e.selector}\` text="${e.text}"`)
						.join('\n');
				}
			} catch (err) {
				console.error('Failed to inspect interactive elements:', err);
			}

			// Get current URL and title
			let pageTitle = '';
			try {
				const titleRes = await this._cdpClient.evaluate('document.title');
				pageTitle = titleRes?.value || '';
				const urlRes = await this._cdpClient.evaluate('window.location.href');
				currentUrl = urlRes?.value || currentUrl;
			} catch (_) {}

			// Construct prompt content
			const promptText = [
				`Step ${step} of ${maxSteps}`,
				`Current URL: ${currentUrl}`,
				`Page Title: ${pageTitle}`,
				`Instruction: ${instruction}`,
				'',
				'### Interactive Elements Found:',
				interactiveElementsText || '(none found)',
				'',
				'Please look at the attached screenshot and choose your next action. If done, provide your final review report.'
			].join('\n');

			this._emitStatus(`Visual Review (step ${step}/${maxSteps}): Uploading page screenshot to KIE...`);
			let screenshotUrl = `data:image/png;base64,${screenshotBase64}`;
			try {
				const uploadRes = await fetch('https://api.kie.ai/api/file-base64-upload', {
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						'Authorization': `Bearer ${this._apiKey}`,
					},
					body: JSON.stringify({
						base64Data: screenshotBase64,
						uploadPath: 'images/visual-review',
						fileName: `screenshot-${Date.now()}-${step}.png`
					})
				});
				if (uploadRes.ok) {
					const uploadData = await uploadRes.json() as any;
					if (uploadData.success && uploadData.data?.downloadUrl) {
						screenshotUrl = uploadData.data.downloadUrl;
						this._emitStatus(`Visual Review (step ${step}/${maxSteps}): Screenshot uploaded to KIE.`);
					} else {
						console.error('KIE image upload failed:', uploadData.msg);
					}
				}
			} catch (err: any) {
				console.error('Failed to upload screenshot to KIE:', err);
			}

			// Push user message with vision payload
			this._history.push({
				role: 'user',
				content: [
					{ type: 'input_text', text: promptText },
					{ type: 'input_image', image_url: screenshotUrl }
				]
			});

			this._emitStatus(`Visual Review (step ${step}/${maxSteps}): Querying model ${this._model}...`);

			let responseText = '';
			try {
				responseText = await this._queryVisualModel();
			} catch (err: any) {
				return `Visual review API error: ${err.message}`;
			}

			this._history.push({ role: 'assistant', content: responseText });

			// Parse actions from model reply
			const actions = this._parseActions(responseText);
			if (actions.length === 0) {
				// No actions -> final report
				this._emitStatus('Visual review completed successfully.');
				return responseText;
			}

			// Execute actions
			for (const action of actions) {
				this._emitStatus(`Visual Review: Executing ${action.type} action...`);
				try {
					if (action.type === 'click' && action.selector) {
						await this._cdpClient.click(action.selector);
					} else if (action.type === 'type' && action.selector && action.text !== undefined) {
						await this._cdpClient.type(action.selector, action.text);
					} else if (action.type === 'navigate' && action.url) {
						await this._cdpClient.navigate(action.url);
					} else if (action.type === 'scroll' && action.direction) {
						await this._cdpClient.scroll(action.direction);
					} else if (action.type === 'wait' && action.ms) {
						await new Promise(resolve => setTimeout(resolve, action.ms));
					}
				} catch (err: any) {
					this._history.push({
						role: 'user',
						content: `[ACTION ERROR]: Failed to execute ${action.type}: ${err.message}`
					});
				}
			}
		}

		this._emitStatus('Visual review exceeded maximum steps.');
		return 'Visual review hit the step limit. Here is the last state of the conversation:\n\n' + 
			(this._history[this._history.length - 1]?.content || '');
	}

	private async _queryVisualModel(): Promise<string> {
		const isCustomUrl = !this._apiUrl.includes('api.kie.ai') && !this._apiUrl.includes('kie.ai');
		let fetchUrl = this._apiUrl;
		if (this._model === 'gemini-3.5-flash') {
			const cleanUrl = this._apiUrl.replace(/\/+$/, '');
			if (cleanUrl.includes('api.kie.ai') || cleanUrl.includes('kie.ai')) {
				fetchUrl = 'https://api.kie.ai/gemini/v1/models/gemini-3-5-flash:streamGenerateContent';
			} else {
				fetchUrl = cleanUrl + '/gemini/v1/models/gemini-3-5-flash:streamGenerateContent';
			}
		} else if (!isCustomUrl) {
			fetchUrl = 'https://api.kie.ai/api/v1/responses';
		}

		const kieInput = this._history.map(msg => {
			if (typeof msg.content === 'string') {
				return {
					role: msg.role,
					content: [{ type: 'input_text', text: msg.content }]
				};
			} else {
				return {
					role: msg.role,
					content: msg.content
				};
			}
		});

		let delay = 1000;
		for (let attempt = 0; attempt < 3; attempt++) {
			try {
				let body: any;
				if (this._model === 'gemini-3.5-flash') {
					body = {
						contents: await this._buildGeminiContents(this._history),
						stream: false
					};
				} else {
					body = { model: this._model, stream: false, input: kieInput };
				}

				const response = await fetch(fetchUrl, {
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						'Authorization': `Bearer ${this._apiKey}`,
					},
					body: JSON.stringify(body),
				});

				if (response.ok) {
					const text = await response.text();
					try {
						const responseData = JSON.parse(text);
						if (responseData && (responseData.code === 500 || responseData.code === '500')) {
							throw new Error(responseData.msg || text);
						}
						// Extract response
						if (responseData.candidates?.[0]?.content?.parts?.[0]) {
							const textPart = responseData.candidates[0].content.parts.find((p: any) => p.text !== undefined);
							if (textPart) return textPart.text;
						}
						if (responseData.output && Array.isArray(responseData.output)) {
							const msg = responseData.output.find((o: any) => o.role === 'assistant');
							if (msg?.content && Array.isArray(msg.content)) {
								const textBlock = msg.content.find((c: any) => c.type === 'output_text');
								if (textBlock) return textBlock.text;
							}
						}
						if (responseData.choices?.[0]?.message?.content) {
							return responseData.choices[0].message.content;
						}
						return text;
					} catch (_) {
						return text;
					}
				} else {
					const errText = await response.text();
					throw new Error(`KIE Vision API returned status ${response.status}: ${errText}`);
				}
			} catch (err) {
				if (attempt === 2) throw err;
				await new Promise(resolve => setTimeout(resolve, delay));
				delay *= 2;
			}
		}
		throw new Error('API query failed.');
	}

	private async _buildGeminiContents(history: VisualMessage[]): Promise<any[]> {
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
								console.error('Failed to download image for Gemini input:', err);
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

	private _parseActions(text: string): { type: string; selector?: string; text?: string; url?: string; direction?: 'up' | 'down'; ms?: number }[] {
		const actions: any[] = [];
		const regex = /<(\w+)([^>]*?)>([\s\S]*?)<\/\1>|<(\w+)([^>]*?)\/>/g;
		let match;

		while ((match = regex.exec(text)) !== null) {
			const type = match[1] || match[4];
			const rawAttrs = match[2] || match[5] || '';
			
			// Parse attributes
			const attrs: any = {};
			const attrRegex = /(\w+)\s*=\s*(['"])([\s\S]*?)\2/g;
			let attrMatch;
			while ((attrMatch = attrRegex.exec(rawAttrs)) !== null) {
				attrs[attrMatch[1]] = attrMatch[3];
			}

			if (type === 'click') {
				actions.push({ type: 'click', selector: attrs.selector });
			} else if (type === 'type') {
				actions.push({ type: 'type', selector: attrs.selector, text: attrs.text });
			} else if (type === 'navigate') {
				actions.push({ type: 'navigate', url: attrs.url });
			} else if (type === 'scroll') {
				actions.push({ type: 'scroll', direction: attrs.direction });
			} else if (type === 'wait') {
				actions.push({ type: 'wait', ms: parseInt(attrs.ms, 10) || 1000 });
			}
		}
		return actions;
	}
}
