import type { RepositoryConfig, TenantRegistry } from "cyrus-core";

/**
 * Abstraction for accessing the current set of chat-accessible repositories.
 *
 * SlackChatAdapter and ChatSessionHandler depend on this interface rather than
 * a frozen array, so they always read the live repository state at the moment
 * a session is built — no refresh/notification wiring needed.
 *
 * Every method takes the event's tenant id. With a tenant, only that tenant's
 * repositories and workspace are visible; without one (single-tenant
 * deployments, or events not tagged with a tenant) everything is.
 */
export interface ChatRepositoryProvider {
	/** Current repository paths available for chat sessions */
	getRepositoryPaths(tenantId?: string): string[];
	/** Default repository for MCP config sourcing (V1: first available) */
	getDefaultRepository(tenantId?: string): RepositoryConfig | undefined;
	/** Default Linear workspace ID for MCP config (V1: first configured) */
	getDefaultLinearWorkspaceId(tenantId?: string): string | undefined;
}

/**
 * Live implementation backed by EdgeWorker's repository map and config.
 *
 * Reads are computed on demand from the underlying collections, so any
 * runtime config changes (add/update/remove) are automatically visible
 * to the next chat session without explicit notification.
 */
export class LiveChatRepositoryProvider implements ChatRepositoryProvider {
	constructor(
		private readonly repositories: Map<string, RepositoryConfig>,
		private readonly getLinearWorkspaces: () => Record<string, unknown>,
		private readonly tenantRegistry?: TenantRegistry,
	) {}

	/**
	 * Repositories visible to the tenant, in the tenant's declared order (the
	 * first is the default). An unknown tenant id sees nothing.
	 */
	private reposFor(tenantId?: string): RepositoryConfig[] {
		if (tenantId === undefined) {
			return Array.from(this.repositories.values());
		}
		const tenant = this.tenantRegistry?.byId(tenantId);
		if (!tenant) return [];
		return tenant.repositoryIds
			.map((id) => this.repositories.get(id))
			.filter((repo): repo is RepositoryConfig => repo !== undefined);
	}

	getRepositoryPaths(tenantId?: string): string[] {
		return this.reposFor(tenantId).map((repo) => repo.repositoryPath);
	}

	getDefaultRepository(tenantId?: string): RepositoryConfig | undefined {
		return this.reposFor(tenantId)[0];
	}

	getDefaultLinearWorkspaceId(tenantId?: string): string | undefined {
		if (tenantId !== undefined) {
			const workspaceId =
				this.tenantRegistry?.byId(tenantId)?.linearWorkspaceId;
			return workspaceId && workspaceId in this.getLinearWorkspaces()
				? workspaceId
				: undefined;
		}
		return Object.keys(this.getLinearWorkspaces())[0];
	}
}
