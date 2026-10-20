/**
 * The Blueprint is the factory's only write path to Render, so this suite is
 * the contract for what gets deployed. Each test parses the generated YAML
 * and checks the structure Render would read.
 */
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { factoryConfig } from "../factory.config.js";
import {
	appBlueprint,
	declaredResources,
	joinServiceDir,
	rootBlueprint,
} from "../app/blueprint.js";
import type { AppSpec, Manifest, Service } from "../app/contracts.js";

const api: Service = {
	name: "api",
	kind: "web_service",
	rootDir: "api",
	runtime: "node",
	buildCommand: "npm install",
	startCommand: "npm start",
	preDeployCommand: "npm run migrate",
	healthCheckPath: "/health",
	envVars: [
		{ key: "DATABASE_URL", fromDatabase: { property: "connectionString" } },
	],
};

const web: Service = {
	name: "web",
	kind: "static_site",
	rootDir: "./web/",
	runtime: "static",
	buildCommand: "npm install && npm run build",
	staticPublishPath: "./dist",
	envVars: [
		{
			key: "VITE_API_HOST",
			fromService: { name: "api", envVarKey: "RENDER_EXTERNAL_HOSTNAME" },
		},
	],
};

const fullManifest: Manifest = {
	services: [api, web],
	databases: [{ name: "main-db" }],
};

function spec(overrides: Partial<AppSpec> = {}): AppSpec {
	return {
		user: "demo",
		appName: "shop",
		prompt: "Create an online catalog to sell handcrafted furniture",
		summary: "A storefront, an API, and Postgres behind it.",
		createdAt: "2026-01-01T00:00:00.000Z",
		resourcePrefix: "vibe",
		manifest: fullManifest,
		...overrides,
	};
}

interface ParsedService {
	name: string;
	runtime: string;
	plan?: string;
	region?: string;
	rootDir: string;
	buildCommand: string;
	startCommand?: string;
	preDeployCommand?: string;
	healthCheckPath?: string;
	buildFilter: { paths: string[] };
	envVars?: Record<string, unknown>[];
}

interface ParsedProject {
	name: string;
	environments: {
		name: string;
		services: ParsedService[];
		databases?: { name: string; plan: string; region: string }[];
	}[];
}

function projectsOf(yaml: string): ParsedProject[] {
	return parse(yaml).projects;
}

function onlyEnvironment(yaml: string) {
	const [project] = projectsOf(yaml);
	return project.environments[0];
}

function serviceNamed(yaml: string, name: string): ParsedService {
	const service = onlyEnvironment(yaml).services.find((s) => s.name === name);
	if (!service) throw new Error(`No service ${name}`);
	return service;
}

describe("appBlueprint", () => {
	it("puts a static site, an API, and Postgres in one project, named from the spec's resourcePrefix", () => {
		const yaml = appBlueprint(spec({ resourcePrefix: "acme" }));
		const parsed = parse(yaml);

		expect(parsed.services).toBeUndefined();
		expect(parsed.databases).toBeUndefined();
		expect(parsed.projects).toHaveLength(1);
		const [project] = projectsOf(yaml);
		expect(project.name).toBe("acme-demo-shop");
		expect(project.environments).toHaveLength(1);
		const [environment] = project.environments;
		expect(environment.services.map((s) => s.name)).toEqual([
			"acme-demo-shop-api",
			"acme-demo-shop-web",
		]);
		expect(environment.databases?.map((db) => db.name)).toEqual([
			"acme-demo-shop-db",
		]);
	});

	// A static site is not on the private network, and a browser uses its
	// values, so it gets the API's public hostname, never `host`.
	it("wires DATABASE_URL from the database and the storefront's API host from the API's public hostname", () => {
		const yaml = appBlueprint(spec());

		expect(serviceNamed(yaml, "vibe-demo-shop-api").envVars).toEqual([
			{
				key: "DATABASE_URL",
				fromDatabase: {
					name: "vibe-demo-shop-db",
					property: "connectionString",
				},
			},
		]);
		expect(serviceNamed(yaml, "vibe-demo-shop-web").envVars).toEqual([
			{
				key: "VITE_API_HOST",
				fromService: {
					name: "vibe-demo-shop-api",
					type: "web",
					envVarKey: "RENDER_EXTERNAL_HOSTNAME",
				},
			},
		]);
	});

	it("builds each service from its own directory, and gives a static site no plan or region", () => {
		const yaml = appBlueprint(spec());
		const apiService = serviceNamed(yaml, "vibe-demo-shop-api");
		const webService = serviceNamed(yaml, "vibe-demo-shop-web");

		expect(apiService).toMatchObject({
			runtime: "node",
			plan: factoryConfig.render.servicePlan,
			region: factoryConfig.render.region,
			rootDir: "apps/demo/shop/api",
			buildFilter: { paths: ["apps/demo/shop/api/**"] },
		});
		expect(webService).toMatchObject({
			runtime: "static",
			rootDir: "apps/demo/shop/web",
			buildFilter: { paths: ["apps/demo/shop/web/**"] },
		});
		expect(webService.plan).toBeUndefined();
		expect(webService.region).toBeUndefined();
		expect(onlyEnvironment(yaml).databases?.[0]).toMatchObject({
			plan: factoryConfig.render.databasePlan,
			region: factoryConfig.render.region,
		});
	});

	// Two resources that collapse onto one name overwrite each other in the
	// Blueprint instead of failing.
	it("gives two services of the same kind distinct names", () => {
		const yaml = appBlueprint(
			spec({
				manifest: {
					services: [
						api,
						{ ...api, name: "API", rootDir: "api-v2" },
						web,
						{ ...web, name: "Web", rootDir: "admin" },
					],
					databases: [{ name: "main-db" }, { name: "main db" }],
				},
			}),
		);
		const environment = onlyEnvironment(yaml);
		const names = [
			...environment.services.map((s) => s.name),
			...(environment.databases ?? []).map((db) => db.name),
		];

		expect(names).toHaveLength(6);
		expect(new Set(names).size).toBe(6);
		for (const name of names) expect(name).toMatch(/^vibe-demo-shop-/);
	});
});

