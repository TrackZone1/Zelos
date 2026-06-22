<p align="center">
  <img src="https://kie.ai/logo.png" alt="KIE Logo" width="120px" style="border-radius: 8px;" />
</p>

# Zelos

> **Zelos** is an autonomous AI coding agent extension for Visual Studio Code using the [KIE API](https://kie.ai/).

Zelos operates in an autonomous loop inside your workspace, utilizing advanced capabilities to analyze files, run tests, critique code, and automatically refactor or implement features based on your instructions.

### 💰 Extremely Cost-Effective Agentic Loops
Running autonomous AI agents typically consumes a massive amount of tokens due to continuous reasoning, context injection, and iterative tool steps. Zelos is built exclusively for the **KIE API**, which provides high-performance models at prices **30% to 80% cheaper** than official APIs. This makes running complex autonomous agent loops highly affordable and accessible for everyday development.

---

## ✨ Features

- **🤖 Autonomous Agent Loop**: Zelos executes multiple actions sequentially, reasoning through terminal outputs and file changes step-by-step until the task is complete.
- **🛠️ Rich Workspace Integration**: The agent can perform real-world actions directly in VS Code through approval-guarded XML-based tools:
  - `<create_file>`: Create or modify files in the workspace.
  - `<read_file>`: Read file content for analysis.
  - `<list_files>`: List project structures.
  - `<run_command>`: Execute terminal commands (compiling, testing, formatting).
- **🛡️ Secure Approval Workflows**: Choose between:
  - **Prompt mode** (default): Review and approve every terminal command or file modification before it runs.
  - **Auto-approve/Reject**: Full execution automation or high-security lockouts.
- **🔍 Comprehensive Workspace Audit**:
  - **Architecture Reviews**: Checks directories and structures against clean code paradigms.
  - **Automated Code Review**: Flags bugs, anti-patterns, and vulnerabilities.
  - **Cognitive Complexity Audit**: Evaluates functions and methods against a customizable cognitive complexity threshold (e.g., nesting, logical branches) and plans refactorings.
  - **Self-Critique & Auto-Correction**: Autonomously corrects detected flaws or failing tests by modifying the workspace and re-running the test suite.
- **🎨 Premium Chat Webview**: A highly responsive, custom-styled Outfit/Fira Code interface with real-time streaming status updates, interactive tool execution logs, and easy configurations.

---

## 🚀 Installation & Requirements

### Prerequisites

- VS Code `^1.80.0`
- Node.js & npm (for compiling and executing actions)
- A valid **KIE API Key** from [KIE.ai](https://kie.ai/)

### Setup

1. Clone or download the repository into your VS Code extensions or development directory:
   ```bash
   git clone https://github.com/TrackZone1/Zelos.git
   ```
2. Navigate to the folder and install dependencies:
   ```bash
   npm install
   ```
3. Compile the extension:
   ```bash
   npm run compile
   ```
4. Press `F5` in VS Code to launch a new **Extension Development Host** window with Zelos active.

---

## ⚙️ Configuration

Open VS Code settings (`Ctrl+,` or `Cmd+,`) and search for **Zelos** to configure:

| Setting | Type | Default | Description |
|---|---|---|---|
| `zelos.api.key` | `string` | `""` | Your secret API key from KIE. |
| `zelos.api.url` | `string` | `https://api.kie.ai` | Base URL for the KIE API endpoints. |
| `zelos.api.model` | `string` | `gpt-5-5` | The LLM model used (e.g. `gpt-5-5`, `gpt-5-codex`). |
| `zelos.commandApprovalMode`| `enum` | `prompt` | Approval strategy for running terminal commands (`prompt` \| `acceptAll` \| `rejectAll`). |
| `zelos.fileApprovalMode` | `enum` | `prompt` | Approval strategy for modifying workspace files (`prompt` \| `acceptAll` \| `rejectAll`). |
| `zelos.communicationLanguage` | `enum` | `English` | Language used for conversational communication with the agent (`English` \| `French`). |
| `zelos.codeLanguage` | `enum` | `English` | Language applied for comments, variable naming, and documentation in the generated code (`English` \| `French`). |

Alternatively, you can manage these settings directly inside the **Zelos Webview Settings Panel** (⚙️).

---

## 📖 Usage

### 💬 Regular Assistant Chat
1. Open the Zelos view in the VS Code Activity Bar (represented by the bot `$(hubot)` icon).
2. Input your API credentials in the settings panel (⚙️).
3. Send a message to start pair programming.
4. If approval modes are active, you will see interactive buttons inside the chat view asking to approve or reject actions (like running `npm test` or saving changes to a file).

### 🔍 Running Workspace Audits
1. Click the **Audit** button in the top bar.
2. Select your audit options:
   - Check directory layout & architecture
   - Perform code review & quality check
   - Run tests automatically (configurable test command)
   - Perform cognitive complexity analysis (with threshold)
   - Auto-critique & Self-correct issues
3. Click **Start Audit** and watch Zelos examine, test, critique, and self-heal your workspace autonomously.

---

## 🧩 How it Works

Zelos bridges the gap between LLMs and local development environments by running an autonomous agent loop:

```mermaid
graph TD
    User([User Prompt / Audit]) --> AgentLoop[Agent Loop Start]
    AgentLoop --> SendAPI[Send history & context to KIE API]
    SendAPI --> GetResponse[Receive structured response]
    GetResponse --> CheckTools{Contains XML Tools?}
    
    CheckTools -- Yes --> Approve{Requires Approval?}
    Approve -- Approved --> Exec[Execute Tool local command/file]
    Approve -- Rejected --> FeedbackError[Feed rejection back to LLM]
    Exec --> Feedback[Feed result back to LLM]
    Feedback --> AgentLoop
    FeedbackError --> AgentLoop
    
    CheckTools -- No --> Render[Render final summary text]
    Render --> Done([Done])
```

1. **Context Extraction**: When starting a conversation, Zelos automatically injects the active editor's file content to provide immediate context.
2. **KIE Codex API**: Requests are sent to KIE's Codex endpoints (`https://api.kie.ai/codex/v1/responses` for `gpt-5-5`).
3. **XML Tool Parser**: The agent outputs structured XML tags. The extension captures and parses these commands, runs them locally, and returns the output directly to the LLM context.
4. **Code-Leak Protection**: If the agent leaks raw code in its text output (instead of writing it to files via tools), Zelos intercepts, prompts a system correction, and retries automatically to guarantee workspace consistency.

---

## 📄 License

This project is licensed under the MIT License. See the LICENSE file for details.
