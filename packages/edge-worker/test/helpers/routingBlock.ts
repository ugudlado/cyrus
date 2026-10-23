/**
 * Expected `<repository_routing_context>` block, written out from fixture data
 * (independent of PromptBuilder) so tests can assert it in full.
 */
export interface RoutingBlockRepo {
	name: string;
	/** github URL; the description tag is the part after github.com/ */
	githubUrl: string;
	current?: boolean;
}

export function expectedRoutingBlock(repos: RoutingBlockRepo[]): string {
	const entries = repos.map((repo) => {
		const identifier = repo.githubUrl.replace("https://github.com/", "");
		return `  <repository name="${repo.name}"${repo.current ? " (current)" : ""}>
    <github_url>${repo.githubUrl}</github_url>
    <gitlab_url>N/A</gitlab_url>
    <routing_methods>
    - Description tag: \`[repo=${identifier}]\` or \`[repo=${identifier}#branch]\` for base branch override
    </routing_methods>
  </repository>`;
	});
	return `<repository_routing_context>
<description>
When creating sub-issues that should be handled in a DIFFERENT repository, use one of these routing methods.

**IMPORTANT - Routing Priority Order:**
The system evaluates routing methods in this strict priority order. The FIRST match wins:

1. **Description Tag (Priority 1 - Highest, Recommended)**: Add \`[repo=repo-name]\` to the sub-issue description.
   - Multiple repos: \`[repo=repo1]\` and \`[repo=repo2]\`, or \`repos=repo1,repo2\`
   - Base branch override: \`[repo=repo-name#branch-name]\` to target a specific branch instead of the default
   - Unbracketed syntax also works: \`repo=repo-name\` or \`repo=repo-name#branch\`
   - Agent selector: \`[agent=claude|gemini|codex|cursor|opencode]\` to choose the execution harness
   - Linear label selector: \`<provider>/<model>\` (for example \`openai/gpt-5.5\`) to choose both harness and model. For OpenCode, use \`opencode/<provider>/<model>\` (for example \`opencode/openai/gpt-5.5\`).
2. **Routing Labels (Priority 2)**: Apply a label configured to route to the target repository.
3. **Project Assignment (Priority 3)**: Add the issue to a project that routes to the target repository.
4. **Team Selection (Priority 4 - Lowest)**: Create the issue in a Linear team that routes to the target repository.

For reliable cross-repository routing, prefer Description Tags as they are explicit and unambiguous.
</description>

<available_repositories>
${entries.join("\n")}
</available_repositories>
</repository_routing_context>`;
}