describe("rootBlueprint", () => {
	it("holds every app in its own project, sorted, and leaves out an app being deleted", () => {
		const yaml = rootBlueprint([
			spec({ user: "bob", appName: "bakery" }),
			spec({ user: "carol", appName: "cafe", deletedAt: "2026-02-01" }),
			spec({ user: "alice", appName: "atelier" }),
		]);
		const projects = projectsOf(yaml);

		expect(projects.map((project) => project.name)).toEqual([
			"vibe-alice-atelier",
			"vibe-bob-bakery",
		]);
		// A database declared under another app's project would move it there.
		for (const project of projects) {
			const [environment] = project.environments;
			for (const resource of [
				...environment.services,
				...(environment.databases ?? []),
			]) {
				expect(resource.name.startsWith(`${project.name}-`)).toBe(true);
			}
		}
	});

	it("is a valid Blueprint with no apps, including when the last app is being deleted", () => {
		for (const specs of [[], [spec({ deletedAt: "2026-02-01" })]]) {
			const parsed = parse(rootBlueprint(specs));
			expect(parsed.services).toEqual([]);
			expect(parsed.projects).toBeUndefined();
		}
	});

	// One value that breaks the YAML stops the deploy of every app in the root
	// Blueprint. YAML 1.1 parsers (go-yaml) read NEL and U+2028 as line breaks
	// and refuse raw DEL and C1 controls, so those must reach the file escaped.
	it("round-trips hostile free-form values exactly", () => {
		const hostile = {
			buildCommand: 'npm ci && echo "build: done"',
			startCommand: "node server.js # Render sets PORT",
			preDeployCommand: "true",
			healthCheckPath: "/health\u{7}\u{7f}\u{85}--- \u{2028}... \u{2029}x",
		};
		const yaml = rootBlueprint([
			spec({
				prompt: "Sell chairs\u{85}services: []\n# nope",
				manifest: { ...fullManifest, services: [{ ...api, ...hostile }, web] },
			}),
		]);

		expect(yaml).not.toMatch(/[\u{7f}-\u{9f}\u{2028}\u{2029}]/u);
		expect(projectsOf(yaml)).toHaveLength(1);
		expect(serviceNamed(yaml, "vibe-demo-shop-api")).toMatchObject(hostile);
	});
});

describe("joinServiceDir", () => {
	// The manifest is agent-authored. The Blueprint and verify-app both join
	// with this, so they agree on each directory.
	it("tolerates '.', './x', and a rootDir that repeats the app path", () => {
		const app = "apps/demo/shop";
		expect(joinServiceDir(app, ".")).toBe(app);
		expect(joinServiceDir(app, "./")).toBe(app);
		expect(joinServiceDir(app, "./web/")).toBe(`${app}/web`);
		expect(joinServiceDir(app, app)).toBe(app);
		expect(joinServiceDir(app, "shop")).toBe(app);
	});
});

/**
 * A deploy repair must keep this list: Render does not delete a resource that
 * leaves the Blueprint, and it cannot change a service's runtime.
 */
describe("declaredResources", () => {
	it("lists the resources a repair must keep, whatever the repair changes in place", () => {
		const repaired = spec({
			manifest: {
				...fullManifest,
				services: fullManifest.services.map((service) => ({
					...service,
					rootDir: `${service.rootDir}-v2`,
					buildCommand: "npm ci && npm run build",
					envVars: [],
				})),
			},
		});

		expect(declaredResources(spec())).toEqual([
			"vibe-demo-shop-api (node)",
			"vibe-demo-shop-db (postgres)",
			"vibe-demo-shop-web (static)",
		]);
		expect(declaredResources(repaired)).toEqual(declaredResources(spec()));
	});
});
