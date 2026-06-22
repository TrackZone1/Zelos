import * as vscode from 'vscode';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

/** Maximum time (ms) before a command is killed */
const COMMAND_TIMEOUT = 30_000;

/** Commands that are never allowed to run */
const BLOCKED_COMMANDS = [
	'rm -rf /',
	'rm -rf ~',
	'rm -rf *',
	'del /s /q c:\\',
	'format c:',
	'mkfs',
	':(){:|:&};:',
	'shutdown',
	'reboot',
];

export interface ToolResult {
	action: string;
	status: 'success' | 'error';
	details: string;
}

export class ToolExecutor {
	/**
	 * Parses the agent's reply for tool-execution XML tags and runs them.
	 * Returns a cleaned UI message and an array of structured results
	 * that the Agent loop feeds back to the model.
	 */
	public async executeActions(
		reply: string,
		requestCommandApproval?: (command: string) => Promise<boolean>,
		requestFileApproval?: (path: string, content: string) => Promise<boolean>
	): Promise<{ uiMessage: string; toolResults: ToolResult[] }> {
		let uiMessage = reply;
		const toolResults: ToolResult[] = [];
		const workspaceFolders = vscode.workspace.workspaceFolders;

		if (!workspaceFolders || workspaceFolders.length === 0) {
			if (this._hasToolTags(reply)) {
				return {
					uiMessage: uiMessage + '\n\n*(Error: No workspace folder open — cannot execute tools)*',
					toolResults: [{ action: 'workspace_check', status: 'error', details: 'No workspace folder open.' }],
				};
			}
			return { uiMessage, toolResults };
		}

		const workspacePath = workspaceFolders[0].uri.fsPath;
		const workspaceRoot = workspaceFolders[0].uri;

		// ── tool_call (leaked tool call syntax) ──────────────────────
		const toolCallResults = await this._handleToolCalls(reply, workspacePath, workspaceRoot, requestCommandApproval, requestFileApproval);
		for (const r of toolCallResults) {
			uiMessage = uiMessage.replace(r.rawMatch, r.uiSnippet);
			toolResults.push(r.result);
		}

		// ── create_file ──────────────────────────────────────────────
		const fileResults = await this._handleCreateFile(reply, workspaceRoot, requestFileApproval);
		for (const r of fileResults) {
			uiMessage = uiMessage.replace(r.rawMatch, r.uiSnippet);
			toolResults.push(r.result);
		}

		// ── run_command ──────────────────────────────────────────────
		const cmdResults = await this._handleRunCommand(reply, workspacePath, requestCommandApproval);
		for (const r of cmdResults) {
			uiMessage = uiMessage.replace(r.rawMatch, r.uiSnippet);
			toolResults.push(r.result);
		}

		// ── read_file ────────────────────────────────────────────────
		const readResults = await this._handleReadFile(reply, workspaceRoot);
		for (const r of readResults) {
			uiMessage = uiMessage.replace(r.rawMatch, r.uiSnippet);
			toolResults.push(r.result);
		}

		// ── list_files ───────────────────────────────────────────────
		const listResults = await this._handleListFiles(reply, workspaceRoot);
		for (const r of listResults) {
			uiMessage = uiMessage.replace(r.rawMatch, r.uiSnippet);
			toolResults.push(r.result);
		}

		// ── Strip remaining wrapper tags ─────────────────────────────
		uiMessage = uiMessage
			.replace(/<tool_call\s+name="multi_tool_use\.parallel">/g, '')
			.replace(/<\/tool_call>/g, '');

		return { uiMessage, toolResults };
	}

	// ─── Private helpers ──────────────────────────────────────────────

	private _hasToolTags(text: string): boolean {
		return /<(create_file|run_command|read_file|list_files|tool_call)[\s>]/.test(text);
	}

