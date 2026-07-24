const form = document.querySelector("#runner-form");
const statusBox = document.querySelector("#status");
const runButton = document.querySelector("#run-button");

const savedFields = ["owner", "repo", "workflow", "workbook_path", "username"];
const branch = "main";
const pollDelayMs = 15000;
const runLookupDelayMs = 5000;

for (const field of savedFields) {
  const value = localStorage.getItem(`myrt:${field}`);
  if (value) document.querySelector(`#${field}`).value = value;
}

function toMdy(dateValue) {
  const [year, month, day] = dateValue.split("-");
  return `${month}/${day}/${year}`;
}

function setStatus(message, kind = "") {
  statusBox.className = `status ${kind}`.trim();
  statusBox.textContent = message;
}

function setStatusContent(nodes, kind = "") {
  statusBox.className = `status ${kind}`.trim();
  statusBox.replaceChildren(...nodes);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function githubHeaders(token) {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

async function githubFetch(url, token, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      ...githubHeaders(token),
      ...(options.headers || {}),
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`${response.status} ${response.statusText}: ${body || "No response body"}`);
  }

  return response;
}

function workflowRunsUrl(data) {
  const encodedWorkflow = encodeURIComponent(data.workflow);
  return `https://api.github.com/repos/${encodeURIComponent(data.owner)}/${encodeURIComponent(data.repo)}/actions/workflows/${encodedWorkflow}/runs?branch=${branch}&event=workflow_dispatch&per_page=10`;
}

async function getLatestWorkflowRun(data, token) {
  const response = await githubFetch(workflowRunsUrl(data), token);
  const payload = await response.json();
  return payload.workflow_runs[0] || null;
}

async function findStartedRun(data, token, previousRunId) {
  const actionsUrl = `https://github.com/${data.owner}/${data.repo}/actions/workflows/${data.workflow}`;

  for (let attempt = 0; attempt < 24; attempt += 1) {
    const latest = await getLatestWorkflowRun(data, token);

    if (latest && latest.id !== previousRunId) return latest;
    setStatus(`Workflow started. Waiting for GitHub to publish the run...`, "pending");
    await sleep(runLookupDelayMs);
  }

  throw new Error(`The workflow started, but GitHub did not return the new run yet. Open ${actionsUrl} to watch it.`);
}

async function waitForRun(data, token, run) {
  const runUrl = `https://api.github.com/repos/${encodeURIComponent(data.owner)}/${encodeURIComponent(data.repo)}/actions/runs/${run.id}`;

  while (true) {
    const response = await githubFetch(runUrl, token);
    const latest = await response.json();
    const actionsUrl = `https://github.com/${data.owner}/${data.repo}/actions/runs/${latest.id}`;

    if (latest.status === "completed") {
      if (latest.conclusion !== "success") {
        throw new Error(`Workflow finished with status "${latest.conclusion}". Open ${actionsUrl} for logs.`);
      }
      return latest;
    }

    setStatus(`Run #${latest.run_number} is ${latest.status}. Waiting for GitHub to finish...`, "pending");
    await sleep(pollDelayMs);
  }
}

async function getRunArtifact(data, token, run) {
  const artifactsUrl = `https://api.github.com/repos/${encodeURIComponent(data.owner)}/${encodeURIComponent(data.repo)}/actions/runs/${run.id}/artifacts`;
  const response = await githubFetch(artifactsUrl, token);
  const payload = await response.json();
  const artifact = payload.artifacts.find((item) => item.name.startsWith("myrt-invoice-output-"));

  if (!artifact) {
    throw new Error("Workflow completed, but no output artifact was found.");
  }

  return artifact;
}

async function makeArtifactDownload(data, token, artifact) {
  const downloadUrl = `https://api.github.com/repos/${encodeURIComponent(data.owner)}/${encodeURIComponent(data.repo)}/actions/artifacts/${artifact.id}/zip`;
  const response = await githubFetch(downloadUrl, token);
  const blob = await response.blob();
  return URL.createObjectURL(blob);
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(form).entries());
  const token = data.token;

  for (const field of savedFields) {
    localStorage.setItem(`myrt:${field}`, data[field]);
  }

  runButton.disabled = true;
  setStatus("Checking the latest GitHub Actions run...");
  document.querySelector("#token").value = "";

  try {
    const previousRun = await getLatestWorkflowRun(data, token);
    const previousRunId = previousRun ? previousRun.id : null;

    setStatus("Starting GitHub Actions workflow...");
    await githubFetch(
      `https://api.github.com/repos/${encodeURIComponent(data.owner)}/${encodeURIComponent(data.repo)}/actions/workflows/${encodeURIComponent(data.workflow)}/dispatches`,
      token,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          ref: branch,
          inputs: {
            workbook_path: data.workbook_path,
            start_date: toMdy(data.start_date),
            end_date: toMdy(data.end_date),
            username: data.username,
          },
        }),
      },
    );

    setStatus("Workflow started. Finding the run on GitHub...");
    const run = await findStartedRun(data, token, previousRunId);
    await waitForRun(data, token, run);

    setStatus("Workflow complete. Preparing the download...");
    const artifact = await getRunArtifact(data, token, run);
    const objectUrl = await makeArtifactDownload(data, token, artifact);
    const message = document.createTextNode("Done. ");
    const link = document.createElement("a");
    link.href = objectUrl;
    link.download = `${artifact.name}.zip`;
    link.textContent = "Download final workbook and screenshots";
    const suffix = document.createTextNode(".");

    setStatusContent([message, link, suffix], "success");
  } catch (error) {
    setStatus(`Automation failed. ${error.message}`, "error");
  } finally {
    runButton.disabled = false;
  }
});
