import * as vscode from 'vscode';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
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
						communicationLanguage: config.get<string>('communicationLanguage') || 'English',
						codeLanguage: config.get<string>('codeLanguage') || 'English',
						visualModel: config.get<string>('api.visualModel') || 'gemini-3.5-flash',
						selectedProfile: config.get<string>('chrome.selectedProfile') || 'Default',
					});
					const profiles = this._getChromeProfiles();
					this._view?.webview.postMessage({
						type: 'chromeProfiles',
						profiles
					});
					this._updateCredits();
					break;
				}
				case 'launchChrome': {
					this._launchChrome(data.profile).then(success => {
						this._view?.webview.postMessage({
							type: 'browserStatus',
							connected: success,
							message: success ? 'Connected (Port 9222)' : 'Failed to connect. Make sure Chrome is closed.'
						});
					});
					break;
				}
				case 'checkBrowser': {
					this._checkPort9222().then(connected => {
						this._view?.webview.postMessage({
							type: 'browserStatus',
							connected,
							message: connected ? 'Connected (Port 9222)' : 'Disconnected'
						});
					});
					break;
				}
				case 'navigateUrl': {
					this._checkPort9222().then(async connected => {
						if (!connected) {
							vscode.window.showErrorMessage('Browser is not connected. Launch it first!');
							return;
						}
						try {
							const { CDPClient } = require('./CDPClient');
							const response = await fetch('http://localhost:9222/json/list');
							const targets = await response.json() as any[];
							let target = targets.find(t => t.type === 'page');
							if (!target) {
								const newResponse = await fetch('http://localhost:9222/json/new');
								target = await newResponse.json() as any;
							}
							const client = new CDPClient(target.webSocketDebuggerUrl);
							await client.connect();
							await client.navigate(data.value);
							client.close();
							vscode.window.showInformationMessage(`Navigated to ${data.value}`);
						} catch (err: any) {
							vscode.window.showErrorMessage(`Failed to navigate: ${err.message}`);
						}
					});
					break;
				}
				case 'chat': {
					this._handleChatMessage(data.value, data.image);
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
						config.update('api.url', data.apiUrl, true),
						config.update('commandApprovalMode', data.commandApprovalMode, true),
						config.update('fileApprovalMode', data.fileApprovalMode, true),
						config.update('communicationLanguage', data.communicationLanguage, true),
						config.update('codeLanguage', data.codeLanguage, true),
						config.update('api.visualModel', data.visualModel, true),
						config.update('chrome.selectedProfile', data.selectedProfile, true),
					]).then(() => {
						vscode.window.showInformationMessage('Zelos settings saved!');
						this._updateCredits();
					});
					break;
				}
				case 'updateModel': {
					const config = vscode.workspace.getConfiguration('zelos');
					config.update('api.model', data.value, true);
					break;
				}
				case 'updateVisualModel': {
					const config = vscode.workspace.getConfiguration('zelos');
					config.update('api.visualModel', data.value, true);
					break;
				}
				case 'updateSelectedProfile': {
					const config = vscode.workspace.getConfiguration('zelos');
					config.update('chrome.selectedProfile', data.value, true);
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
				case 'refreshCredits': {
					this._updateCredits();
					break;
				}
			}
		});
	}

	private async _handleChatMessage(message: string, base64Image?: string) {
		if (!this._view) return;
		this._view.webview.postMessage({ type: 'userMessage', value: message, image: base64Image });
		await this._agent.handleUserMessage(message, base64Image);
		this._updateCredits();
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
		this._view.webview.postMessage({ type: 'userMessage', value: 'Starting Workspace Audit...' });
		await this._agent.runAudit(options);
		this._updateCredits();
	}

	private async _updateCredits() {
		const config = vscode.workspace.getConfiguration('zelos');
		const apiUrl = config.get<string>('api.url') || 'https://api.kie.ai';
		const apiKey = config.get<string>('api.key') || '';

		if (!apiKey) {
			this._view?.webview.postMessage({ type: 'creditUpdate', value: null });
			return;
		}

		try {
			const cleanUrl = apiUrl.replace(/\/+$/, '');
			let creditUrl: string;
			if (cleanUrl.includes('api.kie.ai')) {
				creditUrl = 'https://api.kie.ai/api/v1/chat/credit';
			} else {
				if (cleanUrl.endsWith('/codex/v1/responses')) {
					creditUrl = cleanUrl.replace('/codex/v1/responses', '/api/v1/chat/credit');
				} else if (cleanUrl.endsWith('/api/v1/responses')) {
					creditUrl = cleanUrl.replace('/api/v1/responses', '/api/v1/chat/credit');
				} else {
					creditUrl = cleanUrl + '/api/v1/chat/credit';
				}
			}

			const response = await fetch(creditUrl, {
				method: 'GET',
				headers: {
					'Authorization': `Bearer ${apiKey}`,
					'Content-Type': 'application/json'
				}
			});

			if (response.ok) {
				const data = (await response.json()) as any;
				if (data && data.code === 200) {
					const credits = data.data;
					this._view?.webview.postMessage({ type: 'creditUpdate', value: credits });
				} else {
					console.error('Failed to get credit balance:', data?.msg || 'unknown error');
					this._view?.webview.postMessage({ type: 'creditUpdate', value: null });
				}
			} else {
				this._view?.webview.postMessage({ type: 'creditUpdate', value: null });
			}
		} catch (err) {
			console.error('Error fetching credits:', err);
			this._view?.webview.postMessage({ type: 'creditUpdate', value: null });
		}
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
		#credit-badge {
			margin-right: auto;
			display: none;
			align-items: center;
			gap: 6px;
			font-size: 12px;
			font-weight: 600;
			padding: 4px 10px;
			border-radius: 20px;
			background: linear-gradient(135deg, hsla(var(--accent-hue), 75%, 45%, 0.15), hsla(var(--accent-hue), 75%, 45%, 0.05));
			border: 1px solid var(--accent-glow);
			color: var(--accent);
			cursor: pointer;
			transition: all 0.2s ease;
		}
		#credit-badge:hover {
			background: linear-gradient(135deg, hsla(var(--accent-hue), 75%, 45%, 0.25), hsla(var(--accent-hue), 75%, 45%, 0.1));
			transform: translateY(-1px);
			box-shadow: 0 2px 8px var(--accent-glow);
		}
		#credit-badge:active {
			transform: translateY(0);
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
			gap: 6px;
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
		#model-input {
			background: var(--vscode-input-background);
			color: var(--vscode-input-foreground);
			border: 1px solid var(--vscode-input-border, var(--border-color));
			padding: 8px 6px;
			border-radius: 4px;
			font-family: var(--font-sans);
			font-size: 12px;
			outline: none;
			cursor: pointer;
			max-width: 140px;
			transition: border-color 0.2s;
		}
		#model-input:focus {
			border-color: var(--vscode-focusBorder);
		}
		#custom-model-input {
			background: var(--vscode-input-background);
			color: var(--vscode-input-foreground);
			border: 1px solid var(--vscode-input-border, var(--border-color));
			padding: 8px 10px;
			border-radius: 4px;
			font-family: var(--font-sans);
			font-size: 12px;
			outline: none;
			max-width: 120px;
			transition: border-color 0.2s;
		}
		#custom-model-input:focus {
			border-color: var(--vscode-focusBorder);
		}
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

		#attach-image-btn {
			background: none;
			color: var(--vscode-foreground);
			border: 1px solid var(--border-color);
			padding: 8px 10px;
			cursor: pointer;
			border-radius: 4px;
			display: flex;
			align-items: center;
			justify-content: center;
			transition: all 0.2s ease;
		}
		#attach-image-btn:hover {
			background: var(--vscode-toolbar-hoverBackground);
			border-color: var(--vscode-focusBorder);
		}
	</style>
