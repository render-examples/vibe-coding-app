/**
 * The browser UI: the prompt form, the table of runs, the selected run with
 * its stage table, and the delete dialog. Postgres is the source of truth, so
 * every render comes from the gateway's list of runs.
 */

/** A task still owns these runs, so the page keeps reading them. */
const activeStatuses = ["running", "deleting"];
const healthyStatuses = [...activeStatuses, "deployed", "awaiting_blueprint"];
/** How long the page waits before it reads the runs again. */
const REFRESH_MS = 5000;
const SELECTED_RUN_KEY = "vibe-code-selected-run";
const linkLabels = { workflowRun: "Workflow run", sandbox: "Sandbox" };

const form = document.querySelector("#prompt-form");
const formError = document.querySelector("#form-error");
const submit = form.querySelector("button");
const emptyHistory = document.querySelector("#empty-history");
const refreshRuns = document.querySelector("#refresh-runs");
const sites = document.querySelector("#sites");
const siteRows = document.querySelector("#site-rows");
const runPanel = document.querySelector("#run-panel");
const status = document.querySelector("#status");
const activity = document.querySelector("#activity");
const progress = document.querySelector("#progress");
const result = document.querySelector("#result");
const resultName = document.querySelector("#result-name");
const webUrl = document.querySelector("#web-url");
const summary = document.querySelector("#summary");
const runDetails = document.querySelector("#run-details");
const stages = document.querySelector("#stages");
const deleteDialog = document.querySelector("#delete-dialog");
const deleteForm = document.querySelector("#delete-form");
const deleteTitle = document.querySelector("#delete-title");
const deleteDescription = document.querySelector("#delete-description");
const deleteConfirmField = document.querySelector("#delete-confirm-field");
const deleteAppName = document.querySelector("#delete-app-name");
const deleteConfirm = document.querySelector("#delete-confirm");
const deleteError = document.querySelector("#delete-error");
const deleteSubmit = document.querySelector("#delete-submit");
const deleteCancel = document.querySelector("#delete-cancel");

/**
 * The stage rows are static HTML. A refresh changes only their classes and
 * cells, so a screen reader does not read the table again.
 */
const stageRows = [...stages.querySelectorAll("tr[data-stage]")];
const stageOrder = stageRows.map((row) => row.dataset.stage);
const timeCells = new Map(
	stageRows.map((row) => [row.dataset.stage, row.querySelector(".stage-time")]),
);
const linkCells = [...stages.querySelectorAll("[data-links]")];

let runs = [];
let selectedRunId = null;
/** The selected run as JSON. A refresh renders the run panel only when it changes. */
let shownRun = null;
/** The links in the stage table, so a refresh changes them only when they change. */
let shownLinks = null;
/** The time of each stage of the selected run, from the last read. */
let stageTimes = new Map();
let refreshTimer;
/** The number of reads of the runs. Only the newest read changes the page. */
let reads = 0;

/**
 * The button is busy only while the gateway accepts the prompt. Then the form
 * takes the next prompt, and the runs build in parallel.
 */
form.addEventListener("submit", async (event) => {
	event.preventDefault();
	setSubmitting(true);
	formError.textContent = "";
	try {
		const runId = await submitPrompt(form.prompt.value);
		form.reset();
		loadRuns(runId).catch(showFailure);
	} catch (error) {
		formError.textContent = messageOf(error);
	} finally {
		setSubmitting(false);
	}
});

refreshRuns.addEventListener("click", () => {
	loadRuns().catch(showFailure);
});

deleteConfirm.addEventListener("input", () => {
	deleteSubmit.disabled = deleteConfirm.value.trim() !== deleteForm.dataset.appName;
});

deleteCancel.addEventListener("click", () => deleteDialog.close());

/**
 * The dialog stays open until the gateway accepts the delete, and shows the
 * error of a delete that fails. The run panel cannot show it: the next
 * refresh renders the run panel again.
 */
