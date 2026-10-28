import { describe, expect, it } from "vitest";
import { widerEgress } from "../app/sandbox.js";

const allowList = (...domains: string[]) => ({
	type: "allow-list",
	rules: domains.map((domain) => ({ domain, protocol: "https" })),
});

describe("widerEgress", () => {
	it("accepts the allow-list that was asked for", () => {
		expect(widerEgress(allowList("github.com"), ["github.com"])).toBeNull();
	});

	// Render's default is allow-all. A sandbox that ignored the request would
	// let the agent's code reach any host.
	it("refuses a sandbox with any other policy, or with hosts nobody asked for", () => {
		expect(widerEgress({ type: "allow-all" }, ["github.com"])).toContain(
			"allow-all",
		);
		expect(widerEgress(undefined, ["github.com"])).toContain("unknown");
		expect(
			widerEgress(allowList("github.com", "example.com"), ["github.com"]),
		).toContain("example.com");
	});
});
