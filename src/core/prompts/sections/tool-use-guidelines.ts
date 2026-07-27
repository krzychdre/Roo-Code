export function getToolUseGuidelinesSection(): string {
	return `# Tool Use Guidelines

1. Assess what information you already have and what information you need to proceed with the task.
2. Choose the most appropriate tool based on the task and the tool descriptions provided. Assess if you need additional information to proceed, and which of the available tools would be most effective for gathering this information. For example using the list_files tool is more effective than running a command like \`ls\` in the terminal. It's critical that you think about each available tool and use the one that best fits the current step in the task.
3. Batch by default. In a single message, call every tool whose input you already know. Reads, searches, and listings of different paths do not depend on each other, so they belong in the SAME message. For example, to understand three files you already know the paths of, make three read_file calls in one message - not one call in each of three messages.
4. Use a separate message only when a tool's input literally depends on another tool's output, for example when you must search for a file before you can read it. Do not assume the outcome of any tool use: wait for the actual result before you act on it.

By carefully considering the user's response after tool executions, you can react accordingly and make informed decisions about how to proceed with the task. This iterative process helps ensure the overall success and accuracy of your work.`
}
