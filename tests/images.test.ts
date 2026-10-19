/**
 * The photographs of an app. No test calls Commons: each test replaces fetch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	bestCandidate,
	type CommonsCandidate,
	collectImages,
	commonsQueries,
} from "../app/images.js";
import type { Sandbox } from "../app/sandbox.js";

const APP_DIR = "/home/user/repo/apps/demo/shop";
const THUMB = "https://upload.wikimedia.org/thumb/walnut_chair.jpg";
const COMMONS = "https://commons.wikimedia.org/";

/** One search result, as the Commons API sends it. */
function commonsPage(url = THUMB) {
	return {
		query: {
			pages: [
				{
					title: "File:Walnut chair.jpg",
					imageinfo: [
						{
							thumburl: url,
							thumbwidth: 1200,
							thumbheight: 900,
							width: 4000,
							height: 3000,
							extmetadata: {
								Artist: { value: "<a>Jane Doe</a>" },
								LicenseShortName: { value: "CC BY-SA 4.0" },
							},
						},
					],
				},
			],
		},
	};
}

describe("collectImages", () => {
	let writeFile: ReturnType<typeof vi.fn>;
	let sandbox: Sandbox;

	/**
	 * Commons finds `url` for each search, and each image download gets the
	 * response that `image` gives.
	 */
	function serve(
		image: (url: string) => Response,
		url: string = THUMB,
	): void {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (request: string | URL | Request) => {
				const target = String(request);
				return target.startsWith(COMMONS)
					? Response.json(commonsPage(url))
					: image(target);
			}),
		);
	}

	const jpeg = () =>
		new Response(new Uint8Array([0xff, 0xd8, 0xff]), {
			headers: { "content-type": "image/jpeg" },
		});

	beforeEach(() => {
		writeFile = vi.fn(async () => undefined);
		sandbox = { writeFile } as unknown as Sandbox;
		vi.spyOn(console, "warn").mockImplementation(() => {});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	it("downloads a photograph for each subject into the assets directory", async () => {
		serve(jpeg);

		const images = await collectImages(sandbox, APP_DIR, ["Walnut chair"]);

		expect(images).toEqual([
			{
				path: "assets/walnut-chair.jpg",
				subject: "Walnut chair",
				credit: "Jane Doe / Wikimedia Commons (CC BY-SA 4.0)",
			},
		]);
		expect(writeFile).toHaveBeenCalledWith(
			`${APP_DIR}/assets/walnut-chair.jpg`,
			expect.any(Buffer),
		);
	});

	// Photographs are decoration. A failed subject gives one fewer, not a
	// failed run.
	it.each([
		["a response that is not an image", () => new Response("<html>")],
		[
			"an image over the size limit",
			() =>
				new Response(new Uint8Array(3 * 1024 * 1024), {
					headers: { "content-type": "image/jpeg" },
				}),
		],
		["a failed download", () => new Response("", { status: 503 })],
	])("leaves out a subject with %s", async (_label, image) => {
		serve(image);

		expect(await collectImages(sandbox, APP_DIR, ["Walnut chair"])).toEqual(
			[],
		);
		expect(writeFile).not.toHaveBeenCalled();
		expect(console.warn).toHaveBeenCalledWith(
			expect.stringContaining('"event":"image_skipped"'),
		);
	});

	// The URL comes from Commons, but it is still data from the internet.
	it.each([
		"http://upload.wikimedia.org/thumb/walnut_chair.jpg",
		"https://evil.example/walnut_chair.jpg",
	])("does not download %s", async (url) => {
		const image = vi.fn(jpeg);
		serve(image, url);

		expect(await collectImages(sandbox, APP_DIR, ["Walnut chair"])).toEqual(
			[],
		);
		expect(image).not.toHaveBeenCalled();
	});

	const redirect = (location: string) =>
		new Response(null, { status: 302, headers: { location } });

	it("follows a redirect to an allowed host", async () => {
		const moved = "https://thumb.wikimedia.org/walnut_chair.jpg";
		const image = vi.fn((url: string) =>
			url === THUMB ? redirect(moved) : jpeg(),
		);
		serve(image);

		expect(await collectImages(sandbox, APP_DIR, ["Walnut chair"])).toHaveLength(
			1,
		);
		expect(image.mock.calls.map(([url]) => url)).toEqual([THUMB, moved]);
		const downloads = vi
			.mocked(fetch)
			.mock.calls.filter(([url]) => !String(url).startsWith(COMMONS));
		expect(downloads.map(([, init]) => init?.redirect)).toEqual([
			"manual",
			"manual",
		]);
	});

	// An allowed host can redirect anywhere, so each hop is checked again.
	it.each([
		["a host that is not allowed", "https://evil.example/walnut_chair.jpg"],
		["http", "http://upload.wikimedia.org/walnut_chair.jpg"],
	])("does not follow a redirect to %s", async (_label, location) => {
		const image = vi.fn((url: string) =>
			url === THUMB ? redirect(location) : jpeg(),
		);
		serve(image);

		expect(await collectImages(sandbox, APP_DIR, ["Walnut chair"])).toEqual(
			[],
		);
		expect(image).toHaveBeenCalledOnce();
		expect(writeFile).not.toHaveBeenCalled();
	});

	it("stops after a few redirects", async () => {
		const image = vi.fn(() => redirect(THUMB));
		serve(image);

		expect(await collectImages(sandbox, APP_DIR, ["Walnut chair"])).toEqual(
			[],
		);
		expect(image).toHaveBeenCalledTimes(4);
		expect(console.warn).toHaveBeenCalledWith(
			expect.stringContaining("too many redirects"),
		);
	});

	it("refuses a body whose content-length is over the size limit", async () => {
		serve(
			() =>
				new Response(new Uint8Array([0xff, 0xd8, 0xff]), {
					headers: {
						"content-type": "image/jpeg",
						"content-length": String(3 * 1024 * 1024),
					},
				}),
		);

		expect(await collectImages(sandbox, APP_DIR, ["Walnut chair"])).toEqual(
			[],
		);
		expect(console.warn).toHaveBeenCalledWith(
			expect.stringContaining(`${3 * 1024 * 1024} bytes exceeds the limit`),
		);
	});

	// A body with no content-length can be as large as the server likes.
	it("stops reading a body once it is over the size limit", async () => {
		let pulls = 0;
		const cancel = vi.fn();
		const endless = new ReadableStream<Uint8Array>({
			pull(controller) {
				pulls++;
				controller.enqueue(new Uint8Array(1024 * 1024));
			},
			cancel,
		});
		serve(
			() =>
				new Response(endless, { headers: { "content-type": "image/jpeg" } }),
		);

		expect(await collectImages(sandbox, APP_DIR, ["Walnut chair"])).toEqual(
			[],
		);
		expect(cancel).toHaveBeenCalledOnce();
		expect(pulls).toBeLessThanOrEqual(4);
		expect(writeFile).not.toHaveBeenCalled();
	});
});

