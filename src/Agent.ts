import * as vscode from 'vscode';
import { ToolExecutor } from './ToolExecutor';

// ── Types ────────────────────────────────────────────────────────────

interface ChatMessage {
	role: 'system' | 'user' | 'assistant';
	content: string;
}

export interface AgentEvent {
	type: 'status' | 'response' | 'tool_action' | 'error' | 'lock' | 'unlock';
	message: string;
}

// ── Constants ────────────────────────────────────────────────────────

const MAX_LOOP_ITERATIONS = 10;
const MAX_HISTORY_MESSAGES = 40;
const MAX_CODE_LEAK_RETRIES = 2;
const MAX_API_RETRIES = 3;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const SYSTEM_PROMPT_BODY = [
	'## CRITICAL: Tool Usage',
	'You MUST ALWAYS use the XML tool tags below to perform actions.',
	'NEVER output raw code, HTML, CSS, JavaScript, or any file content directly in your text response.',
	'Even if the user asks you to "give me the code" or "output the file contents", you MUST write it to a file using <create_file>.',
	'Your text responses should ONLY contain short summaries of what you did. No code. No file contents.',
	'',
	'## Tools',
	'### 1. Create or overwrite a file',
	'<create_file path="relative/path/file.ext">',
	'file content here',
	'</create_file>',
	'',
	'### 2. Run a terminal command',
	'<run_command cmd="npm test"></run_command>',
	'',
	'### 3. Read an existing file',
	'<read_file path="relative/path/file.ext"></read_file>',
	'',
	'### 4. List directory contents',
	'<list_files path="."></list_files>',
	'',
	'## Example of CORRECT behavior',
	'User: "Create an index.html with a hello world page"',
	'Your response:',
	'<create_file path="index.html">',
	'<!DOCTYPE html>',
	'<html><head><title>Hello</title></head>',
	'<body><h1>Hello World</h1></body>',
	'</html>',
	'</create_file>',
	'',
	'## Example of WRONG behavior (NEVER DO THIS)',
	'User: "Create an index.html"',
	'Wrong response: "Here is the code: ```html <!DOCTYPE html>..."',
	'This is WRONG because you wrote code as text instead of using <create_file>.',
	'The user CANNOT use code that is only displayed as text. It MUST be written to a file.',
	'',
	'## Rules',
	'- You can use multiple tools in a single response.',
	'- After each tool execution the system returns the result and you are called again.',
	'- Continue acting until the task is fully complete. When done, reply with a SHORT plain text summary (no tool tags, no code).',
	'- If a command fails, analyse the error and fix it yourself.',
	'- Always read a file before modifying it, unless you just created it.',
	'- Keep explanations very short (2-3 sentences max).',
	'- NEVER include code blocks (``` ```) in your text responses.',
].join('\n');

// Patterns that indicate the model leaked raw code instead of using tools
const CODE_LEAK_PATTERNS = [
	/<!DOCTYPE\s+html/i,
	/<html[\s>]/i,
	/<head[\s>]/i,
	/<style[\s>][\s\S]{100,}/i,
	/<script[\s>][\s\S]{100,}/i,
	/```[\w]*\n[\s\S]{200,}```/,
];

// ── Agent ────────────────────────────────────────────────────────────

export class Agent {
	private _history: ChatMessage[] = [];
	private _toolExecutor: ToolExecutor;
	private _emit: (event: AgentEvent) => void;
	private _requestCommandApproval: (command: string) => Promise<boolean>;
	private _requestFileApproval: (path: string, content: string) => Promise<boolean>;
	private _busy = false;

	constructor(
		emit: (event: AgentEvent) => void,
		requestCommandApproval: (command: string) => Promise<boolean>,
		requestFileApproval: (path: string, content: string) => Promise<boolean>
	) {
		this._emit = emit;
		this._requestCommandApproval = requestCommandApproval;
		this._requestFileApproval = requestFileApproval;
		this._toolExecutor = new ToolExecutor();
		this._resetHistory();
	}