	private async _handleCreateFile(
		reply: string,
		workspaceRoot: vscode.Uri,
		requestFileApproval?: (path: string, content: string) => Promise<boolean>,
	): Promise<{ rawMatch: string; uiSnippet: string; result: ToolResult }[]> {
		const regex = /<create_file\s+path="([^"]+)">([\s\S]*?)<\/create_file>/g;
		const results: { rawMatch: string; uiSnippet: string; result: ToolResult }[] = [];
		let match;

		while ((match = regex.exec(reply)) !== null) {
			const filePath = match[1];
			let content = match[2];

			// Trim leading/trailing newline added by the model
			if (content.startsWith('\n')) content = content.substring(1);
			if (content.endsWith('\n')) content = content.substring(0, content.length - 1);

			const res = await this._createSingleFile(filePath, content, match[0], workspaceRoot, requestFileApproval);
			results.push(res);
		}
		return results;
	}

	private async _createSingleFile(
		filePath: string,
		content: string,
		rawMatch: string,
		workspaceRoot: vscode.Uri,
		requestFileApproval?: (path: string, content: string) => Promise<boolean>,
	): Promise<{ rawMatch: string; uiSnippet: string; result: ToolResult }> {
		// ── Approval check ──
		if (requestFileApproval) {
			const approved = await requestFileApproval(filePath, content);
			if (!approved) {
				return {
					rawMatch,
					uiSnippet: `\n> ❌ **File creation/modification rejected by user:** \`${filePath}\`\n`,
					result: { action: `create_file ${filePath}`, status: 'error', details: 'File creation was rejected by the user.' },
				};
			}
		}

		try {
			const fileUri = vscode.Uri.joinPath(workspaceRoot, filePath);
			// Ensure parent directory exists
			const parentUri = vscode.Uri.joinPath(fileUri, '..');
			try { await vscode.workspace.fs.createDirectory(parentUri); } catch { /* already exists */ }

			await vscode.workspace.fs.writeFile(fileUri, Buffer.from(content, 'utf8'));
			return {
				rawMatch,
				uiSnippet: `\n> ✅ **File created:** \`${filePath}\`\n`,
				result: { action: `create_file ${filePath}`, status: 'success', details: 'File written successfully.' },
			};
		} catch (err: any) {
			return {
				rawMatch,
				uiSnippet: `\n> ❌ **Failed to create file:** \`${filePath}\` — ${err.message}\n`,
				result: { action: `create_file ${filePath}`, status: 'error', details: err.message },
			};
		}
	}

	private async _handleRunCommand(
		reply: string,
		workspacePath: string,
		requestApproval?: (command: string) => Promise<boolean>,
	): Promise<{ rawMatch: string; uiSnippet: string; result: ToolResult }[]> {
		const regex = /<run_command\s+cmd="([^"]+)">\s*<\/run_command>/g;
		const results: { rawMatch: string; uiSnippet: string; result: ToolResult }[] = [];
		let match;

		while ((match = regex.exec(reply)) !== null) {
			const command = match[1];
			const res = await this._runSingleCommand(command, match[0], workspacePath, requestApproval);
			results.push(res);
		}
		return results;
	}

	private async _runSingleCommand(
		command: string,
		rawMatch: string,
		workspacePath: string,
		requestApproval?: (command: string) => Promise<boolean>,
	): Promise<{ rawMatch: string; uiSnippet: string; result: ToolResult }> {
		// ── Security gate ──
		if (this._isBlockedCommand(command)) {
			return {
				rawMatch,
				uiSnippet: `\n> 🛑 **Blocked dangerous command:** \`${command}\`\n`,
				result: { action: `run_command ${command}`, status: 'error', details: 'Command blocked for safety.' },
			};
		}

		// ── Approval check ──
		if (requestApproval) {
			const approved = await requestApproval(command);
			if (!approved) {
				return {
					rawMatch,
					uiSnippet: `\n> ❌ **Command execution rejected by user:** \`${command}\`\n`,
					result: { action: `run_command ${command}`, status: 'error', details: 'Command execution was rejected by the user.' },
				};
			}
		}

		try {
			const { stdout, stderr } = await execAsync(command, {
				cwd: workspacePath,
				timeout: COMMAND_TIMEOUT,
				maxBuffer: 1024 * 1024, // 1 MB
			});
			let output = stdout;
			if (stderr) output += '\n[STDERR]\n' + stderr;

			// Truncate very long output so it doesn't blow up the context
			if (output.length > 4000) {
				output = output.substring(0, 4000) + '\n...[truncated]';
			}

			return {
				rawMatch,
				uiSnippet: `\n> 💻 **Ran:** \`${command}\`\n`,
				result: { action: `run_command ${command}`, status: 'success', details: output || '(no output)' },
			};
		} catch (err: any) {
			const errDetails = [err.stdout, err.stderr, err.message].map(s => String(s || '').trim()).filter(Boolean).join('\n').trim();
			const truncatedDetails = errDetails.length > 800 ? errDetails.substring(0, 800) + '\n...[output truncated]' : errDetails;
			return {
				rawMatch,
				uiSnippet: `\n> ❌ **Command failed:** \`${command}\`\n\`\`\`\n${truncatedDetails}\n\`\`\`\n`,
				result: { action: `run_command ${command}`, status: 'error', details: errDetails },
			};
		}
	}

	private async _handleReadFile(
		reply: string,
		workspaceRoot: vscode.Uri,
	): Promise<{ rawMatch: string; uiSnippet: string; result: ToolResult }[]> {
		const regex = /<read_file\s+path="([^"]+)">\s*<\/read_file>/g;
		const results: { rawMatch: string; uiSnippet: string; result: ToolResult }[] = [];
		let match;

		while ((match = regex.exec(reply)) !== null) {
			const filePath = match[1];
			const res = await this._readSingleFile(filePath, match[0], workspaceRoot);
			results.push(res);
		}
		return results;
	}

	private async _readSingleFile(
		filePath: string,
		rawMatch: string,
		workspaceRoot: vscode.Uri,
	): Promise<{ rawMatch: string; uiSnippet: string; result: ToolResult }> {
		try {
			const fileUri = vscode.Uri.joinPath(workspaceRoot, filePath);
			const data = await vscode.workspace.fs.readFile(fileUri);
			let content = Buffer.from(data).toString('utf8');

			// Truncate very long files
			if (content.length > 8000) {
				content = content.substring(0, 8000) + '\n...[truncated]';
			}

			return {
				rawMatch,
				uiSnippet: `\n> 📖 **Read file:** \`${filePath}\`\n`,
				result: { action: `read_file ${filePath}`, status: 'success', details: content },
			};
		} catch (err: any) {
			return {
				rawMatch,
				uiSnippet: `\n> ❌ **Cannot read file:** \`${filePath}\` — ${err.message}\n`,
				result: { action: `read_file ${filePath}`, status: 'error', details: err.message },
			};
		}
	}

	private async _handleListFiles(
		reply: string,
		workspaceRoot: vscode.Uri,
	): Promise<{ rawMatch: string; uiSnippet: string; result: ToolResult }[]> {
		const regex = /<list_files\s+path="([^"]*)">\s*<\/list_files>/g;
		const results: { rawMatch: string; uiSnippet: string; result: ToolResult }[] = [];
		let match;

		while ((match = regex.exec(reply)) !== null) {
			const dirPath = match[1] || '.';
			const res = await this._listSingleDir(dirPath, match[0], workspaceRoot);
			results.push(res);
		}
		return results;
	}

	private async _listSingleDir(
		dirPath: string,
		rawMatch: string,
		workspaceRoot: vscode.Uri,
	): Promise<{ rawMatch: string; uiSnippet: string; result: ToolResult }> {
		try {
			const dirUri = vscode.Uri.joinPath(workspaceRoot, dirPath);
			const entries = await vscode.workspace.fs.readDirectory(dirUri);
			const listing = entries
				.map(([name, type]) => {
					const kind = type === vscode.FileType.Directory ? '📁' : '📄';
					return `${kind} ${name}`;
				})
				.join('\n');

			return {
				rawMatch,
				uiSnippet: `\n> 📂 **Listed:** \`${dirPath}/\`\n`,
				result: { action: `list_files ${dirPath}`, status: 'success', details: listing || '(empty directory)' },
			};
		} catch (err: any) {
			return {
				rawMatch,
				uiSnippet: `\n> ❌ **Cannot list:** \`${dirPath}/\` — ${err.message}\n`,
				result: { action: `list_files ${dirPath}`, status: 'error', details: err.message },
			};
		}
	}

	private _isBlockedCommand(command: string): boolean {
		const lower = command.toLowerCase().trim();
		return BLOCKED_COMMANDS.some(blocked => lower.includes(blocked));
	}

	private async _handleToolCalls(
		reply: string,
		workspacePath: string,
		workspaceRoot: vscode.Uri,
		requestCommandApproval?: (command: string) => Promise<boolean>,
		requestFileApproval?: (path: string, content: string) => Promise<boolean>,
	): Promise<{ rawMatch: string; uiSnippet: string; result: ToolResult }[]> {
		const regex = /<tool_call\s+name="([^"]+)"\s+arguments=(['"])([\s\S]*?)\2>\s*<\/tool_call>/g;
		const results: { rawMatch: string; uiSnippet: string; result: ToolResult }[] = [];
		let match;

		while ((match = regex.exec(reply)) !== null) {
			const name = match[1];
			const argStr = match[3];
			const rawMatch = match[0];

			// Parse arguments
			let args: any = {};
			try {
				args = JSON.parse(argStr);
			} catch (_) {
				try {
					const unescaped = argStr.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
					args = JSON.parse(unescaped);
				} catch (err) {
					console.error('Failed to parse tool call arguments:', argStr, err);
					const cmdMatch = argStr.match(/"cmd"\s*:\s*"([^"]+)"/);
					if (cmdMatch) args.cmd = cmdMatch[1];
					const pathMatch = argStr.match(/"path"\s*:\s*"([^"]+)"/);
					if (pathMatch) args.path = pathMatch[1];
					const contentMatch = argStr.match(/"content"\s*:\s*"([^"]+)"/);
					if (contentMatch) args.content = contentMatch[1];
				}
			}

			// Map and execute based on tool name
			if (name === 'functions.shell' || name === 'functions.run_command' || name === 'run_command') {
				const command = args.cmd || args.command || '';
				if (command) {
					const res = await this._runSingleCommand(command, rawMatch, workspacePath, requestCommandApproval);
					results.push(res);
				}
			} else if (name === 'functions.read_file' || name === 'read_file') {
				const filePath = args.path || args.filePath || '';
				if (filePath) {
					const res = await this._readSingleFile(filePath, rawMatch, workspaceRoot);
					results.push(res);
				}
			} else if (name === 'functions.create_file' || name === 'functions.write_file' || name === 'create_file') {
				const filePath = args.path || args.filePath || '';
				const content = args.content || args.fileContent || '';
				if (filePath) {
					const res = await this._createSingleFile(filePath, content, rawMatch, workspaceRoot, requestFileApproval);
					results.push(res);
				}
			} else if (name === 'functions.list_files' || name === 'functions.list_dir' || name === 'list_files') {
				const dirPath = args.path || args.dirPath || '.';
				const res = await this._listSingleDir(dirPath, rawMatch, workspaceRoot);
				results.push(res);
			}
		}
		return results;
	}
}