/**
 * Commons requires every term to match, so a five-word subject finds nothing.
 */
describe("commonsQueries", () => {
	it("shortens a prose subject, longest first", () => {
		expect(commonsQueries("Beneteau Oceanis sailboat sailing offshore")).toEqual(
			[
				"Beneteau Oceanis sailboat sailing offshore",
				"beneteau oceanis sailboat sailing offshore",
				"beneteau oceanis sailboat sailing",
				"beneteau oceanis sailboat",
				"beneteau oceanis",
			],
		);
	});

	it("drops words Commons gains nothing from matching", () => {
		expect(commonsQueries("sailboat cockpit and wheel helm closeup")).toContain(
			"sailboat cockpit wheel helm",
		);
	});

	it("leaves an already short subject as a single search", () => {
		expect(commonsQueries("walnut chair")).toEqual(["walnut chair"]);
	});

	it("survives punctuation and empty input", () => {
		expect(commonsQueries("  ")).toEqual([]);
		expect(commonsQueries("Hallberg-Rassy cruising sailboat!")).toContain(
			"hallberg-rassy cruising sailboat",
		);
	});
});

/**
 * Real candidates for "pocket gopher". Every thumbnail comes back at the
 * requested box, so thumbnail size says nothing about quality — sorting by it
 * picked the tallest image, which was a 1.8 MB portrait, and shipped it into a
 * landing page.
 */
describe("bestCandidate", () => {
	const candidate = (
		title: string,
		sourceWidth: number,
		sourceHeight: number,
	): CommonsCandidate => ({
		title,
		url: `https://upload.wikimedia.org/${title}.jpg`,
		width: 1200,
		height: sourceWidth >= sourceHeight ? 900 : 1200,
		sourceWidth,
		sourceHeight,
		credit: "someone / Wikimedia Commons (CC BY-SA 4.0)",
	});

	it("prefers a large landscape source over a taller one", () => {
		const pick = bestCandidate([
			candidate("portrait", 1151, 2048),
			candidate("mounds", 4000, 3000),
			candidate("closeup", 2048, 1536),
		]);
		expect(pick?.title).toBe("mounds");
	});

	it("skips a source too small to fill the thumbnail it would be upscaled to", () => {
		const pick = bestCandidate([
			candidate("tiny-but-wide", 450, 326),
			candidate("real", 2048, 1536),
		]);
		expect(pick?.title).toBe("real");
	});

	it("takes a portrait when no landscape source qualifies", () => {
		expect(bestCandidate([candidate("portrait", 1568, 1735)])?.title).toBe(
			"portrait",
		);
	});

	it("falls back to a small source rather than returning nothing", () => {
		expect(bestCandidate([candidate("tiny", 450, 326)])?.title).toBe("tiny");
	});

	it("has nothing to pick from an empty list", () => {
		expect(bestCandidate([])).toBeUndefined();
	});
});
