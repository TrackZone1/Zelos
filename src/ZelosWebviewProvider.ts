import * as vscode from 'vscode';
import { Agent, AgentEvent } from './Agent';

export class ZelosWebviewProvider implements vscode.WebviewViewProvider {
	public static readonly viewType = 'zelos.chatView';

	private _view?: vscode.WebviewView;
	private _agent: Agent;
	private _pendingCommandApproval?: {
		resolve: (approved: boolean) => void;
		command: string;
	};
	private _pendingFileApproval?: {
		resolve: (approved: boolean) => void;
		path: string;
		content: string;
	};

	constructor(
		private readonly _extensionUri: vscode.Uri,
	) {
		this._agent = new Agent(
			(event: AgentEvent) => {
				if (!this._view) return;
				this._view.webview.postMessage({ type: event.type, value: event.message });
			},
			async (command: string) => {
				if (!this._view) return false;
				return new Promise<boolean>((resolve) => {
					this._pendingCommandApproval = { resolve, command };
					this._view?.webview.postMessage({ type: 'requestCommandApproval', command });
				});
			},
			async (filePath: string, content: string) => {
				if (!this._view) return false;
				return new Promise<boolean>((resolve) => {
					this._pendingFileApproval = { resolve, path: filePath, content };
					this._view?.webview.postMessage({ type: 'requestFileApproval', path: filePath, content });
				});
			}
		);
	}

	public resolveWebviewView(
		webviewView: vscode.WebviewView,
		_context: vscode.WebviewViewResolveContext,
		_token: vscode.CancellationToken,
	) {
		this._view = webviewView;

		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [this._extensionUri],
		};

		webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

		webviewView.onDidDispose(() => {
			this._view = undefined;
			if (this._pendingCommandApproval) {
				this._pendingCommandApproval.resolve(false);
				this._pendingCommandApproval = undefined;
			}
			if (this._pendingFileApproval) {
				this._pendingFileApproval.resolve(false);
				this._pendingFileApproval = undefined;
			}
		});