	/** Clears conversation history and re-injects the system prompt. */
	public resetConversation() {
		this._resetHistory();
		this._emit({ type: 'status', message: '*(Conversation reset)*' });
	}

	public async handleUserMessage(message: string) {
		if (this._busy) {
			this._emit({ type: 'error', message: 'Zelos is still working on the previous request. Please wait.' });
			return;
		}

		this._busy = true;
		this._emit({ type: 'lock', message: '' });

		try {
			// Build the user message with optional editor context
			const userContent = this._buildUserContent(message);
			this._history.push({ role: 'user', content: userContent });

			await this._runAgentLoop();
		} finally {
			this._busy = false;
			this._emit({ type: 'unlock', message: '' });
		}
	}

	/** Triggers an autonomous workspace audit (review and test) loop. */
	public async runAudit(options: {
		checkArchitecture: boolean;
		codeReview: boolean;
		runTests: boolean;
		testCommand: string;
		selfCorrect: boolean;
		checkCognitiveComplexity?: boolean;
		cognitiveComplexityThreshold?: number;
	}) {
		if (this._busy) {
			this._emit({ type: 'error', message: 'Zelos is still working on a previous request. Please wait.' });
			return;
		}

		this._busy = true;
		this._emit({ type: 'lock', message: '' });

		try {
			// Clear chat history for a clean audit context
			this._resetHistory();

			let auditInstructions = [
				'## WORKSPACE AUDIT REQUEST',
				'You have been requested to audit this workspace. Please execute the following tasks:',
			];

			if (options.checkArchitecture) {
				auditInstructions.push(
					'- **Architecture Check**: List the files and directories in the workspace. Verify if the project follows clean architecture principles, has an appropriate layout, and implements proper separation of concerns.'
				);
			}

			if (options.codeReview) {
				auditInstructions.push(
					'- **Code Review**: Examine the source code in the key workspace files. Look for bugs, safety vulnerabilities, bad coding practices, and lack of comments or documentation.'
				);
			}

			if (options.checkCognitiveComplexity) {
				const threshold = options.cognitiveComplexityThreshold || 15;
				auditInstructions.push(
					`- **Cognitive Complexity Analysis**: Analyze the cognitive complexity of functions and methods in key source files. Identify any function with a cognitive complexity score exceeding the threshold of ${threshold}. For any such complex functions, provide a detailed breakdown of the score calculation (accounting for nesting, logical operators, and structural control flow) and suggest/implement refactoring strategies (e.g. extracting helper functions, simplifying logic) to reduce the complexity below the threshold.`
				);
			}

			if (options.runTests) {
				const cmd = options.testCommand || 'npm test';
				auditInstructions.push(
					`- **Test Suite Run**: Execute the test suite using: \`<run_command cmd="${cmd}"></run_command>\`. Parse the stdout/stderr output to determine if tests pass or fail.`
				);
			}

			if (options.selfCorrect) {
				auditInstructions.push(
					'- **Auto-Critique & Correction**: Write a dedicated section named "CRITIQUE" listing all flaws, test failures, or design weaknesses you found. Then, autonomously correct them by modifying the files using \`<create_file>\` (and re-running the test suite to verify the fixes).'
				);
			} else {
				auditInstructions.push(
					'- **Critique Only**: Highlight any issues or recommendations, but do NOT write to or modify any files.'
				);
			}

			auditInstructions.push(
				'',
				'Please start the audit by running `<list_files path="."></list_files>` to locate the files in the workspace, and proceed step-by-step.'
			);

			this._history.push({ role: 'user', content: auditInstructions.join('\n') });
			await this._runAgentLoop();
		} finally {
			this._busy = false;
			this._emit({ type: 'unlock', message: '' });
		}
	}

	// ── Private ──────────────────────────────────────────────────────

