import * as vscode from 'vscode';
import { ModelProvider } from './ModelProvider';

// ── Types ────────────────────────────────────────────────────────────

export interface CriticSubAgent {
	id: string;
	name: string;
	role: string;
	model: string;
	enabled: boolean;
}

export interface CriticResult {
	agentId: string;
	agentName: string;
	role: string;
	critique: string;
	severity: 'info' | 'warning' | 'critical';
}

// ── Role System Prompts ──────────────────────────────────────────────

const ROLE_PROMPTS: Record<string, string> = {
	'architect': [
		'You are a **Software Architect** critic.',
		'Focus on: code structure, design patterns, separation of concerns, modularity, coupling/cohesion, scalability, and SOLID principles.',
		'Flag any architectural anti-patterns, god classes, circular dependencies, or missing abstractions.',
	].join('\n'),

	'security': [
		'You are a **Security** critic.',
		'Focus on: injection vulnerabilities (XSS, SQL injection, command injection), exposed secrets/API keys, missing input sanitization,',
		'insecure defaults, CORS misconfigurations, authentication/authorization flaws, and unsafe file operations.',
		'Rate security issues as CRITICAL severity whenever user data or system integrity is at risk.',
	].join('\n'),

	'performance': [
		'You are a **Performance** critic.',
		'Focus on: algorithmic complexity (O(n²) loops, unnecessary iterations), memory leaks, blocking operations,',
		'unnecessary re-renders, missing caching opportunities, large bundle sizes, and unoptimized database queries.',
	].join('\n'),

	'ux': [
		'You are a **UX/Design** critic.',
		'Focus on: accessibility (WCAG compliance, ARIA labels, keyboard navigation), responsive design, color contrast,',
		'user feedback mechanisms, error handling UX, loading states, and intuitive navigation flow.',
	].join('\n'),

	'testing': [
		'You are a **Testing** critic.',
		'Focus on: missing test coverage, untested edge cases, error boundary testing, missing assertions,',
		'test isolation issues, flaky test patterns, and missing integration/E2E tests for critical paths.',
	].join('\n'),

	'code-quality': [
		'You are a **Code Quality** critic.',
		'Focus on: readability, naming conventions, code duplication (DRY), missing or outdated documentation,',
		'dead code, overly complex functions (cognitive complexity), magic numbers, and inconsistent coding style.',
	].join('\n'),

	'devops': [
		'You are a **DevOps** critic.',
		'Focus on: CI/CD pipeline issues, missing environment configurations, Docker/containerization best practices,',
		'deployment scripts, infrastructure-as-code, logging/monitoring gaps, and environment variable management.',
	].join('\n'),

	'user-critique': [
		'You are a **Requirements Challenger** critic.',
		'Focus on: the user\'s original request. Challenge the user\'s ideas, highlight edge cases, missing requirements, or bad product decisions.',
		'Point out if the user\'s request is vague, unscalable, or if there is a better way to achieve their actual goal.',
	].join('\n'),
};

const ROLE_ICONS: Record<string, string> = {
	'architect': '🏗️',
	'security': '🔒',
	'performance': '⚡',
	'ux': '🎨',
	'testing': '🧪',
	'code-quality': '📏',
	'devops': '🌐',
	'user-critique': '🤔',
	'custom': '💬',
};

// ── CriticAgent ──────────────────────────────────────────────────────

export class CriticAgent {
	private _subAgents: CriticSubAgent[] = [];

	public setSubAgents(agents: CriticSubAgent[]) {
		this._subAgents = agents;
	}

	public getSubAgents(): CriticSubAgent[] {
		return this._subAgents;
	}

	public hasActiveAgents(): boolean {
		return this._subAgents.some(a => a.enabled);
	}

	public static getRoleIcon(role: string): string {
		return ROLE_ICONS[role] || ROLE_ICONS['custom'];
	}

