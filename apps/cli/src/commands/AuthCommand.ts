import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { getKittuAppUrl } from "kittu-cloudflare-tunnel-client";
import { BaseCommand } from "./ICommand.js";

/**
 * Auth command - authenticate with Kittu Pro plan using auth key
 */
export class AuthCommand extends BaseCommand {
	async execute(args: string[]): Promise<void> {
		// Get auth key from command line arguments
		const authKey = args[0];

		if (
			!authKey ||
			typeof authKey !== "string" ||
			authKey.trim().length === 0
		) {
			this.logError("Error: Auth key is required");
			console.log("\nUsage: kittu auth <auth-key>");
			console.log(
				`\nGet your auth key from: ${getKittuAppUrl()}/onboarding/auth-kittu`,
			);
			process.exit(1);
		}

		console.log("\n🔑 Authenticating with Kittu...");
		this.logDivider();

		try {
			// Import ConfigApiClient
			const { ConfigApiClient } = await import(
				"kittu-cloudflare-tunnel-client"
			);

			// Call the config API to get credentials
			console.log("Validating auth key...");
			const configResponse = await ConfigApiClient.getConfig(authKey);

			if (!ConfigApiClient.isValid(configResponse)) {
				this.logError("Authentication failed");
				console.error(configResponse.error || "Invalid response from server");
				console.log("\nPlease verify your auth key is correct.");
				console.log(
					`Get your auth key from: ${getKittuAppUrl()}/onboarding/auth-kittu`,
				);
				process.exit(1);
			}

			this.logSuccess("Authentication successful!");

			// Ensure KITTU_HOME directory exists
			if (!existsSync(this.app.kittuHome)) {
				mkdirSync(this.app.kittuHome, { recursive: true });
			}

			// Store tokens in ~/.kittu/.env file
			const envPath = resolve(this.app.kittuHome, ".env");
			const envContent = `# Kittu Authentication Credentials
# Generated on ${new Date().toISOString()}
CLOUDFLARE_TOKEN=${configResponse.config!.cloudflareToken}
KITTU_API_KEY=${configResponse.config!.apiKey}
KITTU_SETUP_PENDING=true
${configResponse.config!.serverPort === undefined ? "" : `KITTU_SERVER_PORT=${configResponse.config!.serverPort}\n`}
`;

			writeFileSync(envPath, envContent, "utf-8");
			this.logSuccess(`Credentials saved to ${envPath}`);

			// Reload environment variables to pick up KITTU_SETUP_PENDING
			const dotenv = await import("dotenv");
			dotenv.config({ path: envPath, override: true });

			console.log("\n✨ Setup complete! Starting Kittu...");
			this.logDivider();
			console.log();

			// Start the edge app with the new configuration
			// Import StartCommand to avoid circular dependency
			const { StartCommand } = await import("./StartCommand.js");
			const startCommand = new StartCommand(this.app);
			await startCommand.execute([]);
		} catch (error) {
			this.logError("Authentication failed:");
			console.error((error as Error).message);
			console.log(
				"\nPlease try again or contact support if the issue persists.",
			);
			process.exit(1);
		}
	}
}
