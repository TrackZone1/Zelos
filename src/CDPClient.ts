import WebSocket from 'ws';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export class CDPClient {
	private _ws?: WebSocket;
	private _messageId = 1;
	private _pendingRequests = new Map<number, { resolve: (res: any) => void; reject: (err: any) => void }>();

	constructor(private _wsUrl: string) {}

	public connect(): Promise<void> {
		return new Promise((resolve, reject) => {
			console.log('Connecting to Chrome CDP WebSocket:', this._wsUrl);
			this._ws = new WebSocket(this._wsUrl);

			this._ws.on('open', () => {
				console.log('CDP WebSocket connected!');
				resolve();
			});

			this._ws.on('error', (err) => {
				console.error('CDP WebSocket error:', err);
				reject(err);
			});

			this._ws.on('close', () => {
				console.log('CDP WebSocket closed.');
				this._rejectAllPending(new Error('WebSocket closed.'));
			});

			this._ws.on('message', (data) => {
				try {
					const message = JSON.parse(data.toString());
					if (message.id && this._pendingRequests.has(message.id)) {
						const { resolve, reject } = this._pendingRequests.get(message.id)!;
						this._pendingRequests.delete(message.id);
						if (message.error) {
							reject(new Error(message.error.message || JSON.stringify(message.error)));
						} else {
							resolve(message.result);
						}
					}
				} catch (err) {
					console.error('Failed to parse CDP message:', err);
				}
			});
		});
	}

	public send(method: string, params: any = {}): Promise<any> {
		return new Promise((resolve, reject) => {
			if (!this._ws || this._ws.readyState !== WebSocket.OPEN) {
				return reject(new Error('WebSocket connection is not open.'));
			}
			const id = this._messageId++;
			this._pendingRequests.set(id, { resolve, reject });
			this._ws.send(JSON.stringify({ id, method, params }));
		});
	}

	public async navigate(url: string): Promise<void> {
		await this.send('Page.enable');
		await this.send('Page.navigate', { url });
		
		// Wait for document.readyState to be 'complete' (up to 10 seconds)
		for (let i = 0; i < 20; i++) {
			await sleep(500);
			try {
				const result = await this.evaluate('document.readyState');
				if (result?.value === 'complete') {
					break;
				}
			} catch {
				// Ignore errors while loading
			}
		}
		// Extra buffer for SPA rendering
		await sleep(1500);
	}

	public async captureScreenshot(): Promise<string> {
		const result = await this.send('Page.captureScreenshot', { format: 'png' });
		if (!result || !result.data) {
			throw new Error('Failed to capture screenshot: No data returned.');
		}
		return result.data; // Base64 string
	}

	public async evaluate(expression: string): Promise<any> {
		const result = await this.send('Runtime.evaluate', {
			expression,
			returnByValue: true,
			awaitPromise: true
		});
		return result?.result;
	}

	public async click(selector: string): Promise<void> {
		const escapedSelector = selector.replace(/"/g, '\\"');
		const expr = `
			(() => {
				const el = document.querySelector("${escapedSelector}");
				if (!el) throw new Error("Element not found for selector: ${escapedSelector}");
				el.scrollIntoView({ block: 'center' });
				el.click();
				// Support focus for buttons/inputs clicked
				if (typeof el.focus === 'function') el.focus();
			})()
		`;
		const result = await this.evaluate(expr);
		if (result?.subtype === 'error') {
			throw new Error(result.description || 'Failed to click element.');
		}
		await sleep(1000); // Wait for transition
	}

	public async type(selector: string, text: string): Promise<void> {
		const escapedSelector = selector.replace(/"/g, '\\"');
		const escapedText = JSON.stringify(text);
		const expr = `
			(() => {
				const el = document.querySelector("${escapedSelector}");
				if (!el) throw new Error("Element not found for selector: ${escapedSelector}");
				el.scrollIntoView({ block: 'center' });
				el.focus();
				if ('value' in el) {
					el.value = ${escapedText};
					el.dispatchEvent(new Event('input', { bubbles: true }));
					el.dispatchEvent(new Event('change', { bubbles: true }));
				} else {
					el.innerText = ${escapedText};
					el.dispatchEvent(new Event('input', { bubbles: true }));
				}
			})()
		`;
		const result = await this.evaluate(expr);
		if (result?.subtype === 'error') {
			throw new Error(result.description || 'Failed to type in element.');
		}
		await sleep(500);
	}

	public async scroll(direction: 'up' | 'down'): Promise<void> {
		const scrollAmt = direction === 'down' ? 'window.innerHeight * 0.8' : '-window.innerHeight * 0.8';
		await this.evaluate(`window.scrollBy({ top: ${scrollAmt}, behavior: 'smooth' })`);
		await sleep(800);
	}

	public close() {
		this._rejectAllPending(new Error('Client was closed.'));
		if (this._ws) {
			try {
				this._ws.close();
			} catch (_) {}
			this._ws = undefined;
		}
	}

	private _rejectAllPending(err: Error) {
		for (const [id, req] of this._pendingRequests.entries()) {
			req.reject(err);
			this._pendingRequests.delete(id);
		}
	}
}