deleteForm.addEventListener("submit", async (event) => {
	event.preventDefault();
	const { runId } = deleteForm.dataset;
	deleteSubmit.disabled = true;
	deleteError.textContent = "";
	try {
		await deleteRun(runId);
	} catch (error) {
		deleteError.textContent = messageOf(error);
		deleteSubmit.disabled = false;
		return;
	}
	deleteDialog.close();
	// Each run of the app is deleting now. A run with no app is gone.
	loadRuns(runId).catch(showFailure);
});

// Four times each second, so the timer shows each second. A timer that runs
// once each second can skip a second when it runs late.
setInterval(renderTimes, 250);

loadRuns(localStorage.getItem(SELECTED_RUN_KEY)).catch(showFailure);

/**
 * Read the runs, and select the preferred run, the selected run, or the
 * newest run. While a task owns a run, read them again after REFRESH_MS. A
 * failed read is tried again too, so a short gateway outage does not stop the
 * updates.
 */
async function loadRuns(preferredRunId) {
	window.clearTimeout(refreshTimer);
	const read = ++reads;
	try {
		const response = await fetch("/ui/apps");
		const body = response.ok ? await response.json() : null;
		// A newer read started, for example after a submit.
		if (read !== reads) return;
		if (!body) throw new Error(`Could not load run history (${response.status})`);
		runs = body.runs || [];
		const listed = (runId) => runs.some((run) => run.runId === runId);
		selectRun(
			[preferredRunId, selectedRunId].find((runId) => runId && listed(runId)) ??
				runs[0]?.runId ??
				null,
		);
	} finally {
		if (read === reads && runs.some((run) => activeStatuses.includes(run.status))) {
			refreshTimer = window.setTimeout(() => loadRuns().catch(showFailure), REFRESH_MS);
		}
	}
}

function selectRun(runId) {
	selectedRunId = runId;
	if (runId) localStorage.setItem(SELECTED_RUN_KEY, runId);
	renderHistory();
	renderSelectedRun();
}

/* ── The table of runs ────────────────────────────────────────────────── */

/** The rows are replaced, so the focus goes back to the same control. */
function renderHistory() {
	emptyHistory.hidden = runs.length > 0;
	sites.hidden = runs.length === 0;
	const focusKey = document.activeElement?.dataset.focusKey;
	siteRows.replaceChildren(...runs.map(historyRow));
	if (focusKey) {
		document.querySelector(`[data-focus-key="${CSS.escape(focusKey)}"]`)?.focus();
	}
}

function historyRow(run) {
	const selected = run.runId === selectedRunId;
	const row = document.createElement("tr");
	row.className = selected ? "selected" : "";
	// A click anywhere on the row selects it, except on its link or its button.
	row.addEventListener("click", (event) => {
		if (!event.target.closest("a, button")) selectRun(run.runId);
	});

	const name = document.createElement("button");
	name.type = "button";
	name.className = "site-name";
	name.textContent = run.appName || truncate(run.prompt, 34);
	name.setAttribute("aria-pressed", String(selected));
	name.dataset.focusKey = `${run.runId}:name`;
	name.addEventListener("click", () => selectRun(run.runId));
	const nameCell = document.createElement("th");
	nameCell.scope = "row";
	nameCell.append(name);

	const state = document.createElement("span");
	state.className = "run-state";
	state.dataset.status = run.status;
	state.textContent = statusLabel(run);

	const remove = document.createElement("button");
	remove.type = "button";
	remove.className = "danger-button table-button";
	remove.textContent = "Delete";
	remove.setAttribute("aria-label", `Delete ${run.appName || "this run"}`);
	remove.hidden = activeStatuses.includes(run.status);
	remove.dataset.focusKey = `${run.runId}:delete`;
	remove.addEventListener("click", () => openDeleteDialog(run));

	row.append(
		nameCell,
		cell(state),
		cell(run.urls?.web ? siteLink(run.urls.web, run.runId) : none()),
		cell(generationTime(run)),
		cell(formatDate(run.createdAt)),
		cell(remove),
	);
	return row;
}

/* ── The selected run ─────────────────────────────────────────────────── */