	/**
	 * Sends the Zelos response to all active critic sub-agents in parallel
	 * and collects their critiques.
	 */
	public async reviewResponse(
		history: any[],
		userMessage: string,
		emit: (msg: string) => void
	): Promise<CriticResult[]> {
		const activeAgents = this._subAgents.filter(a => a.enabled);
		if (activeAgents.length === 0) return [];

		emit('Consulting critic agents...');

		const config = vscode.workspace.getConfiguration('zelos');
		const apiUrl = config.get<string>('api.url') || 'https://api.kie.ai';
		const apiKey = config.get<string>('api.key') || '';

		if (!apiKey) return [];

		const promises = activeAgents.map(agent =>
			this._callCritic(agent, history, userMessage, apiUrl, apiKey)
				.catch(err => {
					console.error(`Critic ${agent.name} failed:`, err);
					return null;
				})
		);

		const results = await Promise.all(promises);
		return results.filter((r): r is CriticResult => r !== null);
	}

	private async _callCritic(
		agent: CriticSubAgent,
		history: any[],
		userMessage: string,
		apiUrl: string,
		apiKey: string
	): Promise<CriticResult> {
		const rolePrompt = ROLE_PROMPTS[agent.role] || `You are a critic with the role: "${agent.role}". Focus your review on aspects related to this role.`;

		const isUserCritic = agent.role === 'user-critique';
		const taskInstruction = isUserCritic
			? 'CRITICAL: You MUST critique the USER\'S ORIGINAL REQUEST. Point out flaws, missing requirements, or bad ideas in what the user asked for. DO NOT critique Zelos\'s code.'
			: 'CRITICAL: You MUST critique WHAT ZELOS DID (its code, commands, or answers). DO NOT critique the user\'s original request.';

		const systemPrompt = [
			rolePrompt,
			'',
			'## Your Task',
			'You are reviewing a conversation between a user and an AI coding assistant called "Zelos".',
			'Your job is to provide a SHORT, constructive critique (2-5 bullet points max).',
			taskInstruction,
			'',
			'## Response Format',
			'Start your response with a severity assessment on the first line:',
			'[SEVERITY: info] — for minor suggestions and improvements',
			'[SEVERITY: warning] — for issues that should be addressed',
			'[SEVERITY: critical] — for serious problems that MUST be fixed',
			'',
			'Then provide your critique as concise bullet points.',
			'If the response looks good and you have no concerns, just say: "✅ No issues found."',
			'',
			'IMPORTANT: Keep your critique VERY short and actionable. No more than 150 words total.',
			'Do NOT rewrite the code. Just point out issues and suggest fixes briefly.',
		].join('\n');

		const recentAssistantMessages = history
			.filter(m => m.role === 'assistant')
			.slice(-4)
			.map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content))
			.join('\n\n---\n\n');

		const userContent = [
			'## User\'s Original Request',
			userMessage,
			'',
			'## Zelos\'s Actions & Responses (REVIEW THIS)',
			recentAssistantMessages.length > 6000 ? recentAssistantMessages.substring(0, 6000) + '\n...[truncated]' : recentAssistantMessages,
		].join('\n');

		const payloadHistory = [
			{ role: 'system' as const, content: systemPrompt },
			{ role: 'user' as const, content: userContent },
		];

		const fetchUrl = ModelProvider.resolveApiUrl(apiUrl, agent.model);
		const body = await ModelProvider.buildPayload(
			payloadHistory.map(m => ({ role: m.role, content: m.content })),
			agent.model
		);

		const response = await fetch(fetchUrl, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Bearer ${apiKey}`,
			},
			body: JSON.stringify(body),
		});

		if (!response.ok) {
			const errText = await response.text();
			throw new Error(`API Error for critic ${agent.name}: ${errText}`);
		}

		const responseData = await response.json();
		if (responseData && responseData.code && responseData.code !== 200 && responseData.code !== '200') {
			return {
				agentId: agent.id,
				agentName: agent.name,
				role: agent.role,
				critique: `⚠️ API Error: ${responseData.msg || 'Unknown error'} (Code ${responseData.code})`,
				severity: 'critical' as const,
			};
		}
		const reply = ModelProvider.extractReply(responseData);

		// Parse severity from the response
		let severity: 'info' | 'warning' | 'critical' = 'info';
		if (reply.includes('[SEVERITY: critical]')) severity = 'critical';
		else if (reply.includes('[SEVERITY: warning]')) severity = 'warning';

		// Clean up the severity line from the critique text
		const critique = reply
			.replace(/\[SEVERITY:\s*(info|warning|critical)\]\s*/gi, '')
			.trim();

		return {
			agentId: agent.id,
			agentName: agent.name,
			role: agent.role,
			critique,
			severity,
		};
	}
}