		webviewView.webview.onDidReceiveMessage(data => {
			switch (data.type) {
				case 'webviewLoaded': {
					const config = vscode.workspace.getConfiguration('zelos');
					this._view?.webview.postMessage({
						type: 'initSettings',
						apiKey: config.get<string>('api.key') || '',
						model: config.get<string>('api.model') || 'gpt-5-5',
						apiUrl: config.get<string>('api.url') || 'https://api.kie.ai',
						commandApprovalMode: config.get<string>('commandApprovalMode') || 'prompt',
						fileApprovalMode: config.get<string>('fileApprovalMode') || 'prompt',
					});
					break;
				}
				case 'chat': {
					this._handleChatMessage(data.value);
					break;
				}
				case 'approveCommand': {
					if (this._pendingCommandApproval) {
						this._pendingCommandApproval.resolve(true);
						this._pendingCommandApproval = undefined;
					}
					break;
				}
				case 'rejectCommand': {
					if (this._pendingCommandApproval) {
						this._pendingCommandApproval.resolve(false);
						this._pendingCommandApproval = undefined;
					}
					break;
				}
				case 'approveFile': {
					if (this._pendingFileApproval) {
						this._pendingFileApproval.resolve(true);
						this._pendingFileApproval = undefined;
					}
					break;
				}
				case 'rejectFile': {
					if (this._pendingFileApproval) {
						this._pendingFileApproval.resolve(false);
						this._pendingFileApproval = undefined;
					}
					break;
				}
				case 'resetChat': {
					if (this._pendingCommandApproval) {
						this._pendingCommandApproval.resolve(false);
						this._pendingCommandApproval = undefined;
					}
					if (this._pendingFileApproval) {
						this._pendingFileApproval.resolve(false);
						this._pendingFileApproval = undefined;
					}
					this._agent.resetConversation();
					break;
				}
				case 'saveSettings': {
					const config = vscode.workspace.getConfiguration('zelos');
					Promise.all([
						config.update('api.key', data.apiKey, true),
						config.update('api.model', data.model, true),
						config.update('api.url', data.apiUrl, true),
						config.update('commandApprovalMode', data.commandApprovalMode, true),
						config.update('fileApprovalMode', data.fileApprovalMode, true),
					]).then(() => vscode.window.showInformationMessage('Zelos settings saved!'));
					break;
				}
				case 'updateFileApprovalMode': {
					const config = vscode.workspace.getConfiguration('zelos');
					config.update('fileApprovalMode', data.value, true);
					break;
				}
				case 'runAudit': {
					this._handleAuditMessage(data.options);
					break;
				}
			}
		});
	}

	private async _handleChatMessage(message: string) {
		if (!this._view) return;
		this._view.webview.postMessage({ type: 'userMessage', value: message });
		await this._agent.handleUserMessage(message);
	}

	private async _handleAuditMessage(options: {
		checkArchitecture: boolean;
		codeReview: boolean;
		runTests: boolean;
		testCommand: string;
		selfCorrect: boolean;
		checkCognitiveComplexity?: boolean;
		cognitiveComplexityThreshold?: number;
	}) {
		if (!this._view) return;
		this._view.webview.postMessage({ type: 'userMessage', value: '🔍 Starting Workspace Audit...' });
		await this._agent.runAudit(options);
	}

	private _getHtmlForWebview(webview: vscode.Webview): string {
		const nonce = getNonce();
		return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'nonce-${nonce}';">
	<title>Zelos Chat</title>
	<link rel="preconnect" href="https://fonts.googleapis.com">
	<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
	<link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600&family=Fira+Code:wght@400;500&display=swap" rel="stylesheet">
	<style>
		:root {
			--accent-hue: 168;
			--accent: hsl(var(--accent-hue), 75%, 45%);
			--accent-hover: hsl(var(--accent-hue), 75%, 38%);
			--accent-glow: hsla(var(--accent-hue), 75%, 45%, 0.15);

			--bg: var(--vscode-editor-background);
			--fg: var(--vscode-editor-foreground);
			--card-bg: var(--vscode-editorWidget-background);
			--border-color: var(--vscode-widget-border);
			--font-sans: 'Outfit', var(--vscode-font-family), -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
			--font-mono: 'Fira Code', var(--vscode-editor-font-family), "SF Mono", Monaco, Consolas, "Courier New", monospace;
		}

		* { box-sizing: border-box; margin: 0; padding: 0; }

		body {
			font-family: var(--font-sans);
			color: var(--fg);
			background: var(--bg);
			padding: 10px;
			display: flex;
			flex-direction: column;
			height: 100vh;
			overflow: hidden;
		}

		/* ── Scrollbar ───────────────────────── */
		::-webkit-scrollbar {
			width: 6px;
			height: 6px;
		}
		::-webkit-scrollbar-track {
			background: transparent;
		}
		::-webkit-scrollbar-thumb {
			background: var(--vscode-scrollbarSlider-background, rgba(121, 121, 121, 0.4));
			border-radius: 4px;
		}
		::-webkit-scrollbar-thumb:hover {
			background: var(--vscode-scrollbarSlider-hoverBackground, rgba(100, 100, 100, 0.7));
		}

		/* ── Top bar ─────────────────────────── */
		#top-bar {
			display: flex;
			justify-content: flex-end;
			gap: 8px;
			margin-bottom: 8px;
			padding-bottom: 8px;
			border-bottom: 1px solid var(--border-color);
		}
		.top-btn {
			background: none;
			color: var(--vscode-foreground);
			border: 1px solid var(--border-color);
			padding: 4px 10px;
			cursor: pointer;
			border-radius: 4px;
			font-size: 12px;
			font-family: var(--font-sans);
			font-weight: 500;
			display: flex;
			align-items: center;
			gap: 4px;
			transition: all 0.2s ease;
		}
		.top-btn:hover {
			background: var(--vscode-toolbar-hoverBackground);
			border-color: var(--vscode-focusBorder);
		}

		/* ── Settings Panel ──────────────────── */
		#settings-panel {
			display: none;
			flex-direction: column;
			gap: 10px;
			padding: 12px;
			background: var(--card-bg);
			border: 1px solid var(--border-color);
			margin-bottom: 8px;
			border-radius: 6px;
			box-shadow: 0 4px 12px rgba(0,0,0,0.15);
			animation: slideDown 0.25s ease-out;
		}
		@keyframes slideDown {
			from { opacity: 0; transform: translateY(-10px); }
			to { opacity: 1; transform: translateY(0); }
		}
		.setting-row { display: flex; flex-direction: column; gap: 4px; }
		.setting-row label {
			font-size: 11px;
			font-weight: 600;
			text-transform: uppercase;
			letter-spacing: 0.5px;
			color: var(--vscode-descriptionForeground);
		}
		.setting-row input, .setting-row select {
			background: var(--vscode-input-background);
			color: var(--vscode-input-foreground);
			border: 1px solid var(--vscode-input-border, var(--border-color));
			padding: 6px;
			border-radius: 4px;
			font-family: var(--font-sans);
			font-size: 12px;
			outline: none;
		}
		.setting-row input:focus, .setting-row select:focus {
			border-color: var(--vscode-focusBorder);
		}
		#save-settings-button {
			background: var(--accent);
			color: #ffffff;
			border: none;
			padding: 6px 12px;
			cursor: pointer;
			border-radius: 4px;
			font-size: 12px;
			font-weight: 600;
			font-family: var(--font-sans);
			margin-top: 4px;
			transition: background 0.2s;
		}
		#save-settings-button:hover { background: var(--accent-hover); }

		/* ── Chat history ────────────────────── */
		#chat-history {
			flex: 1;
			overflow-y: auto;
			display: flex;
			flex-direction: column;
			gap: 10px;
			margin-bottom: 10px;
			padding-right: 4px;
		}
		.msg {
			padding: 10px 12px;
			border-radius: 8px;
			max-width: 90%;
			word-wrap: break-word;
			font-size: 13px;
			line-height: 1.5;
			animation: fadeIn 0.2s ease-out;
		}
		@keyframes fadeIn {
			from { opacity: 0; transform: translateY(4px); }
			to { opacity: 1; transform: translateY(0); }
		}
		.msg-user {
			background: var(--vscode-button-background);
			color: var(--vscode-button-foreground);
			align-self: flex-end;
			border-bottom-right-radius: 2px;
			box-shadow: 0 2px 6px rgba(0, 0, 0, 0.1);
		}
		.msg-agent {
			background: var(--card-bg);
			border: 1px solid var(--border-color);
			align-self: flex-start;
			border-bottom-left-radius: 2px;
		}
		.msg-status {
			align-self: center;
			color: var(--vscode-descriptionForeground);
			font-size: 12px;
			padding: 4px 12px;
			background: var(--vscode-textBlockQuote-background);
			border-radius: 20px;
			border: 1px solid var(--border-color);
			display: flex;
			align-items: center;
			gap: 6px;
		}
		.msg-error {
			background: rgba(229, 57, 53, 0.1);
			color: var(--vscode-errorForeground, #ff6b6b);
			border: 1px solid rgba(229, 57, 53, 0.3);
			align-self: center;
			font-size: 12px;
			border-radius: 6px;
			text-align: center;
			max-width: 95%;
		}

		/* ── Pulse dot loader ────────────────── */
		.pulse-dot {
			width: 6px;
			height: 6px;
			background-color: var(--accent);
			border-radius: 50%;
			display: inline-block;
			animation: pulse 1.5s infinite ease-in-out;
			box-shadow: 0 0 6px var(--accent);
		}
		@keyframes pulse {
			0% { transform: scale(0.8); opacity: 0.4; }
			50% { transform: scale(1.2); opacity: 1; }
			100% { transform: scale(0.8); opacity: 0.4; }
		}

		/* ── Interactive Approval Card ───────── */
		.msg-approval {
			background: var(--card-bg);
			border: 1px dashed var(--vscode-focusBorder);
			border-radius: 8px;
			padding: 12px;
			margin: 4px 0;
			box-shadow: 0 4px 10px rgba(0, 0, 0, 0.1);
			align-self: stretch;
			max-width: 100%;
		}
		.approval-header {
			font-weight: 600;
			font-size: 13px;
			margin-bottom: 6px;
			display: flex;
			align-items: center;
			gap: 6px;
		}
		.approval-body {
			font-size: 12px;
			margin-bottom: 10px;
			color: var(--vscode-descriptionForeground);
		}
		.approval-body pre {
			background: var(--vscode-textBlockQuote-background);
			padding: 6px 10px;
			border-radius: 4px;
			overflow-x: auto;
			margin-top: 6px;
			border: 1px solid var(--border-color);
			max-height: 120px;
			font-family: var(--font-mono);
			font-size: 11px;
		}
		.approval-actions {
			display: flex;
			gap: 8px;
			align-items: center;
		}
		.approval-actions button {
			padding: 5px 12px;
			border-radius: 4px;
			cursor: pointer;
			font-weight: 600;
			border: none;
			font-size: 11px;
			font-family: var(--font-sans);
			transition: all 0.2s ease;
		}
		.approve-btn {
			background: var(--vscode-button-background);
			color: var(--vscode-button-foreground);
		}
		.approve-btn:hover {
			background: var(--vscode-button-hoverBackground);
		}
		.reject-btn {
			background: var(--vscode-button-secondaryBackground, #5f5f5f);
			color: var(--vscode-button-secondaryForeground, #ffffff);
		}
		.reject-btn:hover {
			background: var(--vscode-button-secondaryHoverBackground, #4f4f4f);
		}
		.status-approved {
			font-weight: 600;
			color: var(--accent);
			font-size: 12px;
		}
		.status-rejected {
			font-weight: 600;
			color: var(--vscode-errorForeground, #ff6b6b);
			font-size: 12px;
		}

		/* ── Styled Markdown & Code Blocks ───── */
		.chat-p {
			margin-bottom: 6px;
		}
		.chat-p:last-child {
			margin-bottom: 0;
		}
		.chat-br {
			height: 8px;
		}
		.code-block-container {
			margin: 8px 0;
			border-radius: 6px;
			overflow: hidden;
			border: 1px solid var(--border-color);
			background: var(--vscode-textCodeBlock-background, rgba(0, 0, 0, 0.2));
		}
		.code-block-header {
			display: flex;
			justify-content: space-between;
			align-items: center;
			padding: 4px 10px;
			background: var(--vscode-editorWidget-background);
			border-bottom: 1px solid var(--border-color);
			font-size: 11px;
			color: var(--vscode-descriptionForeground);
			font-family: var(--font-sans);
		}
		.code-block-copy {
			background: none;
			border: 1px solid var(--border-color);
			color: var(--vscode-foreground);
			padding: 2px 6px;
			cursor: pointer;
			border-radius: 3px;
			font-size: 10px;
			transition: all 0.2s ease;
		}
		.code-block-copy:hover {
			background: var(--vscode-toolbar-hoverBackground);
			border-color: var(--vscode-focusBorder);
		}
		.code-block-copy.copied {
			background: var(--accent);
			color: #ffffff;
			border-color: var(--accent);
		}
		.code-block-container pre {
			padding: 8px 10px;
			margin: 0;
			overflow-x: auto;
			font-family: var(--font-mono);
			font-size: 12px;
		}
		.inline-code {
			background: var(--vscode-textCodeBlock-background, rgba(0, 0, 0, 0.15));
			padding: 2px 4px;
			border-radius: 3px;
			font-family: var(--font-mono);
			font-size: 12px;
		}
		ul {
			margin-left: 18px;
			margin-bottom: 6px;
		}
		li {
			margin-bottom: 2px;
		}

		/* ── Input ───────────────────────────── */
		#input-container {
			display: flex;
			gap: 6px;
			border-top: 1px solid var(--border-color);
			padding-top: 8px;
		}
		#message-input {
			flex: 1;
			background: var(--vscode-input-background);
			color: var(--vscode-input-foreground);
			border: 1px solid var(--vscode-input-border, var(--border-color));
			padding: 8px 10px;
			border-radius: 4px;
			font-family: var(--font-sans);
			font-size: 13px;
			outline: none;
			transition: border-color 0.2s;
		}
		#message-input:focus {
			border-color: var(--vscode-focusBorder);
		}
		#message-input:disabled { opacity: 0.5; }
		#send-button {
			background: var(--vscode-button-background);
			color: var(--vscode-button-foreground);
			border: none;
			padding: 8px 16px;
			cursor: pointer;
			border-radius: 4px;
			font-size: 13px;
			font-family: var(--font-sans);
			font-weight: 600;
			transition: all 0.2s ease;
		}
		#send-button:hover { background: var(--vscode-button-hoverBackground); }
		#send-button:disabled { opacity: 0.5; cursor: not-allowed; }

		/* ── Auto-approve File Switch Toggle ── */
		.toggle-container {
			display: flex;
			align-items: center;
			justify-content: center;
			padding: 0 4px;
		}
		.toggle-checkbox {
			display: none;
		}
		.toggle-label {
			display: block;
			width: 34px;
			height: 18px;
			border-radius: 18px;
			background: var(--vscode-input-background);
			border: 1px solid var(--vscode-input-border, var(--border-color));
			position: relative;
			cursor: pointer;
			transition: all 0.3s ease;
		}
		.toggle-switch {
			display: block;
			width: 12px;
			height: 12px;
			border-radius: 50%;
			background: var(--vscode-descriptionForeground);
			position: absolute;
			top: 2px;
			left: 2px;
			transition: all 0.3s ease;
		}
		.toggle-checkbox:checked + .toggle-label {
			background: var(--accent);
			border-color: var(--accent);
		}
		.toggle-checkbox:checked + .toggle-label .toggle-switch {
			left: 18px;
			background: #ffffff;
			box-shadow: 0 0 6px rgba(255, 255, 255, 0.4);
		}
		.toggle-label:hover {
			border-color: var(--vscode-focusBorder);
		}

		#audit-panel {
			display: none;
			flex-direction: column;
			gap: 10px;
			padding: 12px;
			background: var(--card-bg);
			border: 1px solid var(--border-color);
			margin-bottom: 8px;
			border-radius: 6px;
			box-shadow: 0 4px 12px rgba(0,0,0,0.15);
			animation: slideDown 0.25s ease-out;
		}
		.audit-header h3 {
			font-size: 13px;
			font-weight: 600;
			margin-bottom: 4px;
			color: var(--accent);
		}
		.audit-header p {
			font-size: 11px;
			color: var(--vscode-descriptionForeground);
			margin-bottom: 4px;
			line-height: 1.35;
		}
		.checkbox-row {
			display: flex;
			align-items: center;
			gap: 8px;
			cursor: pointer;
			font-size: 12px;
			user-select: none;
			padding: 2px 0;
		}
		.checkbox-row input[type="checkbox"] {
			accent-color: var(--accent);
			cursor: pointer;
			width: 14px;
			height: 14px;
		}
		.audit-input-sub {
			background: var(--vscode-input-background);
			color: var(--vscode-input-foreground);
			border: 1px solid var(--vscode-input-border, var(--border-color));
			padding: 4px 8px;
			border-radius: 4px;
			font-family: var(--font-sans);
			font-size: 11px;
			outline: none;
			width: calc(100% - 22px);
			margin-left: 22px;
			margin-top: 2px;
			box-sizing: border-box;
		}
		.audit-input-sub:focus {
			border-color: var(--vscode-focusBorder);
		}
		#run-audit-button {
			background: var(--accent);
			color: #ffffff;
			border: none;
			padding: 6px 12px;
			cursor: pointer;
			border-radius: 4px;
			font-size: 12px;
			font-weight: 600;
			font-family: var(--font-sans);
			margin-top: 4px;
			transition: background 0.2s;
		}
		#run-audit-button:hover { background: var(--accent-hover); }
	</style>
