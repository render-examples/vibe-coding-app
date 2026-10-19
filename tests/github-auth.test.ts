import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { githubToken, resetTokenCache } from "../app/github.js";

const { privateKey } = generateKeyPairSync("rsa", {
	modulusLength: 2048,
	privateKeyEncoding: { type: "pkcs8", format: "pem" },
	publicKeyEncoding: { type: "spki", format: "pem" },
});

const GITHUB_VARS = [
	"GITHUB_APP_ID",
	"GITHUB_APP_PRIVATE_KEY",
	"GITHUB_APP_INSTALLATION_ID",
	"GITHUB_TOKEN",
] as const;

beforeEach(() => {
	resetTokenCache();
	for (const name of GITHUB_VARS) delete process.env[name];
});

afterEach(() => {
	vi.useRealTimers();
	for (const name of GITHUB_VARS) delete process.env[name];
});

describe("githubToken", () => {
	// A run can outlive the one-hour lifetime of an installation token.
	it("exchanges a GitHub App installation token and reuses it until it nears expiry", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		process.env.GITHUB_APP_ID = "123456";
		process.env.GITHUB_APP_PRIVATE_KEY = privateKey;
		process.env.GITHUB_APP_INSTALLATION_ID = "7891011";
		process.env.GITHUB_TOKEN = "ghp_personal";
		let issued = 0;
		const fetchImpl = vi.fn(async () =>
			Response.json({
				token: `ghs_install_${++issued}`,
				expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
			}),
		) as unknown as typeof fetch;

		expect(await githubToken(fetchImpl)).toBe("ghs_install_1");
		vi.advanceTimersByTime(30 * 60 * 1000);
		expect(await githubToken(fetchImpl)).toBe("ghs_install_1");
		vi.advanceTimersByTime(28 * 60 * 1000);
		expect(await githubToken(fetchImpl)).toBe("ghs_install_2");
	});

	it("uses the PAT when no GitHub App is configured", async () => {
		process.env.GITHUB_TOKEN = "ghp_personal";
		const fetchImpl = vi.fn() as unknown as typeof fetch;

		expect(await githubToken(fetchImpl)).toBe("ghp_personal");
	});

	it("fails when no credentials are configured", async () => {
		await expect(githubToken()).rejects.toThrow(/No GitHub credentials/);
	});
});
