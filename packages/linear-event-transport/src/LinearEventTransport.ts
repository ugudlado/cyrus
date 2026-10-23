import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import {
	LinearWebhookClient,
	type LinearWebhookPayload,
} from "@linear/sdk/webhooks";
import type { IAgentEventTransport, TranslationContext } from "cyrus-core";
import { createLogger, type ILogger, ipMatchesAllowlist } from "cyrus-core";
import type { FastifyReply, FastifyRequest } from "fastify";
import { LinearMessageTranslator } from "./LinearMessageTranslator.js";
import type {
	LinearEventTransportConfig,
	LinearEventTransportEvents,
	LinearTenantSecret,
} from "./types.js";

export declare interface LinearEventTransport {
	on<K extends keyof LinearEventTransportEvents>(
		event: K,
		listener: LinearEventTransportEvents[K],
	): this;
	emit<K extends keyof LinearEventTransportEvents>(
		event: K,
		...args: Parameters<LinearEventTransportEvents[K]>
	): boolean;
}

/**
 * LinearEventTransport - Handles Linear webhook event delivery
 *
 * This class implements IAgentEventTransport to provide a platform-agnostic
 * interface for handling Linear webhooks with Linear-specific verification.
 *
 * It registers a POST /linear-webhook endpoint with a Fastify server, plus
 * a POST /webhook alias retained for backward compatibility (deprecated).
 * Incoming webhooks are verified using either:
 * 1. "direct" mode: Verifies Linear's webhook signature
 * 2. "proxy" mode: Verifies Bearer token authentication
 *
 * The class emits "event" events with AgentEvent (LinearWebhookPayload) data.
 */