function renderSelectedRun() {
	const run = runs.find((candidate) => candidate.runId === selectedRunId);
	if (!run) {
		runPanel.hidden = true;
		shownRun = null;
		return;
	}
	// The run panel is a live region, so change it only when the run changes.
	const json = JSON.stringify(run);
	if (json === shownRun) return;
	shownRun = json;
	renderRun(run);
}

function renderRun(run) {
	runPanel.hidden = false;
	runPanel.classList.toggle("failed", !healthyStatuses.includes(run.status));
	status.textContent = statusLabel(run);
	progress.textContent = run.progress || "";
	activity.hidden = !activeStatuses.includes(run.status);
	// The stages are those of a build, so a delete does not show them.
	stages.hidden = ["deleting", "delete_failed"].includes(run.status);

	const current = stageOrder.indexOf(run.stage);
	stageRows.forEach((row, index) => {
		let state = "";
		if (index < current || run.status === "deployed") state = "complete";
		if (index === current && run.status === "running") state = "active";
		if (
			index === current &&
			!["running", "deployed", "awaiting_blueprint"].includes(run.status)
		) {
			state = "failed-stage";
		}
		row.className = state;
	});

	const deployed = run.status === "deployed" && Boolean(run.urls?.web);
	result.hidden = !deployed;
	if (deployed) {
		resultName.textContent = titleFromSlug(run.appName) || "Your website";
		summary.textContent = resultSummary(run.summary);
		webUrl.href = run.urls.web;
	}

	const showDetails =
		!activeStatuses.includes(run.status) && run.status !== "deployed" && Boolean(run.summary);
	runDetails.hidden = !showDetails;
	runDetails.textContent = showDetails ? run.summary : "";

	stageTimes = timesOfStages(run.stageHistory ?? []);
	renderTimes();
	renderLinks(run);
}

/**
 * How long the run was in each stage. A stage entered more than once adds up
 * its times. `runningSince` is when the current stage started, or null for a
 * stage that stopped.
 */
function timesOfStages(history) {
	const times = new Map();
	for (const { stage, startedAt, finishedAt } of history) {
		const time = times.get(stage) ?? { elapsed: 0, runningSince: null };
		if (finishedAt) time.elapsed += Date.parse(finishedAt) - Date.parse(startedAt);
		else time.runningSince = Date.parse(startedAt);
		times.set(stage, time);
	}
	return times;
}

/**
 * A read gives the times of the stages. Between reads, the timer adds the time
 * since the current stage started. A stage that did not start has no time.
 */
function renderTimes() {
	const now = Date.now();
	for (const [stage, timeCell] of timeCells) {
		const time = stageTimes.get(stage);
		const running = time && time.runningSince !== null ? now - time.runningSince : 0;
		const text = time ? formatDuration(time.elapsed + running) : "";
		// The timer runs four times each second, so write only a time that changed.
		if (timeCell.textContent !== text) timeCell.textContent = text;
	}
}

/**
 * Each stage links to the Render Dashboard pages where it runs: the workflow
 * run, which lists its subtasks, and the run's sandbox. The gateway gives null
 * for a link it cannot make.
 */
function renderLinks(run) {
	const links = JSON.stringify(run.links ?? {});
	if (links === shownLinks) return;
	shownLinks = links;
	for (const linkCell of linkCells) {
		const anchors = linkCell.dataset.links
			.split(" ")
			.filter((name) => run.links?.[name])
			.map((name) => externalLink(run.links[name], linkLabels[name]));
		linkCell.replaceChildren(...(anchors.length > 0 ? anchors : [none()]));
	}
}

/** A read of the runs failed. The next read that succeeds shows the run again. */
function showFailure(error) {
	shownRun = null;
	runPanel.hidden = false;
	runPanel.classList.add("failed");
	status.textContent = "Request failed";
	progress.textContent = messageOf(error);
}

/* ── Delete ───────────────────────────────────────────────────────────── */

/**
 * A delete removes the app on Render and in the apps repository, with all of
 * its runs, and cannot be undone. So the dialog asks for the app's name, as
 * hosting dashboards do.
 */
