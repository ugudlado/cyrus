import type { RepositoryConfig, TenantConfig } from "./config-schemas.js";

/**
 * Validate the `tenants` section of a config against its repositories.
 * Returns human-readable problems (empty = valid). Messages name ids only,
 * never secret values.
 */
export function validateTenants(config: {
	repositories: Pick<RepositoryConfig, "id">[];
	tenants?: TenantConfig[];
}): string[] {
	const tenants = config.tenants;
	if (!tenants || tenants.length === 0) return [];

	const problems: string[] = [];
	const repoIds = new Set(config.repositories.map((r) => r.id));
	const ids = new Set<string>();
	const workspaceIds = new Set<string>();
	const teamIds = new Set<string>();
	const repoOwner = new Map<string, string>();

	for (const tenant of tenants) {
		if (ids.has(tenant.id)) problems.push(`duplicate tenant id "${tenant.id}"`);
		ids.add(tenant.id);

		if (workspaceIds.has(tenant.linearWorkspaceId)) {
			problems.push(
				`tenant "${tenant.id}": linearWorkspaceId already used by another tenant`,
			);
		}
		workspaceIds.add(tenant.linearWorkspaceId);

		if (tenant.slack) {
			if (teamIds.has(tenant.slack.teamId)) {
				problems.push(
					`tenant "${tenant.id}": slack.teamId already used by another tenant`,
				);
			}
			teamIds.add(tenant.slack.teamId);
		}

		for (const repoId of tenant.repositoryIds) {
			if (!repoIds.has(repoId)) {
				problems.push(
					`tenant "${tenant.id}": repository "${repoId}" does not exist`,
				);
				continue;
			}
			const owner = repoOwner.get(repoId);
			if (owner !== undefined && owner !== tenant.id) {
				problems.push(
					`repository "${repoId}" belongs to both "${owner}" and "${tenant.id}"`,
				);
			}
			repoOwner.set(repoId, tenant.id);
		}
	}
	return problems;
}

/**
 * Lookup helper over the configured tenants. Secrets are read from the
 * environment at call time and are never logged or stored.
 */
export class TenantRegistry {
	private readonly tenants: readonly TenantConfig[];

	constructor(
		tenants: readonly TenantConfig[] = [],
		private readonly env: NodeJS.ProcessEnv = process.env,
	) {
		this.tenants = tenants;
	}

	static fromConfig(
		config: { tenants?: TenantConfig[] },
		env: NodeJS.ProcessEnv = process.env,
	): TenantRegistry {
		return new TenantRegistry(config.tenants ?? [], env);
	}

	/** True when at least one tenant is configured */
	get enabled(): boolean {
		return this.tenants.length > 0;
	}

	list(): readonly TenantConfig[] {
		return this.tenants;
	}

	byId(id: string): TenantConfig | undefined {
		return this.tenants.find((t) => t.id === id);
	}

	byLinearWorkspaceId(workspaceId: string): TenantConfig | undefined {
		return this.tenants.find((t) => t.linearWorkspaceId === workspaceId);
	}

	bySlackTeamId(teamId: string): TenantConfig | undefined {
		return this.tenants.find((t) => t.slack?.teamId === teamId);
	}

	byRepositoryId(repositoryId: string): TenantConfig | undefined {
		return this.tenants.find((t) => t.repositoryIds.includes(repositoryId));
	}

	/** Value of an env var by name; empty string counts as unset. */
	secret(envName: string): string | undefined {
		const value = this.env[envName];
		return value ? value : undefined;
	}
}