export class LinearEventTransport
	extends EventEmitter
	implements IAgentEventTransport
{
	private config: LinearEventTransportConfig;
	private linearWebhookClient: LinearWebhookClient | null = null;
	/**
	 * Cached per-tenant clients, keyed by tenant id. Only a SHA-256 of the
	 * secret is kept (to notice rotation), never the secret itself.
	 */
	private tenantClients = new Map<
		string,
		{ secretHash: string; client: LinearWebhookClient }
	>();
	private logger: ILogger;
	private messageTranslator: LinearMessageTranslator;
	private translationContext: TranslationContext;

	constructor(
		config: LinearEventTransportConfig,
		logger?: ILogger,
		translationContext?: TranslationContext,
	) {
		super();
		this.config = config;
		this.logger = logger ?? createLogger({ component: "LinearEventTransport" });
		this.messageTranslator = new LinearMessageTranslator();
		this.translationContext = translationContext ?? {};

		// Initialize Linear webhook client for direct mode
		if (config.verificationMode === "direct" && !this.hasTenants()) {
			this.linearWebhookClient = new LinearWebhookClient(config.secret);
		}
	}

	private hasTenants(): boolean {
		return (this.config.tenantSecrets?.length ?? 0) > 0;
	}

	/**
	 * Try every tenant secret (no early exit) and return the first matching
	 * tenant. One LinearWebhookClient per tenant keeps the SDK's timestamp check.
	 */
	private matchTenant(
		body: Buffer,
		signature: string,
	): LinearTenantSecret | undefined {
		let matched: LinearTenantSecret | undefined;
		for (const tenant of this.config.tenantSecrets ?? []) {
			const secret = tenant.getSecret();
			if (!secret) continue;
			let entry = this.tenantClients.get(tenant.tenantId);
			const secretHash = createHash("sha256").update(secret).digest("hex");
			if (!entry || entry.secretHash !== secretHash) {
				entry = { secretHash, client: new LinearWebhookClient(secret) };
				this.tenantClients.set(tenant.tenantId, entry);
			}
			let ok = false;
			try {
				ok = entry.client.verify(body, signature);
			} catch {
				ok = false;
			}
			if (ok && !matched) matched = tenant;
		}
		return matched;
	}

	/**
	 * Set the translation context for message translation.
	 * This allows setting Linear API tokens and other context after construction.
	 */
	setTranslationContext(context: TranslationContext): void {
		this.translationContext = { ...this.translationContext, ...context };
	}

	/**
	 * Register the /linear-webhook endpoint (plus the deprecated /webhook alias)
	 * with the Fastify server.
	 */
	register(): void {
		const handler = async (
			request: FastifyRequest,
			reply: FastifyReply,
		): Promise<void> => {
			try {
				// Verify based on mode
				if (this.config.verificationMode === "direct") {
					await this.handleDirectWebhook(request, reply);
				} else {
					await this.handleProxyWebhook(request, reply);
				}
			} catch (error) {
				const err = new Error("Webhook error");
				if (error instanceof Error) {
					err.cause = error;
				}
				this.logger.error("Webhook error", err);
				this.emit("error", err);
				reply.code(500).send({ error: "Internal server error" });
			}
		};

		this.config.fastifyServer.post("/linear-webhook", handler);

		// Deprecated alias — retained so existing Linear webhook configurations
		// continue to deliver while users migrate to /linear-webhook.
		let deprecationWarned = false;
		this.config.fastifyServer.post(
			"/webhook",
			async (request: FastifyRequest, reply: FastifyReply) => {
				if (!deprecationWarned) {
					deprecationWarned = true;
					this.logger.warn(
						"POST /webhook is deprecated; update your Linear webhook URL to use /linear-webhook",
					);
				}
				await handler(request, reply);
			},
		);

		this.logger.info(
			`Registered POST /linear-webhook endpoint (${this.config.verificationMode} mode); POST /webhook retained as deprecated alias`,
		);
	}

	/**
	 * Handle webhook in direct mode using Linear's signature verification
	 */
	private async handleDirectWebhook(
		request: FastifyRequest,
		reply: FastifyReply,
	): Promise<void> {
		if (!this.linearWebhookClient && !this.hasTenants()) {
			reply.code(500).send({ error: "Linear webhook client not initialized" });
			return;
		}

		// Validate source IP against Linear's known webhook IPs
		if (
			this.config.ipAllowlist &&
			this.config.ipAllowlist.length > 0 &&
			!ipMatchesAllowlist(request.ip, this.config.ipAllowlist)
		) {
			this.logger.warn(
				`Rejected Linear webhook from unauthorized IP: ${request.ip}`,
			);
			reply.code(403).send({ error: "Forbidden: unauthorized source IP" });
			return;
		}

		// Get Linear signature from headers
		const signature = request.headers["linear-signature"] as string;
		if (!signature) {
			reply.code(401).send({ error: "Missing linear-signature header" });
			return;
		}

		try {
			// Use the raw body bytes that SharedApplicationServer stashed on the request
			// so signature verification uses the exact payload Linear signed, rather than
			// a re-serialized version that may differ in key order or whitespace.
			const rawBody = (request as FastifyRequest & { rawBody: string }).rawBody;
			const bodyBuffer = rawBody
				? Buffer.from(rawBody)
				: Buffer.from(JSON.stringify(request.body));
			let tenantId: string | undefined;
			if (this.hasTenants()) {
				const tenant = this.matchTenant(bodyBuffer, signature);
				if (!tenant) {
					reply.code(401).send({ error: "Invalid webhook signature" });
					return;
				}
				// A valid signature only authorizes events from that tenant's workspace
				const orgId = (request.body as { organizationId?: unknown } | null)
					?.organizationId;
				if (orgId !== tenant.linearWorkspaceId) {
					this.logger.warn(
						`Dropped Linear webhook for tenant "${tenant.tenantId}": organizationId missing or not this tenant's workspace`,
					);
					reply.code(200).send({ success: true });
					return;
				}
				tenantId = tenant.tenantId;
			} else {
				// biome-ignore lint/style/noNonNullAssertion: guarded above
				const isValid = this.linearWebhookClient!.verify(bodyBuffer, signature);
				if (!isValid) {
					reply.code(401).send({ error: "Invalid webhook signature" });
					return;
				}
			}

			const payload = request.body as LinearWebhookPayload;

			// Emit "event" for legacy IAgentEventTransport compatibility
			if (tenantId === undefined) {
				this.emit("event", payload);
			} else {
				this.emit("event", payload, tenantId);
			}

			// Emit "message" with translated internal message
			this.emitMessage(payload);

			// Send success response
			reply.code(200).send({ success: true });
		} catch (error) {
			const err = new Error("Direct webhook verification failed");
			if (error instanceof Error) {
				err.cause = error;
			}
			this.logger.error("Direct webhook verification failed", err);
			reply.code(401).send({ error: "Invalid webhook signature" });
		}
	}

	/**
	 * Handle webhook in proxy mode using Bearer token authentication
	 */
	private async handleProxyWebhook(
		request: FastifyRequest,
		reply: FastifyReply,
	): Promise<void> {
		// Get Authorization header
		const authHeader = request.headers.authorization;
		if (!authHeader) {
			reply.code(401).send({ error: "Missing Authorization header" });
			return;
		}

		// Verify Bearer token
		const expectedAuth = `Bearer ${this.config.secret}`;
		if (authHeader !== expectedAuth) {
			reply.code(401).send({ error: "Invalid authorization token" });
			return;
		}

		try {
			const payload = request.body as LinearWebhookPayload;

			// Emit "event" for legacy IAgentEventTransport compatibility
			this.emit("event", payload);

			// Emit "message" with translated internal message
			this.emitMessage(payload);

			// Send success response
			reply.code(200).send({ success: true });
		} catch (error) {
			const err = new Error("Proxy webhook processing failed");
			if (error instanceof Error) {
				err.cause = error;
			}
			this.logger.error("Proxy webhook processing failed", err);
			reply.code(500).send({ error: "Failed to process webhook" });
		}
	}

	/**
	 * Translate and emit an internal message from a webhook payload.
	 * Only emits if translation succeeds; logs debug message on failure.
	 */
	private emitMessage(payload: LinearWebhookPayload): void {
		const result = this.messageTranslator.translate(
			payload,
			this.translationContext,
		);

		if (result.success) {
			this.emit("message", result.message);
		} else {
			this.logger.debug(`Message translation skipped: ${result.reason}`);
		}
	}
}
