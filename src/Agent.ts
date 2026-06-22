import * as vscode from 'vscode';
import { ToolExecutor } from './ToolExecutor';
import { ModelProvider } from './ModelProvider';
import { CriticAgent, CriticSubAgent, CriticResult } from './CriticAgent';

// ── Types ────────────────────────────────────────────────────────────

export interface ChatMessage {
	role: 'system' | 'user' | 'assistant';
	content: string | { type: string; text?: string; image_url?: string }[];
}

export interface AgentEvent {
	type: 'status' | 'response' | 'tool_action' | 'error' | 'lock' | 'unlock' | 'critic_review';
	message: string;
	criticResults?: CriticResult[];
}

// ── Constants ────────────────────────────────────────────────────────

const MAX_LOOP_ITERATIONS = Number.MAX_SAFE_INTEGER;
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
	'### 5. Visual Review / Browser Navigation (collaborates with visual model)',
	'Use this to ask a separate visual model to review page UI, click buttons, type inputs, scroll, and verify functionality on a running Chrome instance.',
	'<visual_review url="http://localhost:3000" instruction="Click sign up and check for form validation errors."></visual_review>',
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
	private _stopped = false;
	private _criticAgent: CriticAgent;
	private _lastUserMessage = '';

	constructor(
		emit: (event: AgentEvent) => void,
		requestCommandApproval: (command: string) => Promise<boolean>,
		requestFileApproval: (path: string, content: string) => Promise<boolean>
	) {
		this._emit = emit;
		this._requestCommandApproval = requestCommandApproval;
		this._requestFileApproval = requestFileApproval;
		this._toolExecutor = new ToolExecutor();
		this._criticAgent = new CriticAgent();
		this._resetHistory();
	}

	/** Updates the list of critic sub-agents. */
	public setCriticSubAgents(agents: CriticSubAgent[]) {
		this._criticAgent.setSubAgents(agents);
	}

	/** Clears conversation history and re-injects the system prompt. */
	public resetConversation() {
		this._resetHistory();
		this._emit({ type: 'status', message: '*(Conversation reset)*' });
	}

	public stop() {
		if (this._busy) {
			this._stopped = true;
			this._emit({ type: 'status', message: 'Stopping...' });
		}
	}

	public async handleUserMessage(message: string, base64Image?: string) {
		if (this._busy) {
			this._emit({ type: 'error', message: 'Zelos is still working on the previous request. Please wait.' });
			return;
		}

		this._busy = true;
		this._stopped = false;
		this._emit({ type: 'lock', message: '' });

		try {
			// Build the user message with optional editor context
			const userContent = this._buildUserContent(message);
			
			let finalContent: string | { type: string; text?: string; image_url?: string }[] = userContent;
			if (base64Image) {
				this._emit({ type: 'status', message: 'Uploading image to KIE...' });
				const imageUrl = await this._uploadImageToKie(base64Image);
				if (imageUrl) {
					finalContent = [
						{ type: 'input_text', text: userContent },
						{ type: 'input_image', image_url: imageUrl }
					];
				}
			}

			this._history.push({ role: 'user', content: finalContent });
			this._lastUserMessage = message;

			await this._runAgentLoop();
		} finally {
			this._busy = false;
			this._emit({ type: 'unlock', message: '' });
		}
	}

	private async _uploadImageToKie(base64DataUrl: string): Promise<string | null> {
		const config = vscode.workspace.getConfiguration('zelos');
		const apiKey = config.get<string>('api.key') || '';
		if (!apiKey) return null;

		try {
			let base64Data = base64DataUrl;
			let mimeType = 'image/png';
			if (base64DataUrl.includes(';base64,')) {
				const parts = base64DataUrl.split(';base64,');
				base64Data = parts[1];
				const match = parts[0].match(/data:(.*)/);
				if (match) mimeType = match[1];
			}

			const ext = mimeType.split('/')[1] || 'png';
			const fileName = `upload-${Date.now()}.${ext}`;

			const response = await fetch('https://api.kie.ai/api/file-base64-upload', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'Authorization': `Bearer ${apiKey}`,
				},
				body: JSON.stringify({
					base64Data,
					uploadPath: 'images/chat-uploads',
					fileName
				})
			});

			if (response.ok) {
				const resData = await response.json() as any;
				if (resData.success && resData.data?.downloadUrl) {
					return resData.data.downloadUrl;
				} else {
					console.error('KIE image upload failed:', resData.msg);
				}
			} else {
				console.error('KIE image upload response status:', response.status);
			}
		} catch (err) {
			console.error('Error uploading image to KIE:', err);
		}
		return base64DataUrl;
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
		this._stopped = false;
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
		const config = vscode.workspace.getConfiguration('zelos');
		const communicationLanguage = config.get<string>('communicationLanguage') || 'English';
		const codeLanguage = config.get<string>('codeLanguage') || 'English';

		const promptParts = [
			'You are Zelos, an autonomous AI coding agent embedded in VS Code.',
			`Current environment: Running on ${platform} (Shell: ${shell}). Please ensure any shell commands run via <run_command> or functions.shell are fully compatible with this operating system.`,
			''
		];

		promptParts.push(
			'## LANGUAGE OF COMMUNICATION',
			`You MUST communicate and write ALL your conversational responses in ${communicationLanguage}. However, do NOT translate tool tags, XML tags, or code keywords.`,
			''
		);

		promptParts.push(
			'## LANGUAGE OF CODE',
			`Within any code you generate, create, or modify, you MUST write all comments, documentation, variable names, function names, class names, and text strings in ${codeLanguage} unless they are predefined library dependencies.`,
			''
		);

		promptParts.push(SYSTEM_PROMPT_BODY);
		return promptParts.join('\n');
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

		// Dynamically update the system prompt with the latest settings
		if (this._history.length > 0 && this._history[0].role === 'system') {
			this._history[0].content = this._getSystemPrompt();
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

		const fetchUrl = ModelProvider.resolveApiUrl(apiUrl, model);
		let codeLeakRetries = 0;
		let criticCorrectionsCount = 0;

		for (let step = 1; step <= MAX_LOOP_ITERATIONS; step++) {
			if (this._stopped) {
				this._emit({ type: 'error', message: 'Zelos was stopped by the user.' });
				break;
			}
			this._emit({ type: 'status', message: 'Thinking...' });

			// Truncate history if it grew too large
			this._trimHistory();

			let response: Response | undefined;
			let apiError: any = null;
			let responseData: any = null;
			let delay = 1000;

			for (let attempt = 0; attempt <= MAX_API_RETRIES; attempt++) {
				try {
					const body = await ModelProvider.buildPayload(this._history, model);

					response = await fetch(fetchUrl, {
						method: 'POST',
						headers: {
							'Content-Type': 'application/json',
							'Authorization': `Bearer ${apiKey}`,
						},
						body: JSON.stringify(body),
					});

					if (response.ok) {
						const text = await response.text();
						let hasError = false;
						try {
							responseData = JSON.parse(text);
							if (responseData && responseData.code && responseData.code !== 200 && responseData.code !== '200') {
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
				const reply = ModelProvider.extractReply(responseData);
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
				const { uiMessage, toolResults } = await this._toolExecutor.executeActions(
					reply,
					reqCmdApproval,
					reqFileApproval,
					(status) => this._emit({ type: 'status', message: status })
				);

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

					// ── Critic Sub-Agent Reviews ──
					let doAutoCorrection = false;

					if (this._criticAgent.hasActiveAgents()) {
						try {
							const criticResults = await this._criticAgent.reviewResponse(
								reply,
								this._lastUserMessage,
								(status) => this._emit({ type: 'status', message: status })
							);

							if (criticResults.length > 0) {
								this._emit({
									type: 'critic_review',
									message: '',
									criticResults
								});

								const hasSevereIssues = criticResults.some(
									cr => cr.severity === 'warning' || cr.severity === 'critical'
								);

								if (hasSevereIssues && criticCorrectionsCount < 1) {
									doAutoCorrection = true;
									criticCorrectionsCount++;

									const criticSummary = criticResults.map(cr =>
										`[Critic: ${cr.agentName} (${cr.role})] [${cr.severity}] ${cr.critique}`
									).join('\n---\n');

									this._history.push({
										role: 'user',
										content: [
											'[CRITIC AGENT WARNINGS/CRITICAL ISSUES DETECTED]',
											'The following issues were identified by critic sub-agents in your proposed response:',
											criticSummary,
											'Please fix these issues using the appropriate tools, or if you choose to ignore them, explain why in your next response.',
										].join('\n')
									});

									this._emit({
										type: 'status',
										message: 'Critic agents flagged issues. Zelos is attempting to correct...'
									});
								} else {
									const criticSummary = criticResults.map(cr =>
										`[Critic: ${cr.agentName} (${cr.role})] [${cr.severity}] ${cr.critique}`
									).join('\n---\n');

									this._history.push({
										role: 'user',
										content: [
											'[CRITIC AGENT FEEDBACK — for your awareness only, you may choose to act on this or not]',
											criticSummary,
											'[END CRITIC FEEDBACK — respond naturally to the user, do not reference this feedback unless relevant]'
										].join('\n')
									});
								}
							}
						} catch (err: any) {
							console.error('Critic review failed:', err);
						}
					}

					if (doAutoCorrection) {
						continue;
					}

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

	/** Keeps history within MAX_HISTORY_MESSAGES and compacts older messages to save tokens. */
	private _trimHistory() {
		// First, do a pass to compact older messages to save tokens
		// We keep the last 4 messages fully intact (e.g., 2 user turns and 2 assistant turns)
		const retainFullCount = 4;
		if (this._history.length > retainFullCount + 1) { // +1 for the system prompt
			for (let i = 1; i < this._history.length - retainFullCount; i++) {
				const msg = this._history[i];
				
				if (msg.role === 'user') {
					if (typeof msg.content === 'string') {
						msg.content = this._compactUserMessage(msg.content);
					} else if (Array.isArray(msg.content)) {
						for (const part of msg.content) {
							if (part.type === 'input_text' && part.text) {
								part.text = this._compactUserMessage(part.text);
							}
						}
					}
				} else if (msg.role === 'assistant' && typeof msg.content === 'string') {
					// Compact <create_file> bodies
					msg.content = msg.content.replace(/(<create_file[^>]*>)([\s\S]*?)(<\/create_file>)/g, '$1\n...[COMPACTED TO SAVE TOKENS]...\n$3');
				}
			}
		}

		if (this._history.length <= MAX_HISTORY_MESSAGES + 1) return;

		const systemPrompt = this._history[0];
		const trimmed = this._history.slice(-(MAX_HISTORY_MESSAGES));
		this._history = [systemPrompt, ...trimmed];
	}

	private _compactUserMessage(content: string): string {
		let newContent = content;
		// 1. Compact [TOOL RESULTS] Output
		if (newContent.includes('[TOOL RESULTS]')) {
			const lines = newContent.split('\n');
			const compactedLines: string[] = [];
			let inOutput = false;
			
			for (const line of lines) {
				if (line.startsWith('Output:')) {
					inOutput = true;
					compactedLines.push('Output:\n[COMPACTED TO SAVE TOKENS]');
				} else if (line === '---') {
					inOutput = false;
					compactedLines.push(line);
				} else if (!inOutput) {
					compactedLines.push(line);
				}
			}
			newContent = compactedLines.join('\n');
		}
		
		// 2. Compact initial Active file text
		if (newContent.includes('[Active file:')) {
			newContent = newContent.replace(/\[Active file: ([^\]]+)\]\n[\s\S]*?(?=\n\n\[IMPORTANT:|$)/, '[Active file: $1]\n...[file content compacted to save tokens]...');
		}
		
		return newContent;
	}
}
