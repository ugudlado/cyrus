/**
 * Types for Linear event transport
 */

import type { FastifyInstance } from "fastify";
import type { AgentEvent, InternalMessage } from "kittu-core";

/**
 * Verification mode for Linear webhooks
 * - 'direct': Use LINEAR_WEBHOOK_SECRET for Linear signature verification
 * - 'proxy': Use KITTU_API_KEY Bearer token for proxy authentication
 */
export type VerificationMode = "direct" | "proxy";

/**
 * Per-tenant verification entry for direct mode. A delivery signed with
 * `secret` is only accepted if its organizationId equals `linearWorkspaceId`.
 */
export interface LinearTenantSecret {
	tenantId: string;
	linearWorkspaceId: string;
	/** Resolved at call time (e.g. from process.env); empty = not configured */
	getSecret: () => string | undefined;
}

/**
 * Configuration for LinearEventTransport
 */
export interface LinearEventTransportConfig {
	/** Fastify server instance to mount routes on */
	fastifyServer: FastifyInstance;
	/** Verification mode: 'direct' or 'proxy' */
	verificationMode: VerificationMode;
	/** Secret for verification (LINEAR_WEBHOOK_SECRET or KITTU_API_KEY) */
	secret: string;
	/** Optional IP allowlist for webhook source validation (only used in direct mode) */
	ipAllowlist?: readonly string[];
	/**
	 * Direct mode only: when non-empty, replaces `secret`. Each tenant's secret
	 * is tried in turn; the matching tenant tags the event.
	 */
	tenantSecrets?: readonly LinearTenantSecret[];
}

/**
 * Events emitted by LinearEventTransport
 */
export interface LinearEventTransportEvents {
	/** Emitted when a webhook is received and verified (legacy) */
	event: (event: AgentEvent, tenantId?: string) => void;
	/** Emitted when a unified internal message is received */
	message: (message: InternalMessage) => void;
	/** Emitted when an error occurs */
	error: (error: Error) => void;
}