	private _getSystemPrompt(): string {
		const platform = process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'macOS' : 'Linux';
		const shell = process.platform === 'win32' ? 'PowerShell or cmd.exe' : 'bash/sh';
		return [
			'You are Zelos, an autonomous AI coding agent embedded in VS Code.',
			`Current environment: Running on ${platform} (Shell: ${shell}). Please ensure any shell commands run via <run_command> or functions.shell are fully compatible with this operating system.`,
			'',
			SYSTEM_PROMPT_BODY
		].join('\n');
	}

	private _resetHistory() {
		this._history = [{ role: 'system', content: this._getSystemPrompt() }];
	}

	/**
	 * Builds the user message content.
	 * Only injects the active editor content on the FIRST user message
	 * of the conversation (to avoid duplicating it on every turn).
	 * Also appends a tool-usage reminder.
	 */
	private _buildUserContent(message: string): string {
		let content = message;

		// Only add context if this is the first user message in history
		const userMessageCount = this._history.filter(m => m.role === 'user').length;
		if (userMessageCount === 0) {
			const editor = vscode.window.activeTextEditor;
			if (editor) {
				const relPath = vscode.workspace.asRelativePath(editor.document.fileName);
				const text = editor.document.getText();
				// Truncate very large files
				const truncated = text.length > 6000 ? text.substring(0, 6000) + '\n...[file truncated]' : text;
				content = `${message}\n\n[Active file: ${relPath}]\n${truncated}`;
			}
		}

		// Append a tool-usage reminder to reinforce system prompt
		content += '\n\n[IMPORTANT: Write ALL code to files using <create_file path="...">. Do NOT output code as text in your response.]';
		return content;
	}

