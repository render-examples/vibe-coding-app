/**
 * The photographs of an app. No test calls Commons: each test replaces fetch.
 * Photographs are decoration, so a bad download leaves a subject out rather
 * than failing the run.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	bestCandidate,
	type CommonsCandidate,
	collectImages,
} from "../app/images.js";
import type { Sandbox } from "../app/sandbox.js";

const APP_DIR = "/home/user/repo/apps/demo/shop";
const COMMONS = "https://commons.wikimedia.org/";
const UPLOAD = "https://upload.wikimedia.org/thumb";

/** One Commons search result. */
function page(title: string, url: string, width: number, height: number) {
	return {
		title,
		imageinfo: [
			{
				thumburl: url,
				thumbwidth: 1200,
				thumbheight: Math.round((1200 * height) / width),
				width,
				height,
				extmetadata: {
					Artist: { value: "<a>Jane Doe</a>" },
					LicenseShortName: { value: "CC BY-SA 4.0" },
				},
			},
		],
	};
}

const jpeg = () =>
	new Response(new Uint8Array([0xff, 0xd8, 0xff]), {
		headers: { "content-type": "image/jpeg" },
	});

let writeFile: ReturnType<typeof vi.fn>;
let sandbox: Sandbox;
/** Each URL fetched outside the Commons search API. */
let downloads: string[];

/**
 * Each Commons search for a subject finds `results[subject]`, and each
 * download of a URL gets `files[url]`, or a 404.
 */
function serve(
	results: Record<string, ReturnType<typeof page>[]>,
	files: Record<string, () => Response>,
): void {
	vi.stubGlobal(
		"fetch",
		vi.fn(async (request: string | URL | Request) => {
			const url = String(request);
			if (url.startsWith(COMMONS)) {
				const query = new URL(url).searchParams.get("gsrsearch") ?? "";
				const subject = query.replace(/^filetype:bitmap /, "");
				return Response.json({ query: { pages: results[subject] ?? [] } });
			}
			downloads.push(url);
			return files[url]?.() ?? new Response("", { status: 404 });
		}),
	);
}

beforeEach(() => {
	writeFile = vi.fn(async () => undefined);
	sandbox = { writeFile } as unknown as Sandbox;
	downloads = [];
	vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("collectImages", () => {
	it("downloads the best wide photo into assets/ under a generated name", async () => {
		serve(
			{
				"Walnut chair!": [
					page("File:Portrait.jpg", `${UPLOAD}/portrait.jpg`, 3000, 4000),
					page("File:Wide.jpg", `${UPLOAD}/wide.jpg`, 4000, 3000),
				],
			},
			{ [`${UPLOAD}/wide.jpg`]: jpeg, [`${UPLOAD}/portrait.jpg`]: jpeg },
		);

		expect(await collectImages(sandbox, APP_DIR, ["Walnut chair!"])).toEqual([
			{
				path: "assets/walnut-chair.jpg",
				subject: "Walnut chair!",
				credit: "Jane Doe / Wikimedia Commons (CC BY-SA 4.0)",
			},
		]);
		expect(downloads).toEqual([`${UPLOAD}/wide.jpg`]);
		expect(writeFile).toHaveBeenCalledWith(
			`${APP_DIR}/assets/walnut-chair.jpg`,
			expect.any(Buffer),
		);
	});

	// An allowed host can redirect anywhere, so each hop is checked again.
	it("skips a photo that redirects to a host off the allowlist", async () => {
		serve(
			{ chair: [page("File:Chair.jpg", `${UPLOAD}/chair.jpg`, 4000, 3000)] },
			{
				[`${UPLOAD}/chair.jpg`]: () =>
					new Response(null, {
						status: 302,
						headers: { location: "https://evil.example/chair.jpg" },
					}),
				"https://evil.example/chair.jpg": jpeg,
			},
		);

		expect(await collectImages(sandbox, APP_DIR, ["chair"])).toEqual([]);
		expect(downloads).toEqual([`${UPLOAD}/chair.jpg`]);
		expect(writeFile).not.toHaveBeenCalled();
	});

	it("skips a non-image response and a body over the size cap, and keeps the other subjects", async () => {
		serve(
			{
				chair: [page("File:Chair.jpg", `${UPLOAD}/chair.jpg`, 4000, 3000)],
				table: [page("File:Table.jpg", `${UPLOAD}/table.jpg`, 4000, 3000)],
				lamp: [page("File:Lamp.jpg", `${UPLOAD}/lamp.jpg`, 4000, 3000)],
			},
			{
				[`${UPLOAD}/chair.jpg`]: jpeg,
				[`${UPLOAD}/table.jpg`]: () => new Response("<html>"),
				// No content-length, so only the read can stop it.
				[`${UPLOAD}/lamp.jpg`]: () =>
					new Response(
						new ReadableStream({
							pull(controller) {
								controller.enqueue(new Uint8Array(1024 * 1024));
							},
						}),
						{ headers: { "content-type": "image/jpeg" } },
					),
			},
		);

		const images = await collectImages(sandbox, APP_DIR, [
			"chair",
			"table",
			"lamp",
		]);

		expect(images.map((image) => image.subject)).toEqual(["chair"]);
		expect(writeFile).toHaveBeenCalledOnce();
	});
});

/**
 * Every thumbnail comes back at the requested width, so thumbnail size says
 * nothing about quality: ranking by it once picked a 1.8 MB portrait.
 */
describe("bestCandidate", () => {
	const candidate = (
		title: string,
		sourceWidth: number,
		sourceHeight: number,
	): CommonsCandidate => ({
		title,
		url: `${UPLOAD}/${title}.jpg`,
		width: 1200,
		height: Math.round((1200 * sourceHeight) / sourceWidth),
		sourceWidth,
		sourceHeight,
		credit: "someone / Wikimedia Commons (CC BY-SA 4.0)",
	});

	it("prefers a wide, high-resolution source", () => {
		const pick = bestCandidate([
			candidate("tall-portrait", 3000, 6000),
			candidate("tiny-but-wide", 450, 300),
			candidate("wide", 2048, 1536),
			candidate("large-wide", 4000, 3000),
		]);

		expect(pick?.title).toBe("large-wide");
	});
});
