import * as vscode from 'vscode';
import { ZelosWebviewProvider } from './ZelosWebviewProvider';

export function activate(context: vscode.ExtensionContext) {
	console.log('Congratulations, your extension "zelos" is now active!');

	const provider = new ZelosWebviewProvider(context.extensionUri);

	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(ZelosWebviewProvider.viewType, provider, {
			webviewOptions: {
				retainContextWhenHidden: true
			}
		})
	);

	const disposable = vscode.commands.registerCommand('zelos.start', () => {
		vscode.commands.executeCommand('zelos.chatView.focus');
	});

	context.subscriptions.push(disposable);
}

export function deactivate() {}