</head>
<body>
	<div id="top-bar">
		<div id="credit-badge" title="Click to refresh balance">
			<span class="credit-icon" style="display: inline-block; vertical-align: middle;"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: middle;"><circle cx="12" cy="12" r="10"></circle><path d="M12 6v12M15 9H11.5a2.5 2.5 0 0 0 0 5h3a2.5 2.5 0 0 1 0 5H9"></path></svg></span>
			<span id="credit-value">--</span>
			<span style="font-size: 10px; opacity: 0.8; font-weight: 400;">credits</span>
		</div>
		<button class="top-btn" id="reset-btn" title="New conversation"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: middle;"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg> Reset</button>
		<button class="top-btn" id="settings-toggle" title="Settings"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: middle;"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg> Settings</button>
		<button class="top-btn" id="audit-toggle" title="Review & Test Workspace"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: middle;"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg> Audit</button>
		<button class="top-btn" id="browser-toggle" title="Browser Control"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: middle;"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect><line x1="2" y1="10" x2="22" y2="10"></line><path d="M8 21h8M12 17v4"></path></svg> Browser</button>
	</div>

	<div id="browser-panel" style="display: none; flex-direction: column; gap: 10px; padding: 12px; background: var(--card-bg); border: 1px solid var(--border-color); margin-bottom: 8px; border-radius: 6px; box-shadow: 0 4px 12px rgba(0,0,0,0.15); animation: slideDown 0.25s ease-out;">
		<div class="browser-header">
			<h3 style="font-size: 13px; font-weight: 600; margin-bottom: 4px; color: var(--accent);">Chrome CDP Browser Control</h3>
			<p style="font-size: 11px; color: var(--vscode-descriptionForeground); margin-bottom: 4px; line-height: 1.35;">Launch Chrome in debug mode to enable visual reviews by the Navigation Agent.</p>
		</div>
		<div class="setting-row" style="display: flex; flex-direction: column; gap: 4px;">
			<label style="font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; color: var(--vscode-descriptionForeground);">Chrome Profile</label>
			<select id="chrome-profile-select" style="background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, var(--border-color)); padding: 6px; border-radius: 4px; font-family: var(--font-sans); font-size: 12px; outline: none;">
				<option value="Default">Default</option>
			</select>
		</div>
		<div class="setting-row" style="display: flex; flex-direction: column; gap: 4px;">
			<label style="font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; color: var(--vscode-descriptionForeground);">Visual Review Model</label>
			<select id="visual-model-input" style="background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, var(--border-color)); padding: 6px; border-radius: 4px; font-family: var(--font-sans); font-size: 12px; outline: none;">
				<option value="gemini-3.5-flash">Gemini 3.5 Flash</option>
				<option value="gemini-3-flash-v1beta">Gemini 3 Flash (v1beta)</option>
				<option value="gemini-2.5-pro-openai">Gemini 2.5 Pro (openai)</option>
				<option value="gemini-3-pro-openai">Gemini 3 Pro (openai)</option>
				<option value="gemini-3.1-pro-openai">Gemini 3.1 Pro (openai)</option>
				<option value="gemini-2.5-flash-openai">Gemini 2.5 Flash (openai)</option>
				<option value="gemini-3-flash-openai">Gemini 3 Flash (openai)</option>
				<option value="gemini-3.5-flash-openai">Gemini 3.5 Flash (openai)</option>
				<option value="gpt-5-5">gpt-5-5</option>
				<option value="gpt-5-4">gpt-5-4</option>
				<option value="gpt-5-2">gpt-5-2</option>
				<option value="gpt-5-codex">gpt-5-codex</option>
				<option value="gpt-5.1-codex">gpt-5.1-codex</option>
				<option value="gpt-5.2-codex">gpt-5.2-codex</option>
				<option value="gpt-5.3-codex">gpt-5.3-codex</option>
				<option value="gpt-5.4-codex">gpt-5.4-codex</option>
				<option value="claude-opus-4-7">Claude Opus 4.7</option>
				<option value="claude-opus-4-8">Claude Opus 4.8</option>
				<option value="cluade-fable-5">Claude Fable 5</option>
				<option value="claude-haiku-4-5">Claude Haiku 4.5</option>
				<option value="claude-opus-4-5">Claude Opus 4.5</option>
				<option value="claude-opus-4-6">Claude Opus 4.6</option>
				<option value="claude-sonnet-4-5">Claude Sonnet 4.5</option>
				<option value="claude-sonnet-4-6">Claude Sonnet 4.6</option>
				<option value="custom">Other...</option>
			</select>
			<input type="text" id="custom-visual-model-input" placeholder="model-name" style="display: none; margin-top: 4px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, var(--border-color)); padding: 6px; border-radius: 4px; font-family: var(--font-sans); font-size: 12px; outline: none;" title="Enter custom visual model" />
		</div>
		<div class="browser-status-row" style="font-size: 12px; display: flex; align-items: center; gap: 6px; margin: 4px 0;">
			<span style="color: var(--vscode-descriptionForeground);">Status:</span>
			<span id="browser-status-text" class="status-disconnected" style="color: var(--vscode-errorForeground, #ff6b6b); font-weight: 600;">Disconnected</span>
		</div>
		<div class="browser-actions-row" style="display: flex; gap: 8px;">
			<button id="launch-browser-btn" style="background: var(--accent); color: #ffffff; border: none; padding: 6px 12px; cursor: pointer; border-radius: 4px; font-size: 12px; font-weight: 600; font-family: var(--font-sans); flex: 1; text-align: center;">Launch Browser</button>
			<button id="check-browser-btn" style="background: var(--vscode-button-secondaryBackground, #5f5f5f); color: var(--vscode-button-secondaryForeground, #ffffff); border: none; padding: 6px 12px; cursor: pointer; border-radius: 4px; font-size: 12px; font-weight: 600; font-family: var(--font-sans); flex: 1; text-align: center;">Check Port 9222</button>
		</div>
		<div class="setting-row" style="display: flex; flex-direction: column; gap: 4px; margin-top: 4px;">
			<label style="font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; color: var(--vscode-descriptionForeground);">Quick Navigate Tab</label>
			<div style="display: flex; gap: 6px;">
				<input type="text" id="browser-navigate-url" placeholder="http://localhost:3000" style="flex: 1; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, var(--border-color)); padding: 6px; border-radius: 4px; font-family: var(--font-sans); font-size: 12px; outline: none;" />
				<button id="browser-navigate-btn" style="background: var(--accent); color: #ffffff; border: none; padding: 6px 10px; cursor: pointer; border-radius: 4px; font-size: 12px; font-weight: 600; font-family: var(--font-sans);">Go</button>
			</div>
		</div>
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
			<label for="command-approval-input">Command Approval Mode</label>
			<select id="command-approval-input">
				<option value="prompt">Always Prompt</option>
				<option value="acceptAll">Allow All Automatically</option>
				<option value="rejectAll">Reject All Automatically</option>
			</select>
		</div>
		<div class="setting-row">
			<label for="file-approval-input">File Write Approval Mode</label>
			<select id="file-approval-input">
				<option value="prompt">Always Prompt</option>
				<option value="acceptAll">Allow All Automatically</option>
				<option value="rejectAll">Reject All Automatically</option>
			</select>
		</div>
		<div class="setting-row">
			<label for="communication-language-input">Communication Language</label>
			<select id="communication-language-input">
				<option value="English">English</option>
				<option value="French">French</option>
				<option value="Spanish">Spanish</option>
				<option value="German">German</option>
				<option value="Italian">Italian</option>
				<option value="Portuguese">Portuguese</option>
				<option value="Japanese">Japanese</option>
				<option value="Chinese">Chinese</option>
			</select>
		</div>
		<div class="setting-row">
			<label for="code-language-input">Code Language</label>
			<select id="code-language-input">
				<option value="English">English</option>
				<option value="French">French</option>
				<option value="Spanish">Spanish</option>
				<option value="German">German</option>
				<option value="Italian">Italian</option>
				<option value="Portuguese">Portuguese</option>
				<option value="Japanese">Japanese</option>
				<option value="Chinese">Chinese</option>
			</select>
		</div>

		<button id="save-settings-button">Save Settings</button>
	</div>

	<div id="audit-panel">
		<div class="audit-header">
			<h3>Workspace Audit & Self-Correction</h3>
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

	<!-- Image Preview Panel -->
	<div id="image-preview-container" style="display: none; align-items: center; gap: 8px; margin-bottom: 8px; padding: 6px; background: var(--card-bg); border: 1px solid var(--border-color); border-radius: 6px; position: relative;">
		<img id="image-preview" style="max-height: 50px; border-radius: 4px;" alt="Preview" />
		<span id="image-preview-name" style="font-size: 11px; color: var(--vscode-descriptionForeground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 150px;"></span>
		<button id="image-preview-clear" style="background: none; border: none; color: var(--vscode-errorForeground, #ff6b6b); cursor: pointer; font-size: 14px; font-weight: bold; margin-left: auto; padding: 0 4px;" title="Clear image">&times;</button>
	</div>

	<div id="input-container">
		<input type="file" id="image-attachment-input" accept="image/*" style="display: none;" />
		<button id="attach-image-btn" title="Attach Image">
			<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: middle;">
				<rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
				<circle cx="8.5" cy="8.5" r="1.5"></circle>
				<polyline points="21 15 16 10 5 21"></polyline>
			</svg>
		</button>
		<input type="text" id="message-input" placeholder="Ask Zelos..." />
		<select id="model-input" title="Choose AI Model">
			<option value="gpt-5-5">gpt-5-5</option>
			<option value="gpt-5-4">gpt-5-4</option>
			<option value="gpt-5-2">gpt-5-2</option>
			<option value="gpt-5-codex">gpt-5-codex</option>
			<option value="gpt-5.1-codex">gpt-5.1-codex</option>
			<option value="gpt-5.2-codex">gpt-5.2-codex</option>
			<option value="gpt-5.3-codex">gpt-5.3-codex</option>
			<option value="gpt-5.4-codex">gpt-5.4-codex</option>
			<option value="claude-opus-4-7">claude-opus-4-7</option>
			<option value="claude-opus-4-8">claude-opus-4-8</option>
			<option value="cluade-fable-5">cluade-fable-5</option>
			<option value="claude-haiku-4-5">claude-haiku-4-5</option>
			<option value="claude-opus-4-5">claude-opus-4-5</option>
			<option value="claude-opus-4-6">claude-opus-4-6</option>
			<option value="claude-sonnet-4-5">claude-sonnet-4-5</option>
			<option value="claude-sonnet-4-6">claude-sonnet-4-6</option>
			<option value="gemini-3.5-flash">gemini-3.5-flash</option>
			<option value="gemini-3-flash-v1beta">gemini-3-flash-v1beta</option>
			<option value="gemini-2.5-pro-openai">gemini-2.5-pro (openai)</option>
			<option value="gemini-3-pro-openai">gemini-3-pro (openai)</option>
			<option value="gemini-3.1-pro-openai">gemini-3.1-pro (openai)</option>
			<option value="gemini-2.5-flash-openai">gemini-2.5-flash (openai)</option>
			<option value="gemini-3-flash-openai">gemini-3-flash (openai)</option>
			<option value="gemini-3.5-flash-openai">gemini-3.5-flash (openai)</option>
			<option value="custom">Other...</option>
		</select>
		<input type="text" id="custom-model-input" placeholder="model-name" style="display: none;" title="Enter custom model" />
		<div class="toggle-container" title="Auto-approve file creation/modifications (no confirmation prompts)">
			<input type="checkbox" id="auto-approve-file-checkbox" class="toggle-checkbox" />
			<label for="auto-approve-file-checkbox" class="toggle-label" title="Auto-approve file creation">
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

		const attachBtn = document.getElementById('attach-image-btn');
		const fileInput = document.getElementById('image-attachment-input');
		const previewContainer = document.getElementById('image-preview-container');
		const previewImg = document.getElementById('image-preview');
		const previewName = document.getElementById('image-preview-name');
		const previewClear = document.getElementById('image-preview-clear');
		let attachedImageBase64 = null;

		const settingsToggle = document.getElementById('settings-toggle');
		const settingsPanel = document.getElementById('settings-panel');
		const apiKeyInput = document.getElementById('api-key-input');
		const apiUrlInput = document.getElementById('api-url-input');
		const modelSelect = document.getElementById('model-input');
		const customModelInput = document.getElementById('custom-model-input');
		const commandApprovalInput = document.getElementById('command-approval-input');
		const fileApprovalInput = document.getElementById('file-approval-input');
		const communicationLanguageInput = document.getElementById('communication-language-input');
		const codeLanguageInput = document.getElementById('code-language-input');
		const saveBtn = document.getElementById('save-settings-button');
		const resetBtn = document.getElementById('reset-btn');
		const creditBadge = document.getElementById('credit-badge');
		const creditValue = document.getElementById('credit-value');

		const browserToggle = document.getElementById('browser-toggle');
		const browserPanel = document.getElementById('browser-panel');
		const chromeProfileSelect = document.getElementById('chrome-profile-select');
		const browserStatusText = document.getElementById('browser-status-text');
		const launchBrowserBtn = document.getElementById('launch-browser-btn');
		const checkBrowserBtn = document.getElementById('check-browser-btn');
		const browserNavigateUrl = document.getElementById('browser-navigate-url');
		const browserNavigateBtn = document.getElementById('browser-navigate-btn');
		const visualModelSelect = document.getElementById('visual-model-input');
		const customVisualModelInput = document.getElementById('custom-visual-model-input');

		creditBadge.addEventListener('click', () => {
			creditValue.textContent = '--';
			vscode.postMessage({ type: 'refreshCredits' });
		});
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
		function appendMessage(text, cls, image) {
			const div = document.createElement('div');
			div.className = 'msg ' + cls;
			if (cls === 'msg-user') {
				const textDiv = document.createElement('div');
				textDiv.textContent = text;
				div.appendChild(textDiv);
				if (image) {
					const img = document.createElement('img');
					img.src = image;
					img.style.maxWidth = '100%';
					img.style.maxHeight = '150px';
					img.style.borderRadius = '6px';
					img.style.marginTop = '6px';
					img.style.display = 'block';
					img.style.border = '1px solid var(--border-color)';
					div.appendChild(img);
				}
			} else if (cls === 'msg-status' || cls === 'msg-error') {
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
			parent.querySelector('.approval-actions').innerHTML = '<span class="status-approved">Approved (Executing...)</span>';
			vscode.postMessage({ type: 'approveCommand' });
		}

		function rejectCommand(btn) {
			const parent = btn.closest('.msg-approval');
			parent.classList.add('rejected');
			parent.querySelector('.approval-actions').innerHTML = '<span class="status-rejected">Rejected</span>';
			vscode.postMessage({ type: 'rejectCommand' });
		}

		function approveFile(btn) {
			const parent = btn.closest('.msg-approval');
			parent.classList.add('approved');
			parent.querySelector('.approval-actions').innerHTML = '<span class="status-approved">Approved (Writing...)</span>';
			vscode.postMessage({ type: 'approveFile' });
		}

		function rejectFile(btn) {
			const parent = btn.closest('.msg-approval');
			parent.classList.add('rejected');
			parent.querySelector('.approval-actions').innerHTML = '<span class="status-rejected">Rejected</span>';
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
				browserPanel.style.display = 'none';
			}
		});

		auditToggle.addEventListener('click', () => {
			auditPanel.style.display = auditPanel.style.display === 'flex' ? 'none' : 'flex';
			if (auditPanel.style.display === 'flex') {
				settingsPanel.style.display = 'none';
				browserPanel.style.display = 'none';
			}
		});

		browserToggle.addEventListener('click', () => {
			browserPanel.style.display = browserPanel.style.display === 'flex' ? 'none' : 'flex';
			if (browserPanel.style.display === 'flex') {
				settingsPanel.style.display = 'none';
				auditPanel.style.display = 'none';
				vscode.postMessage({ type: 'checkBrowser' });
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

		function saveSelectedModel() {
			let selectedModel = modelSelect.value;
			if (selectedModel === 'custom') {
				selectedModel = customModelInput.value.trim() || 'gpt-5-5';
			}
			vscode.postMessage({
				type: 'updateModel',
				value: selectedModel
			});
		}

		modelSelect.addEventListener('change', () => {
			if (modelSelect.value === 'custom') {
				customModelInput.style.display = 'block';
				customModelInput.focus();
			} else {
				customModelInput.style.display = 'none';
				saveSelectedModel();
			}
		});

		customModelInput.addEventListener('blur', () => {
			saveSelectedModel();
		});

		customModelInput.addEventListener('keypress', (e) => {
			if (e.key === 'Enter') {
				saveSelectedModel();
				customModelInput.blur();
			}
		});

		function saveSelectedVisualModel() {
			let selectedModel = visualModelSelect.value;
			if (selectedModel === 'custom') {
				selectedModel = customVisualModelInput.value.trim() || 'gemini-3.5-flash';
			}
			vscode.postMessage({
				type: 'updateVisualModel',
				value: selectedModel
			});
		}

		visualModelSelect.addEventListener('change', () => {
			if (visualModelSelect.value === 'custom') {
				customVisualModelInput.style.display = 'block';
				customVisualModelInput.focus();
			} else {
				customVisualModelInput.style.display = 'none';
				saveSelectedVisualModel();
			}
		});

		customVisualModelInput.addEventListener('blur', () => {
			saveSelectedVisualModel();
		});

		customVisualModelInput.addEventListener('keypress', (e) => {
			if (e.key === 'Enter') {
				saveSelectedVisualModel();
				customVisualModelInput.blur();
			}
		});

		chromeProfileSelect.addEventListener('change', () => {
			vscode.postMessage({
				type: 'updateSelectedProfile',
				value: chromeProfileSelect.value
			});
		});

		launchBrowserBtn.addEventListener('click', () => {
			browserStatusText.textContent = 'Launching...';
			browserStatusText.className = 'status-disconnected';
			vscode.postMessage({
				type: 'launchChrome',
				profile: chromeProfileSelect.value
			});
		});

		checkBrowserBtn.addEventListener('click', () => {
			browserStatusText.textContent = 'Checking...';
			vscode.postMessage({ type: 'checkBrowser' });
		});

		browserNavigateBtn.addEventListener('click', () => {
			const url = browserNavigateUrl.value.trim();
			if (url) {
				vscode.postMessage({ type: 'navigateUrl', value: url });
			}
		});

		browserNavigateUrl.addEventListener('keypress', (e) => {
			if (e.key === 'Enter') browserNavigateBtn.click();
		});

		saveBtn.addEventListener('click', () => {
			let visualModel = visualModelSelect.value;
			if (visualModel === 'custom') {
				visualModel = customVisualModelInput.value.trim() || 'gemini-3.5-flash';
			}
			vscode.postMessage({
				type: 'saveSettings',
				apiKey: apiKeyInput.value.trim(),
				apiUrl: apiUrlInput.value.trim(),
				commandApprovalMode: commandApprovalInput.value,
				fileApprovalMode: fileApprovalInput.value,
				communicationLanguage: communicationLanguageInput.value,
				codeLanguage: codeLanguageInput.value,
				visualModel: visualModel,
				selectedProfile: chromeProfileSelect.value
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

		attachBtn.addEventListener('click', () => {
			fileInput.click();
		});

		fileInput.addEventListener('change', (e) => {
			const file = e.target.files[0];
			if (!file) return;

			const reader = new FileReader();
			reader.onload = (evt) => {
				attachedImageBase64 = evt.target.result;
				previewImg.src = attachedImageBase64;
				previewName.textContent = file.name;
				previewContainer.style.display = 'flex';
			};
			reader.readAsDataURL(file);
		});

		previewClear.addEventListener('click', () => {
			attachedImageBase64 = null;
			fileInput.value = '';
			previewContainer.style.display = 'none';
			previewImg.src = '';
			previewName.textContent = '';
		});

		resetBtn.addEventListener('click', () => {
			history.innerHTML = '';
			statusEl = null;
			vscode.postMessage({ type: 'resetChat' });
		});

		sendBtn.addEventListener('click', () => {
			const text = input.value.trim();
			if (text || attachedImageBase64) {
				vscode.postMessage({
					type: 'chat',
					value: text,
					image: attachedImageBase64
				});
				input.value = '';
				
				// Clear attachment
				attachedImageBase64 = null;
				fileInput.value = '';
				previewContainer.style.display = 'none';
				previewImg.src = '';
				previewName.textContent = '';
			}
		});

		input.addEventListener('keypress', (e) => {
			if (e.key === 'Enter' && !sendBtn.disabled) sendBtn.click();
		});

		// ── Messages from extension ─────────
		window.addEventListener('message', event => {
			const msg = event.data;
			switch (msg.type) {
				case 'creditUpdate':
					if (msg.value !== null && msg.value !== undefined) {
						creditValue.textContent = msg.value;
						creditBadge.style.display = 'flex';
					} else {
						creditBadge.style.display = 'none';
					}
					break;

				case 'initSettings':
					apiKeyInput.value = msg.apiKey;
					apiUrlInput.value = msg.apiUrl;
					
					const stdModels = [
						'gpt-5-5', 'gpt-5-4', 'gpt-5-2', 'gpt-5-codex', 'gpt-5.1-codex', 'gpt-5.2-codex', 'gpt-5.3-codex', 'gpt-5.4-codex',
						'claude-opus-4-7', 'claude-opus-4-8', 'cluade-fable-5', 'claude-haiku-4-5', 'claude-opus-4-5', 'claude-opus-4-6', 'claude-sonnet-4-5', 'claude-sonnet-4-6',
						'gemini-3.5-flash', 'gemini-3-flash-v1beta',
						'gemini-2.5-pro-openai', 'gemini-3-pro-openai', 'gemini-3.1-pro-openai', 'gemini-2.5-flash-openai', 'gemini-3-flash-openai', 'gemini-3.5-flash-openai'
					];
					if (stdModels.includes(msg.model)) {
						modelSelect.value = msg.model;
						customModelInput.style.display = 'none';
					} else {
						modelSelect.value = 'custom';
						customModelInput.value = msg.model;
						customModelInput.style.display = 'block';
					}

					const stdVisualModels = [
						'gemini-3.5-flash', 'gemini-3-flash-v1beta',
						'gemini-2.5-pro-openai', 'gemini-3-pro-openai', 'gemini-3.1-pro-openai', 'gemini-2.5-flash-openai', 'gemini-3-flash-openai', 'gemini-3.5-flash-openai',
						'gpt-5-5', 'gpt-5-4', 'gpt-5-2', 'gpt-5-codex', 'gpt-5.1-codex', 'gpt-5.2-codex', 'gpt-5.3-codex', 'gpt-5.4-codex',
						'claude-opus-4-7', 'claude-opus-4-8', 'cluade-fable-5', 'claude-haiku-4-5', 'claude-opus-4-5', 'claude-opus-4-6', 'claude-sonnet-4-5', 'claude-sonnet-4-6'
					];
					if (stdVisualModels.includes(msg.visualModel)) {
						visualModelSelect.value = msg.visualModel;
						customVisualModelInput.style.display = 'none';
					} else {
						visualModelSelect.value = 'custom';
						customVisualModelInput.value = msg.visualModel;
						customVisualModelInput.style.display = 'block';
					}
					
					commandApprovalInput.value = msg.commandApprovalMode;
					fileApprovalInput.value = msg.fileApprovalMode;
					autoApproveCheckbox.checked = (msg.fileApprovalMode === 'acceptAll');
					communicationLanguageInput.value = msg.communicationLanguage || 'English';
					codeLanguageInput.value = msg.codeLanguage || 'English';
					break;

				case 'chromeProfiles':
					chromeProfileSelect.innerHTML = '';
					if (msg.profiles && msg.profiles.length > 0) {
						msg.profiles.forEach(p => {
							const opt = document.createElement('option');
							opt.value = p.id;
							opt.textContent = p.name + ' (' + p.id + ')';
							chromeProfileSelect.appendChild(opt);
						});
					} else {
						const opt = document.createElement('option');
						opt.value = 'Default';
						opt.textContent = 'Default';
						chromeProfileSelect.appendChild(opt);
					}
					break;

				case 'browserStatus':
					browserStatusText.textContent = msg.message;
					if (msg.connected) {
						browserStatusText.className = 'status-connected';
						browserStatusText.style.color = 'var(--accent)';
					} else {
						browserStatusText.className = 'status-disconnected';
						browserStatusText.style.color = 'var(--vscode-errorForeground, #ff6b6b)';
					}
					break;

				case 'userMessage':
					appendMessage('You: ' + msg.value, 'msg-user', msg.image);
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
						'<div class="approval-header"><strong>Command Approval Required</strong></div>' +
						'<div class="approval-body">' +
							'Do you want to authorize Zelos to execute the following command?' +
							'<pre><code>' + escapeHtml(msg.command) + '</code></pre>' +
						'</div>' +
						'<div class="approval-actions">' +
							'<button class="approve-btn approve-cmd-btn">Approve</button>' +
							'<button class="reject-btn reject-cmd-btn">Reject</button>' +
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
						previewText += '\\n... (truncated)';
					}
					
					div.innerHTML = 
						'<div class="approval-header"><strong>File Write Approval Required</strong></div>' +
						'<div class="approval-body">' +
							'Do you want to authorize Zelos to write to the file <code>' + escapeHtml(msg.path) + '</code>?' +
							'<pre><code>' + escapeHtml(previewText) + '</code></pre>' +
						'</div>' +
						'<div class="approval-actions">' +
							'<button class="approve-btn approve-file-btn">Approve</button>' +
							'<button class="reject-btn reject-file-btn">Reject</button>' +
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

	private _getChromeProfiles(): { id: string; name: string }[] {
		const profiles: { id: string; name: string }[] = [];
		try {
			let userDataPath = '';
			if (process.platform === 'win32') {
				userDataPath = path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'User Data');
			} else if (process.platform === 'darwin') {
				userDataPath = path.join(process.env.HOME || '', 'Library', 'Application Support', 'Google', 'Chrome');
			} else {
				userDataPath = path.join(process.env.HOME || '', '.config', 'google-chrome');
			}

			const localStatePath = path.join(userDataPath, 'Local State');
			if (fs.existsSync(localStatePath)) {
				const fileContent = fs.readFileSync(localStatePath, 'utf8');
				const localState = JSON.parse(fileContent);
				const infoCache = localState.profile?.info_cache;
				if (infoCache) {
					for (const [dirName, profileInfo] of Object.entries(infoCache)) {
						const info = profileInfo as any;
						profiles.push({
							id: dirName,
							name: info.name || dirName
						});
					}
				}
			}
		} catch (err) {
			console.error('Error reading Chrome profiles:', err);
		}
		if (profiles.length === 0) {
			profiles.push({ id: 'Default', name: 'Default Profile' });
		}
		return profiles;
	}

	private _getChromeExecutablePath(): string {
		if (process.platform === 'win32') {
			const paths = [
				'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
				'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
				path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe')
			];
			for (const p of paths) {
				if (fs.existsSync(p)) return p;
			}
			return 'chrome.exe';
		} else if (process.platform === 'darwin') {
			const p = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
			if (fs.existsSync(p)) return p;
			return 'google-chrome';
		} else {
			return 'google-chrome';
		}
	}

	private async _checkPort9222(): Promise<boolean> {
		try {
			const response = await fetch('http://localhost:9222/json/list');
			return response.ok;
		} catch (_) {
			return false;
		}
	}

	private async _launchChrome(profileId: string): Promise<boolean> {
		const chromePath = this._getChromeExecutablePath();
		const args = [
			`--remote-debugging-port=9222`,
			`--profile-directory=${profileId}`
		];

		try {
			vscode.window.showInformationMessage(`Launching Chrome using profile ${profileId}...`);
			const child = spawn(chromePath, args, {
				detached: true,
				stdio: 'ignore'
			});
			child.unref();

			// Wait up to 5 seconds for port to open
			for (let i = 0; i < 10; i++) {
				await new Promise(resolve => setTimeout(resolve, 500));
				if (await this._checkPort9222()) {
					vscode.window.showInformationMessage('Chrome debug port 9222 is active!');
					return true;
				}
			}
			return false;
		} catch (err: any) {
			vscode.window.showErrorMessage(`Failed to launch Chrome: ${err.message}`);
			return false;
		}
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