	/** Core agent loop: call API → parse tools → feed results → repeat. */
	private async _runAgentLoop() {
		const config = vscode.workspace.getConfiguration('zelos');
		const apiUrl = config.get<string>('api.url') || 'https://api.kie.ai';
		const model = config.get<string>('api.model') || 'gpt-5-5';
		const apiKey = config.get<string>('api.key') || '';

		if (!apiKey) {
			this._emit({ type: 'error', message: 'API Key not configured. Go to Settings ⚙️ to add your KIE API key.' });
			return;
		}

		const commandApprovalMode = config.get<string>('commandApprovalMode') || 'prompt';
		const fileApprovalMode = config.get<string>('fileApprovalMode') || 'prompt';

		let reqCmdApproval: ((cmd: string) => Promise<boolean>) | undefined;
		if (commandApprovalMode === 'prompt') {
			reqCmdApproval = this._requestCommandApproval;
		} else if (commandApprovalMode === 'rejectAll') {
			reqCmdApproval = async () => false;
		}

		let reqFileApproval: ((path: string, content: string) => Promise<boolean>) | undefined;
		if (fileApprovalMode === 'prompt') {
			reqFileApproval = this._requestFileApproval;
		} else if (fileApprovalMode === 'rejectAll') {
			reqFileApproval = async () => false;
		}

		const fetchUrl = this._resolveApiUrl(apiUrl, model);
		let codeLeakRetries = 0;

		for (let step = 1; step <= MAX_LOOP_ITERATIONS; step++) {
			this._emit({ type: 'status', message: `Thinking... (step ${step}/${MAX_LOOP_ITERATIONS})` });

			// Truncate history if it grew too large
			this._trimHistory();

			const kieInput = this._buildKieInput(this._history, model);

			let response: Response | undefined;
			let apiError: any = null;
			let responseData: any = null;
			let delay = 1000;

			for (let attempt = 0; attempt <= MAX_API_RETRIES; attempt++) {
				try {
					response = await fetch(fetchUrl, {
						method: 'POST',
						headers: {
							'Content-Type': 'application/json',
							'Authorization': `Bearer ${apiKey}`,
						},
						body: JSON.stringify({ model, stream: false, input: kieInput }),
					});

					if (response.ok) {
						const text = await response.text();
						let hasError = false;
						try {
							responseData = JSON.parse(text);
							if (responseData && (responseData.code === 500 || responseData.code === '500' || (responseData.msg && responseData.msg.toLowerCase().includes('server exception')))) {
								hasError = true;
								apiError = new Error(responseData.msg || text);
							}
						} catch (_) {
							responseData = text;
						}

						if (!hasError) {
							apiError = null;
							break;
						}
					} else {
						const errText = await response.text();
						apiError = new Error(`API Error: ${errText || response.statusText}`);
					}

					if (attempt < MAX_API_RETRIES) {
						this._emit({ type: 'status', message: `API returned server exception. Retrying in ${delay}ms... (attempt ${attempt + 1}/${MAX_API_RETRIES})` });
						await sleep(delay);
						delay *= 2;
						continue;
					} else {
						break;
					}
				} catch (err: any) {
					apiError = err;
					if (attempt < MAX_API_RETRIES) {
						this._emit({ type: 'status', message: `API connection failed. Retrying in ${delay}ms... (attempt ${attempt + 1}/${MAX_API_RETRIES})` });
						await sleep(delay);
						delay *= 2;
						continue;
					} else {
						break;
					}
				}
			}

			if (apiError || !response) {
				this._emit({ type: 'error', message: apiError?.message || 'Failed to contact KIE API.' });
				break;
			}

			try {
				let reply: string;
				if (typeof responseData === 'string') {
					reply = responseData;
				} else {
					reply = this._extractReply(responseData);
				}
				this._history.push({ role: 'assistant', content: reply });

				// ── Code-leak detection ──
				// If the model dumped raw code instead of using tools, correct it
				const hasToolTags = /<(create_file|run_command|read_file|list_files)[\s>]/.test(reply);
				if (!hasToolTags && this._detectCodeLeak(reply) && codeLeakRetries < MAX_CODE_LEAK_RETRIES) {
					codeLeakRetries++;
					this._emit({ type: 'status', message: `Correcting agent behavior... (retry ${codeLeakRetries})` });

					// Push a correction message
					this._history.push({
						role: 'user',
						content: [
							'[SYSTEM CORRECTION]',
							'You just wrote raw code/HTML directly in your response text.',
							'This is WRONG. The code was NOT saved to any file.',
							'You MUST use the <create_file path="filename.ext"> tool to write code to a file.',
							'Please retry: use <create_file> to write the code to the appropriate file.',
							'Do NOT repeat the code as text. Use the tool.',
						].join('\n'),
					});
					// Continue the loop — model will retry
					continue;
				}

				// Execute any tools found in the reply
				const { uiMessage, toolResults } = await this._toolExecutor.executeActions(reply, reqCmdApproval, reqFileApproval);

				if (toolResults.length > 0) {
					// Show tool actions in UI
					this._emit({ type: 'tool_action', message: uiMessage });

					// Feed results back to the model as a USER message (not system)
					const feedback = this._formatToolFeedback(toolResults);
					this._history.push({ role: 'user', content: feedback });
					// Continue loop — the model needs to see the results
				} else {
					// No tools → final answer
					// Truncate if suspiciously long (model might still be leaking code)
					const finalMessage = this._sanitizeFinalResponse(uiMessage);
					this._emit({ type: 'response', message: finalMessage });
					break;
				}
			} catch (err: any) {
				this._emit({ type: 'error', message: `Error: ${err.message}` });
				break;
			}
		}
	}

	/** Detects if the model's response contains raw code instead of tool tags. */
	private _detectCodeLeak(reply: string): boolean {
		// Check if the reply matches known code-leak patterns
		for (const pattern of CODE_LEAK_PATTERNS) {
			if (pattern.test(reply)) {
				return true;
			}
		}

		// Also check if the response is very long and has many lines (likely a code dump)
		const lineCount = reply.split('\n').length;
		if (lineCount > 30 && reply.length > 1000) {
			// Check if it looks code-ish (has lots of special chars typical of code)
			const codeChars = (reply.match(/[{}<>;=()[\]]/g) || []).length;
			const codeRatio = codeChars / reply.length;
			if (codeRatio > 0.03) {
				return true;
			}
		}

		return false;
	}