function openDeleteDialog(run) {
	const appName = run.appName || "";
	deleteForm.dataset.runId = run.runId;
	deleteForm.dataset.appName = appName;
	deleteTitle.textContent = appName ? `Delete ${titleFromSlug(appName)}?` : "Delete this run?";
	deleteDescription.textContent = appName
		? "This deletes the app's services and databases on Render, with all their data, " +
			"and removes its files from the apps repository. Every run of this app leaves your " +
			"history. You cannot undo this."
		: "This run did not create an app, so only the run leaves your history.";
	deleteConfirmField.hidden = !appName;
	deleteAppName.textContent = appName;
	deleteConfirm.value = "";
	deleteError.textContent = "";
	deleteSubmit.disabled = Boolean(appName);
	deleteDialog.showModal();
	(appName ? deleteConfirm : deleteSubmit).focus();
}

/* ── Gateway calls ────────────────────────────────────────────────────── */

/** Start a run. The gateway gives its ID, or an error that the form shows. */
async function submitPrompt(prompt) {
	const response = await fetch("/ui/apps", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ prompt }),
	});
	const body = await response.json().catch(() => ({}));
	if (!response.ok || !body.runId) {
		throw new Error(body.detail || body.error || `Request failed (${response.status})`);
	}
	return body.runId;
}

async function deleteRun(runId) {
	const response = await fetch(`/ui/apps/${encodeURIComponent(runId)}`, {
		method: "DELETE",
	});
	const body = await response.json().catch(() => ({}));
	if (!response.ok) {
		throw new Error(body.error || `Delete failed (${response.status})`);
	}
}

/* ── Formatting ───────────────────────────────────────────────────────── */

function setSubmitting(submitting) {
	submit.disabled = submitting;
	submit.textContent = submitting ? "Submitting…" : "Build and deploy";
}

function messageOf(error) {
	return error instanceof Error ? error.message : String(error);
}

/** The stage of a run that builds, or else its status. */
function statusLabel(run) {
	return run.status === "running" ? label(run.stage || "queued") : label(run.status);
}

function label(value) {
	return value.replaceAll("_", " ").replace(/\b\w/g, (character) => character.toUpperCase());
}

function truncate(value, length) {
	return value.length > length ? `${value.slice(0, length - 1)}…` : value;
}

function titleFromSlug(value) {
	return value ? label(value.replaceAll("-", " ")) : "";
}

function resultSummary(value) {
	if (!value) return "Your website is ready.";
	const built = value.split(/\n\s*\n/)[0].replace(/\s+/g, " ").trim();
	return truncate(built, 220);
}

function formatDate(value) {
	return new Intl.DateTimeFormat(undefined, {
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
	}).format(new Date(value));
}

/** How long the run took to build and deploy, or how long it has run so far. */
function generationTime(run) {
	const end = run.finishedAt
		? Date.parse(run.finishedAt)
		: run.status === "running"
			? Date.now()
			: null;
	return end === null ? "—" : formatDuration(end - Date.parse(run.createdAt));
}

/** Always with the seconds, so the timer of a stage shows each second. */
function formatDuration(milliseconds) {
	const seconds = Math.max(0, Math.round(milliseconds / 1000));
	const hours = Math.floor(seconds / 3600);
	const minutes = Math.floor((seconds % 3600) / 60);
	if (hours > 0) return `${hours}h ${minutes}m ${seconds % 60}s`;
	if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
	return `${seconds}s`;
}

function cell(content) {
	const td = document.createElement("td");
	td.append(content);
	return td;
}

function siteLink(url, runId) {
	const anchor = externalLink(url, new URL(url).host);
	anchor.className = "site-url";
	anchor.title = url;
	anchor.dataset.focusKey = `${runId}:url`;
	return anchor;
}

function externalLink(url, text) {
	const anchor = document.createElement("a");
	anchor.href = url;
	anchor.target = "_blank";
	anchor.rel = "noreferrer";
	anchor.textContent = text;
	return anchor;
}

function none() {
	const span = document.createElement("span");
	span.className = "none";
	span.textContent = "—";
	return span;
}
