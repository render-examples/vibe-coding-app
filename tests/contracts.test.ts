import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentJson } from "../app/claude.js";
import {
	deployDiagnosisSchema,
	deployPlanSchema,
	manifestSchema,
	slug,
} from "../app/contracts.js";

const plan = {
	appName: "furniture-catalog",
	summary: "A storefront, an API, and Postgres behind it.",
	tiers: [{ kind: "static_site", reason: "the storefront" }],
	assetQueries: ["handcrafted walnut dining chair"],
	brief: {
		pages: ["Home"],
		features: [],
		voice: "warm",
		content: "Real copy.",
		dataModel: "products(name, price_cents)",
	},
};

/**
 * The SDK checks agent output against its JSON Schema. Zod checks it again,
 * because a JSON Schema cannot hold each Zod rule, and fails closed.
 */
describe("agentJson", () => {
	beforeEach(() => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("returns a valid answer, and retries an invalid one once with the validation error", async () => {
		expect(
			await agentJson(
				async () => plan,
				deployPlanSchema,
				"Design it.",
				"architect",
			),
		).toMatchObject({ appName: "furniture-catalog" });

		const call = vi
			.fn()
			.mockResolvedValueOnce({ ...plan, tiers: [] })
			.mockResolvedValueOnce(plan);
		await expect(
			agentJson(call, deployPlanSchema, "Design it.", "architect"),
		).resolves.toMatchObject({ appName: "furniture-catalog" });
		expect(call).toHaveBeenCalledTimes(2);
		expect(call.mock.calls[1][0]).toContain("Design it.");
		expect(call.mock.calls[1][0]).toContain("tiers");
	});

	it("throws after a second invalid answer", async () => {
		const call = vi.fn(async () => "I could not decide.");

		await expect(
			agentJson(call, deployPlanSchema, "Design it.", "architect"),
		).rejects.toThrow("invalid structured output");
		expect(call).toHaveBeenCalledTimes(2);
	});
});

describe("slug", () => {
	// A user or app name becomes a path in the apps repository and part of a
	// Render resource name.
	it("rejects names that are unsafe in a path or a resource name", () => {
		for (const name of ["demo", "furniture-catalog", "shop2"]) {
			expect(slug.safeParse(name).success).toBe(true);
		}
		for (const name of [
			"../etc",
			"Demo User",
			"apps/demo",
			"-shop",
			"ab",
			"x".repeat(40),
		]) {
			expect(slug.safeParse(name).success).toBe(false);
		}
	});
});

describe("manifestSchema", () => {
	// Render takes one or the other. With neither, the Blueprint would get an
	// empty property.
	it("requires exactly one of property and envVarKey on fromService", () => {
		const accepts = (fromService: Record<string, string>) =>
			manifestSchema.safeParse({
				services: [
					{
						name: "web",
						kind: "static_site",
						rootDir: "web",
						buildCommand: "npm run build",
						envVars: [{ key: "VITE_API_HOST", fromService }],
					},
				],
			}).success;

		expect(
			accepts({ name: "api", envVarKey: "RENDER_EXTERNAL_HOSTNAME" }),
		).toBe(true);
		expect(accepts({ name: "api", property: "hostport" })).toBe(true);
		expect(accepts({ name: "api" })).toBe(false);
		expect(
			accepts({
				name: "api",
				property: "host",
				envVarKey: "RENDER_EXTERNAL_HOSTNAME",
			}),
		).toBe(false);
	});
});

/**
 * The deploy manager runs only after Render reported a failed deploy. An
 * "allHealthy" answer once sent such a run to the smoke checks, which can
 * pass against the last live deploy.
 */
describe("deployDiagnosisSchema", () => {
	it("is only a list of failures, with no way to declare the services healthy", () => {
		expect(
			deployDiagnosisSchema.parse({ allHealthy: true, failures: [] }),
		).toEqual({ failures: [] });
		expect(deployDiagnosisSchema.safeParse({ allHealthy: true }).success).toBe(
			false,
		);
	});
});