	/**
	 * Sanitizes the final text response before showing it to the user.
	 * If the model leaked code despite all guardrails, truncate it
	 * so the chatbox doesn't get flooded.
	 */
	private _sanitizeFinalResponse(message: string): string {
		// If the message is very long and contains code patterns, truncate
		if (message.length > 2000 && this._detectCodeLeak(message)) {
			// Extract just the first few meaningful lines
			const lines = message.split('\n');
			const summaryLines: string[] = [];
			let codeBlockDepth = 0;

			for (const line of lines) {
				if (line.includes('```')) {
					codeBlockDepth = codeBlockDepth === 0 ? 1 : 0;
					continue;
				}
				if (codeBlockDepth === 0 && line.trim().length > 0) {
					summaryLines.push(line);
				}
				if (summaryLines.length >= 5) break;
			}

			const summary = summaryLines.join('\n') || 'Task completed.';
			return summary + '\n\n*(Note: Code was written to files, not displayed here.)*';
		}

		return message;
	}

	/** Determines the correct KIE API endpoint based on the model name. */
	private _resolveApiUrl(baseUrl: string, model: string): string {
		if (!baseUrl.includes('api.kie.ai') && !baseUrl.includes('kie.ai')) {
			return baseUrl;
		}
		if (model === 'gpt-5-5') {
			return 'https://api.kie.ai/codex/v1/responses';
		}
		return 'https://api.kie.ai/api/v1/responses';
	}

	/** Extracts the text reply from the KIE Codex API response format. */
	private _extractReply(data: any): string {
		// KIE Codex format
		if (data.output && Array.isArray(data.output)) {
			const msg = data.output.find((o: any) => o.role === 'assistant');
			if (msg?.content && Array.isArray(msg.content)) {
				const text = msg.content.find((c: any) => c.type === 'output_text');
				if (text) return text.text;
			}
		}
		// OpenAI fallback
		if (data.choices?.[0]?.message?.content) {
			return data.choices[0].message.content;
		}
		return JSON.stringify(data);
	}

	/** Formats tool results into a string the model can understand. */
	private _formatToolFeedback(results: { action: string; status: string; details: string }[]): string {
		const lines = ['[TOOL RESULTS]'];
		for (const r of results) {
			lines.push(`Action: ${r.action}`);
			lines.push(`Status: ${r.status}`);
			lines.push(`Output:\n${r.details}`);
			lines.push('---');
		}
		lines.push('Continue with the next step, or reply with your final SHORT text summary if done.');
		lines.push('[REMINDER: Do NOT output code as text. Use <create_file> for any code.]');
		return lines.join('\n');
	}

	/** Keeps history within MAX_HISTORY_MESSAGES (system prompt is always kept). */
	private _trimHistory() {
		if (this._history.length <= MAX_HISTORY_MESSAGES + 1) return;

		const systemPrompt = this._history[0];
		const trimmed = this._history.slice(-(MAX_HISTORY_MESSAGES));
		this._history = [systemPrompt, ...trimmed];
	}

	/** Builds the structured input array for the KIE API, potentially condensing history. */
	private _buildKieInput(history: ChatMessage[], model: string) {
		if (model === 'gpt-5-5') {
			const systemPrompt = history.find(m => m.role === 'system')?.content || '';
			const conversationTurns: string[] = [];

			for (const msg of history) {
				if (msg.role === 'system') continue;
				const roleLabel = msg.role === 'user' ? 'User' : 'Assistant (Zelos)';
				conversationTurns.push(`${roleLabel}: ${msg.content}`);
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

			return [
				{
					role: 'user',
					content: [{ type: 'input_text', text: condensedPrompt }]
				}
			];
		}

		// Standard multi-turn format for other models
		return history.map(msg => ({
			role: msg.role,
			content: [{ type: 'input_text', text: msg.content }],
		}));
	}
}