</head>
<body>
	<div id="top-bar">
		<button class="top-btn" id="reset-btn" title="New conversation">🗑️ Reset</button>
		<button class="top-btn" id="settings-toggle" title="Settings">⚙️ Settings</button>
		<button class="top-btn" id="audit-toggle" title="Review & Test Workspace">🔍 Audit</button>
	</div>

	<div id="settings-panel">
		<div class="setting-row">
			<label for="api-key-input">KIE API Key</label>
			<input type="password" id="api-key-input" placeholder="sk-..." />
		</div>
		<div class="setting-row">
			<label for="api-url-input">API Base URL</label>
			<input type="text" id="api-url-input" placeholder="https://api.kie.ai" />
		</div>
		<div class="setting-row">
			<label for="model-input">Model</label>
			<select id="model-input">
				<option value="gpt-5-5">gpt-5-5 (GPT 5.5)</option>
				<option value="gpt-5-codex">gpt-5-codex</option>
				<option value="gpt-5.1-codex">gpt-5.1-codex</option>
				<option value="custom">Autre (Saisir ci-dessous...)</option>
			</select>
			<input type="text" id="custom-model-input" placeholder="nom-du-modele" style="margin-top: 4px; display: none;" />
		</div>
		<div class="setting-row">
			<label for="command-approval-input">Autorisation des Commandes</label>
			<select id="command-approval-input">
				<option value="prompt">Demander à chaque fois (Prompt)</option>
				<option value="acceptAll">Tout autoriser automatiquement</option>
				<option value="rejectAll">Tout refuser automatiquement</option>
			</select>
		</div>
		<div class="setting-row">
			<label for="file-approval-input">Autorisation du Code (Fichiers)</label>
			<select id="file-approval-input">
				<option value="prompt">Demander à chaque fois (Prompt)</option>
				<option value="acceptAll">Tout autoriser automatiquement</option>
				<option value="rejectAll">Tout refuser automatiquement</option>
			</select>
		</div>
		<button id="save-settings-button">Save Settings</button>
	</div>

	<div id="audit-panel">
		<div class="audit-header">
			<h3>🔍 Workspace Audit & Self-Correction</h3>
			<p>Ask Zelos to run tests, critique code quality, and apply fixes automatically.</p>
		</div>
		<div class="setting-row">
			<label class="checkbox-row">
				<input type="checkbox" id="audit-arch" checked />
				<span>Check directory layout & architecture</span>
			</label>
		</div>
		<div class="setting-row">
			<label class="checkbox-row">
				<input type="checkbox" id="audit-code" checked />
				<span>Perform code review & quality check</span>
			</label>
		</div>
		<div class="setting-row" style="flex-direction: column; align-items: flex-start; gap: 0;">
			<label class="checkbox-row">
				<input type="checkbox" id="audit-tests" checked />
				<span>Run tests automatically</span>
			</label>
			<input type="text" id="audit-test-cmd" class="audit-input-sub" placeholder="Test command (e.g. npm test)" value="npm test" />
		</div>
		<div class="setting-row" style="flex-direction: column; align-items: flex-start; gap: 0;">
			<label class="checkbox-row">
				<input type="checkbox" id="audit-cognitive" checked />
				<span>Perform cognitive complexity analysis</span>
			</label>
			<div id="audit-cognitive-threshold-container" style="margin-left: 22px; margin-top: 4px; display: flex; align-items: center; gap: 8px;">
				<span style="font-size: 11px; color: var(--vscode-descriptionForeground);">Threshold:</span>
				<input type="number" id="audit-cognitive-threshold" class="audit-input-sub" style="width: 50px; margin-left: 0; margin-top: 0; padding: 2px 6px;" value="15" min="1" />
			</div>
		</div>
		<div class="setting-row">
			<label class="checkbox-row">
				<input type="checkbox" id="audit-correct" checked />
				<span>Auto-critique & Self-correct issues</span>
			</label>
		</div>
		<button id="run-audit-button">Start Audit</button>
	</div>

	<div id="chat-history"></div>

	<div id="input-container">
		<input type="text" id="message-input" placeholder="Ask Zelos..." />
		<div class="toggle-container" title="Auto-valider les fichiers créés (pas de demandes de confirmation)">
			<input type="checkbox" id="auto-approve-file-checkbox" class="toggle-checkbox" />
			<label for="auto-approve-file-checkbox" class="toggle-label" title="Auto-valider les fichiers créés">
				<span class="toggle-switch"></span>
			</label>
		</div>
		<button id="send-button">Send</button>
	</div>

	<script nonce="${nonce}">
		const vscode = acquireVsCodeApi();

		const input = document.getElementById('message-input');
		const sendBtn = document.getElementById('send-button');
		const history = document.getElementById('chat-history');
		const settingsToggle = document.getElementById('settings-toggle');
		const settingsPanel = document.getElementById('settings-panel');
		const apiKeyInput = document.getElementById('api-key-input');
		const apiUrlInput = document.getElementById('api-url-input');
		const modelSelect = document.getElementById('model-input');
		const customModelInput = document.getElementById('custom-model-input');
		const commandApprovalInput = document.getElementById('command-approval-input');
		const fileApprovalInput = document.getElementById('file-approval-input');
		const saveBtn = document.getElementById('save-settings-button');
		const resetBtn = document.getElementById('reset-btn');
		const autoApproveCheckbox = document.getElementById('auto-approve-file-checkbox');
		const auditToggle = document.getElementById('audit-toggle');
		const auditPanel = document.getElementById('audit-panel');
		const auditArchCheckbox = document.getElementById('audit-arch');
		const auditCodeCheckbox = document.getElementById('audit-code');
		const auditTestsCheckbox = document.getElementById('audit-tests');
		const auditTestCmdInput = document.getElementById('audit-test-cmd');
		const auditCognitiveCheckbox = document.getElementById('audit-cognitive');
		const auditCognitiveThresholdContainer = document.getElementById('audit-cognitive-threshold-container');
		const auditCognitiveThresholdInput = document.getElementById('audit-cognitive-threshold');
		const auditCorrectCheckbox = document.getElementById('audit-correct');
		const runAuditBtn = document.getElementById('run-audit-button');

		let statusEl = null;

		vscode.postMessage({ type: 'webviewLoaded' });

		// ── Markdown Parser ─────────────────
		function escapeHtml(html) {
			return String(html)
				.replace(/&/g, "&amp;")
				.replace(/</g, "&lt;")
				.replace(/>/g, "&gt;")
				.replace(/"/g, "&quot;")
				.replace(/'/g, "&#039;");
		}

		function renderMarkdown(text) {
			const parts = text.split(String.fromCharCode(96).repeat(3));
			let html = '';
			for (let i = 0; i < parts.length; i++) {
				if (i % 2 === 1) {
					// Code block
					const part = parts[i];
					const firstNewline = part.indexOf('\\n');
					let lang = 'code';
					let code = part;
					if (firstNewline !== -1) {
						lang = part.substring(0, firstNewline).trim() || 'code';
						code = part.substring(firstNewline + 1);
					}
					if (code.endsWith('\\n')) code = code.slice(0, -1);
					
					const escapedCode = escapeHtml(code);
					const escapedLang = escapeHtml(lang);
					html += '<div class="code-block-container">' +
						'<div class="code-block-header">' +
							'<span class="code-block-lang">' + escapedLang + '</span>' +
							'<button class="code-block-copy">Copy</button>' +
						'</div>' +
						'<pre><code class="language-' + escapedLang + '">' + escapedCode + '</code></pre>' +
					'</div>';
				} else {
					// Regular text block
					let block = parts[i];
					if (!block) continue;
					
					block = escapeHtml(block);
					
					// Replace bold **text**
					block = block.replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>');
					
					// Replace italics *text*
					block = block.replace(/\\*([^*]+)\\*/g, '<em>$1</em>');
					
					// Replace inline code
					block = block.replace(new RegExp(String.fromCharCode(96) + '([^' + String.fromCharCode(96) + ']+)' + String.fromCharCode(96), 'g'), '<code class="inline-code">$1</code>');
					
					// Replace simple links [text](url)
					block = block.replace(/\\\[([^\\\]]+)\\\]\\(([^)]+)\\)/g, '<a href="$2" target="_blank">$1</a>');
					
					const lines = block.split('\\n');
					let listOpen = false;
					
					for (let line of lines) {
						const trimmed = line.trim();
						if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
							if (!listOpen) {
								html += '<ul>';
								listOpen = true;
							}
							const itemContent = trimmed.substring(2);
							html += '<li>' + itemContent + '</li>';
						} else {
							if (listOpen) {
								html += '</ul>';
								listOpen = false;
							}
							if (trimmed) {
								html += '<p class="chat-p">' + line + '</p>';
							} else {
								html += '<div class="chat-br"></div>';
							}
						}
					}
					if (listOpen) {
						html += '</ul>';
					}
				}
			}
			return html;
		}

		// ── UI helpers ──────────────────────
		function appendMessage(text, cls) {
			const div = document.createElement('div');
			div.className = 'msg ' + cls;
			if (cls === 'msg-user' || cls === 'msg-status' || cls === 'msg-error') {
				div.textContent = text;
			} else {
				div.innerHTML = renderMarkdown(text);
			}
			history.appendChild(div);
			history.scrollTop = history.scrollHeight;
			return div;
		}

		function setStatus(text) {
			if (statusEl) {
				statusEl.innerHTML = '<span class="pulse-dot"></span>' + escapeHtml(text);
			} else {
				statusEl = document.createElement('div');
				statusEl.className = 'msg msg-status';
				statusEl.innerHTML = '<span class="pulse-dot"></span>' + escapeHtml(text);
				history.appendChild(statusEl);
			}
			history.scrollTop = history.scrollHeight;
		}

		function clearStatus() {
			if (statusEl) {
				statusEl.remove();
				statusEl = null;
			}
		}

		function setLocked(locked) {
			input.disabled = locked;
			sendBtn.disabled = locked;
		}

		// ── Helper handlers ──
		function copyCode(btn) {
			const pre = btn.closest('.code-block-container').querySelector('code');
			navigator.clipboard.writeText(pre.textContent).then(() => {
				btn.textContent = 'Copied!';
				btn.classList.add('copied');
				setTimeout(() => {
					btn.textContent = 'Copy';
					btn.classList.remove('copied');
				}, 2000);
			});
		}

		function approveCommand(btn) {
			const parent = btn.closest('.msg-approval');
			parent.classList.add('approved');
			parent.querySelector('.approval-actions').innerHTML = '<span class="status-approved">✅ Autorisée (En cours...)</span>';
			vscode.postMessage({ type: 'approveCommand' });
		}

		function rejectCommand(btn) {
			const parent = btn.closest('.msg-approval');
			parent.classList.add('rejected');
			parent.querySelector('.approval-actions').innerHTML = '<span class="status-rejected">❌ Refusée</span>';
			vscode.postMessage({ type: 'rejectCommand' });
		}

		function approveFile(btn) {
			const parent = btn.closest('.msg-approval');
			parent.classList.add('approved');
			parent.querySelector('.approval-actions').innerHTML = '<span class="status-approved">✅ Validée (Écriture...)</span>';
			vscode.postMessage({ type: 'approveFile' });
		}

		function rejectFile(btn) {
			const parent = btn.closest('.msg-approval');
			parent.classList.add('rejected');
			parent.querySelector('.approval-actions').innerHTML = '<span class="status-rejected">❌ Refusée</span>';
			vscode.postMessage({ type: 'rejectFile' });
		}

		// ── Event delegation for dynamic items ──
		history.addEventListener('click', (e) => {
			const btn = e.target.closest('button');
			if (!btn) return;
			
			if (btn.classList.contains('code-block-copy')) {
				copyCode(btn);
			} else if (btn.classList.contains('approve-cmd-btn')) {
				approveCommand(btn);
			} else if (btn.classList.contains('reject-cmd-btn')) {
				rejectCommand(btn);
			} else if (btn.classList.contains('approve-file-btn')) {
				approveFile(btn);
			} else if (btn.classList.contains('reject-file-btn')) {
				rejectFile(btn);
			}
		});

		// ── Event listeners ─────────────────
		settingsToggle.addEventListener('click', () => {
			settingsPanel.style.display = settingsPanel.style.display === 'flex' ? 'none' : 'flex';
			if (settingsPanel.style.display === 'flex') {
				auditPanel.style.display = 'none';
			}
		});

		auditToggle.addEventListener('click', () => {
			auditPanel.style.display = auditPanel.style.display === 'flex' ? 'none' : 'flex';
			if (auditPanel.style.display === 'flex') {
				settingsPanel.style.display = 'none';
			}
		});

		auditTestsCheckbox.addEventListener('change', () => {
			auditTestCmdInput.style.display = auditTestsCheckbox.checked ? 'block' : 'none';
		});

		auditCognitiveCheckbox.addEventListener('change', () => {
			auditCognitiveThresholdContainer.style.display = auditCognitiveCheckbox.checked ? 'flex' : 'none';
		});

		runAuditBtn.addEventListener('click', () => {
			vscode.postMessage({
				type: 'runAudit',
				options: {
					checkArchitecture: auditArchCheckbox.checked,
					codeReview: auditCodeCheckbox.checked,
					runTests: auditTestsCheckbox.checked,
					testCommand: auditTestCmdInput.value.trim(),
					selfCorrect: auditCorrectCheckbox.checked,
					checkCognitiveComplexity: auditCognitiveCheckbox.checked,
					cognitiveComplexityThreshold: parseInt(auditCognitiveThresholdInput.value, 10) || 15
				}
			});
			auditPanel.style.display = 'none';
		});

		modelSelect.addEventListener('change', () => {
			customModelInput.style.display = modelSelect.value === 'custom' ? 'block' : 'none';
		});

		saveBtn.addEventListener('click', () => {
			let selectedModel = modelSelect.value;
			if (selectedModel === 'custom') {
				selectedModel = customModelInput.value.trim() || 'gpt-5-5';
			}

			vscode.postMessage({
				type: 'saveSettings',
				apiKey: apiKeyInput.value.trim(),
				apiUrl: apiUrlInput.value.trim(),
				model: selectedModel,
				commandApprovalMode: commandApprovalInput.value,
				fileApprovalMode: fileApprovalInput.value
			});
			autoApproveCheckbox.checked = (fileApprovalInput.value === 'acceptAll');
			settingsPanel.style.display = 'none';
		});

		autoApproveCheckbox.addEventListener('change', () => {
			const mode = autoApproveCheckbox.checked ? 'acceptAll' : 'prompt';
			fileApprovalInput.value = mode;
			vscode.postMessage({
				type: 'updateFileApprovalMode',
				value: mode
			});
		});

		fileApprovalInput.addEventListener('change', () => {
			autoApproveCheckbox.checked = (fileApprovalInput.value === 'acceptAll');
		});

		resetBtn.addEventListener('click', () => {
			history.innerHTML = '';
			statusEl = null;
			vscode.postMessage({ type: 'resetChat' });
		});

		sendBtn.addEventListener('click', () => {
			const text = input.value.trim();
			if (text) {
				vscode.postMessage({ type: 'chat', value: text });
				input.value = '';
			}
		});

		input.addEventListener('keypress', (e) => {
			if (e.key === 'Enter' && !sendBtn.disabled) sendBtn.click();
		});

		// ── Messages from extension ─────────
		window.addEventListener('message', event => {
			const msg = event.data;
			switch (msg.type) {
				case 'initSettings':
					apiKeyInput.value = msg.apiKey;
					apiUrlInput.value = msg.apiUrl;
					
					const stdModels = ['gpt-5-5', 'gpt-5-codex', 'gpt-5.1-codex'];
					if (stdModels.includes(msg.model)) {
						modelSelect.value = msg.model;
						customModelInput.style.display = 'none';
					} else {
						modelSelect.value = 'custom';
						customModelInput.value = msg.model;
						customModelInput.style.display = 'block';
					}
					
					commandApprovalInput.value = msg.commandApprovalMode;
					fileApprovalInput.value = msg.fileApprovalMode;
					autoApproveCheckbox.checked = (msg.fileApprovalMode === 'acceptAll');
					break;

				case 'userMessage':
					appendMessage('You: ' + msg.value, 'msg-user');
					break;

				case 'response':
					clearStatus();
					appendMessage('Zelos: ' + msg.value, 'msg-agent');
					break;

				case 'tool_action':
					clearStatus();
					appendMessage('Zelos: ' + msg.value, 'msg-agent');
					break;

				case 'status':
					setStatus(msg.value);
					break;

				case 'error':
					clearStatus();
					appendMessage(msg.value, 'msg-error');
					break;

				case 'lock':
					setLocked(true);
					break;

				case 'unlock':
					setLocked(false);
					clearStatus();
					break;

				case 'requestCommandApproval': {
					clearStatus();
					const div = document.createElement('div');
					div.className = 'msg msg-approval';
					div.innerHTML = 
						'<div class="approval-header">💻 <strong>Autorisation de Commande</strong></div>' +
						'<div class="approval-body">' +
							'Voulez-vous autoriser Zelos à exécuter la commande suivante ?' +
							'<pre><code>' + escapeHtml(msg.command) + '</code></pre>' +
						'</div>' +
						'<div class="approval-actions">' +
							'<button class="approve-btn approve-cmd-btn">Autoriser</button>' +
							'<button class="reject-btn reject-cmd-btn">Refuser</button>' +
						'</div>';
					history.appendChild(div);
					history.scrollTop = history.scrollHeight;
					break;
				}

				case 'requestFileApproval': {
					clearStatus();
					const div = document.createElement('div');
					div.className = 'msg msg-approval';
					
					// Safe preview of proposed content (first 30 lines)
					const lines = msg.content.split('\\n');
					const previewLines = lines.slice(0, 30);
					let previewText = previewLines.join('\\n');
					if (lines.length > 30) {
						previewText += '\\n... (tronqué)';
					}
					
					div.innerHTML = 
						'<div class="approval-header">📄 <strong>Autorisation d\u2019Écriture de Fichier</strong></div>' +
						'<div class="approval-body">' +
							'Voulez-vous autoriser Zelos à écrire dans le fichier <code>' + escapeHtml(msg.path) + '</code> ?' +
							'<pre><code>' + escapeHtml(previewText) + '</code></pre>' +
						'</div>' +
						'<div class="approval-actions">' +
							'<button class="approve-btn approve-file-btn">Accepter</button>' +
							'<button class="reject-btn reject-file-btn">Refuser</button>' +
						'</div>';
					history.appendChild(div);
					history.scrollTop = history.scrollHeight;
					break;
				}
			}
		});
	</script>
</body>
</html>`;
	}
}

function getNonce() {
	let text = '';
	const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	for (let i = 0; i < 32; i++) {
		text += possible.charAt(Math.floor(Math.random() * possible.length));
	}
	return text;
}
