"use strict";
const core = require("@actions/core");
/**
 * Convert input string to boolean.
 * - Treats empty / undefined input as false.
 * - Returns true for values not in the falsyValues list.
 * @param {string|undefined} input
 * @param {string[]} falsyValues
 * @returns {boolean}
 */
const parseBoolean = (input, falsyValues = ["0", "no", "n", "false"]) => {
  /* prettier-ignore */
  const normalized = String(input ?? "false").trim().toLowerCase();
  return !falsyValues.includes(normalized);
};
/**
 * Split a comma- or pipe-separated pattern into trimmed items.
 * If pattern is empty/undefined returns an empty array.
 * @param {string|undefined} pattern
 * @returns {string[]}
 */
/* prettier-ignore */
const splitPattern = pattern => (pattern ?? "").split(/[,|]/).map(s => s.trim()).filter(Boolean);
/**
 * Bulk-delete runs using Octokit. Uses Promise.allSettled so failures don't abort the whole batch.
 * @param {string} instanceUrl
 * @param {string} token
 * @param {Array} runs
 * @param {string} context
 * @param {boolean} dryRun
 * @param {string} owner
 * @param {string} repo
 */
async function deleteRuns(instanceUrl, token, workflowRuns, context, dryRun, owner, repo) {
  if (!workflowRuns?.length) {
    core.debug(`[${context}] No runs to delete.`);
    return;
  }

  const results = await Promise.allSettled(
    workflowRuns.map(async (workflowRun) => {
      if (dryRun) {
        core.info(`[dry-run] 🚀 Simulate deletion: Run ${workflowRun.id} (${context})`);
        return { status: "skipped", runId: workflowRun.id };
      }

      try {
        await deleteWorkflowRun(instanceUrl, token, owner, repo, workflowRun.id);
        core.info(`✅ Successfully deleted: Run ${workflowRun.id} (${context})`);
        return { status: "deleted", runId: workflowRun.id };
      } catch (err) {
        core.error(
          `❌ Failed to delete: Run ${workflowRun.id} (${context}) - ${err.message}`
        );
        return { status: "failed", runId: workflowRun.id, error: err?.message ?? String(err) };
      }
    })
  );

  const summary = results.reduce(
    (acc, res) => {
      const status = res.status === "fulfilled" ? res.value?.status : "failed";

      switch (status) {
        case "deleted":
          acc.deleted++;
          break;
        case "skipped":
          acc.skipped++;
          break;
        case "failed":
        default:
          acc.failed++;
          break;
      }

      return acc;
    },
    { deleted: 0, skipped: 0, failed: 0 }
  );

  core.info(
    `🗑️ Deletion summary for ${context}: deleted=${summary.deleted}, skipped=${summary.skipped}, failed=${summary.failed}`
  );
}
/**
 * Decide whether a workflow run should be deleted according to the given options.
 * Logs a reason for skipping.
 * @param {Object} workflowRun
 * @param {Object} options
 * @returns {boolean}
 */
function shouldDeleteRun(workflowRun, options) {
  const { checkPullRequestExist, checkBranchExistence, branchNames, allowedConclusions, retainDays = 0, skipAgeCheck = false } = options;
  if (workflowRun.status !== "completed") {
    core.debug(`💬 Skip: Run ${workflowRun.id} status=${workflowRun.status}`);
    return false;
  }
  // Skip runs attached to pull requests (if requested).
  if (checkPullRequestExist && Array.isArray(workflowRun.pull_requests) && workflowRun.pull_requests.length > 0) {
    core.debug(`💬 Skip: Run ${workflowRun.id} linked to PR(s)`);
    return false;
  }
  // Skip if branch still exists
  const headBranch = workflowRun.head_branch ?? "";
  if (checkBranchExistence && headBranch && branchNames.includes(headBranch)) {
    core.debug(`💬 Skip: Run ${workflowRun.id} branch ${headBranch} still exists`);
    return false;
  }
  // Conclusion filter (if provided). If allowedConclusions is empty, that means "ALL".
  if (allowedConclusions.length > 0) {
    const runConclusion = String(workflowRun.conclusion ?? "").toLowerCase();
    if (!allowedConclusions.includes(runConclusion)) {
      core.debug(`💬 Skip: Run ${workflowRun.id} conclusion="${workflowRun.conclusion}" not allowed`);
      return false;
    }
  }
  // Age filter only when requested
  if (!skipAgeCheck && retainDays > 0) {
    if (!workflowRun.created_at) {
      core.debug(`💬 Skip age check: Run ${workflowRun.id} has no created_at`);
      return false;
    }
    const ageDays = (Date.now() - new Date(workflowRun.created_at).getTime()) / 86400000;
    if (ageDays < retainDays) {
      core.debug(`💬 Skip: Run ${workflowRun.id} is ${ageDays.toFixed(1)} days old (< ${retainDays} days)`);
      return false;
    }
  }
  return true;
}
/**
 * Group runs by date and filter runs to retain per day
 * @param {Array} workflowRuns
 * @param {number} keepMinimumRuns
 * @param {number} retainDays
 * @returns {Object} { runsToDelete: Array, runsToRetain: Array }
 */
function filterRunsByDailyRetention(workflowRuns, keepMinimumRuns, retainDays) {
  if (keepMinimumRuns <= 0 || retainDays <= 0) {
    return {
      runsToDelete: workflowRuns,
      runsToRetain: []
    };
  }
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - retainDays);
  const cutoffTime = cutoffDate.getTime();
  const runsByDate = {};
  const expiredRuns = []; // older than retainDays → delete
  workflowRuns.forEach(workflowRun => {
    if (!workflowRun?.created_at) {
      // If no created_at treat as expired to be safe
      expiredRuns.push(workflowRun);
      return;
    }
    const runTime = new Date(workflowRun.created_at).getTime();
    if (isNaN(runTime) || runTime < cutoffTime) {
      expiredRuns.push(workflowRun);
      return;
    }
    // Normalize date key via ISO to avoid locale variations
    const dateKey = new Date(workflowRun.created_at).toISOString().split("T")[0]; // YYYY-MM-DD
    if (!runsByDate[dateKey])
      runsByDate[dateKey] = [];
    runsByDate[dateKey].push(workflowRun);
  });
  const runsToRetain = [];
  const runsToDelete = [...expiredRuns];
  Object.values(runsByDate).forEach(dateRuns => {
    dateRuns.sort((a, b) => new Date(b.created_at) - new Date(a.created_at)); // newest first
    const retain = dateRuns.slice(0, keepMinimumRuns);
    const del = dateRuns.slice(keepMinimumRuns);
    runsToRetain.push(...retain);
    runsToDelete.push(...del);
  });
  return { runsToDelete, runsToRetain };
}

// Requests to Gitea API
async function giteaRequest(url, token) {
  const res = await fetch(url, {
    headers: {
      "Authorization": `token ${token}`,
      "Content-Type": "application/json"
    }
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${res.status} ${res.statusText} - ${text}`);
  }

  return res.json();
}

async function fetchAllPages(baseUrl, token, key) {
  let page = 1;
  const limit = 100;
  let results = [];

  while (true) {
    const url = `${baseUrl}?page=${page}&limit=${limit}`;
    const data = await giteaRequest(url, token);

    const items = key ? data[key] : data;

    if (!items || items.length === 0) break;

    results.push(...items);

    if (items.length < limit) break;
    page++;
  }

  return results;
}

async function fetchAllBranches(instanceUrl, token, owner, repo) {
  return fetchAllPages(
    `${instanceUrl}/api/v1/repos/${owner}/${repo}/branches`,
    token
  );
}

async function fetchAllRuns(instanceUrl, token, owner, repo) {
  return fetchAllPages(
    `${instanceUrl}/api/v1/repos/${owner}/${repo}/actions/runs`,
    token,
    "workflow_runs"
  );
}

async function fetchAllWorkflows(instanceUrl, token, owner, repo) {
  return fetchAllPages(
    `${instanceUrl}/api/v1/repos/${owner}/${repo}/actions/workflows`,
    token,
    "workflows"
  );
}

async function deleteWorkflowRun(instanceUrl, token, owner, repo, runId) {
  const url = `${instanceUrl}/api/v1/repos/${owner}/${repo}/actions/runs/${runId}`;

  const res = await fetch(url, {
    method: "DELETE",
    headers: {
      "Authorization": `token ${token}`,
      "Content-Type": "application/json"
    }
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Failed to delete run ${runId}: ${res.status} ${res.statusText} ${text}`);
  }

  return true;
}

async function main() {
  try {
    // ---------------------- 1. Parse Input Parameters ----------------------
    const token = core.getInput("token");
    if (!token)
      throw new Error("Missing required input: token");
    const instanceUrl = core.getInput("instance_url");
    const repositoryInput = core.getInput("repository");
    if (!repositoryInput)
      throw new Error('Missing required input: repository (expected "owner/repo")');
    const [repoOwner, repoName] = repositoryInput.split("/");
    if (!repoOwner || !repoName)
      throw new Error(`Invalid repository: "${repositoryInput}". Use "owner/repo".`);
    const retainDays = Number(core.getInput("retain_days") || "30");
    const keepMinimumRuns = Number(core.getInput("keep_minimum_runs") || "6");
    const useDailyRetention = parseBoolean(core.getInput("use_daily_retention"));
    const deleteWorkflowPattern = core.getInput("delete_workflow_pattern") || "";
    const deleteWorkflowByStatePattern = core.getInput("delete_workflow_by_state_pattern") || "ALL";
    const deleteRunByConclusionPattern = core.getInput("delete_run_by_conclusion_pattern") || "ALL";
    const dryRun = parseBoolean(core.getInput("dry_run"));
    const checkBranchExistence = parseBoolean(core.getInput("check_branch_existence"));
    const checkPullRequestExist = parseBoolean(core.getInput("check_pullrequest_exist"));
    // ---------------------- 2. Fetch Workflows ----------------------
    const workflows = await fetchAllWorkflows(instanceUrl, token, repoOwner, repoName);
    const workflowIds = workflows.map(w => w.id);
    // ---------------------- 3. Fetch Branches (if needed) ----------------------
    let branchNames = [];
    if (checkBranchExistence) {
      branchNames = (await fetchAllBranches(instanceUrl, token, repoOwner, repoName)).map(b => b.name);
      core.info(`💬 Found ${branchNames.length} branches`);
    }
    // ---------------------- 4. Filter Workflows ----------------------
    let filteredWorkflows = workflows;
    if (deleteWorkflowPattern) {
      const patterns = splitPattern(deleteWorkflowPattern).map(p => p.toLowerCase());
      if (patterns.length > 0) {
        core.info(`🔍 Filtering by patterns: ${patterns.join(", ")}`);
        filteredWorkflows = filteredWorkflows.filter(({
                                                        name,
                                                        path
                                                      }) => {
          const filename = (path || "").replace(/^\.github\/workflows\//, "").replace(/^\.gitea\/workflows\//, "");
          const nameLower = String(name || "").toLowerCase();
          const filenameLower = String(filename || "").toLowerCase();
          return patterns.some(p => nameLower.includes(p) || filenameLower.includes(p));
        });
      }
    }
    if (deleteWorkflowByStatePattern.toUpperCase() !== "ALL") {
      const states = splitPattern(deleteWorkflowByStatePattern).map(s => s.toLowerCase());
      core.info(`🔍 Filtering by state: ${states.join(", ")}`);
      filteredWorkflows = filteredWorkflows.filter(({
                                                      state
                                                    }) => states.includes(String(state ?? "").toLowerCase()));
    }
    core.info(`Processing ${filteredWorkflows.length} workflow(s)`);
    // ---------------------- 5. Delete Orphan Runs ----------------------
    const allRuns = await fetchAllRuns(instanceUrl, token, repoOwner, repoName);
    const orphanRuns = allRuns.filter(workflowRun => !workflowIds.includes(workflowRun.workflow_id));
    if (orphanRuns.length > 0) {
      core.startGroup(`Processing: orphan runs`);
      core.info(`👻 Found ${orphanRuns.length} orphan runs`);
      await deleteRuns(instanceUrl, token, orphanRuns, "orphan runs", dryRun, repoOwner, repoName);
      core.endGroup();
    }
    // ---------------------- 6. Process Each Workflow ----------------------
    const allowedConclusions = deleteRunByConclusionPattern.toUpperCase() === "ALL" ? [] : splitPattern(deleteRunByConclusionPattern).map(c => c.toLowerCase());
    for (const workflow of filteredWorkflows) {
      core.startGroup(`Processing: ${workflow.name} (ID: ${workflow.id})`);

      const runsByWorkflow = new Map();

      for (const workflowRun of allRuns) {
        if (!runsByWorkflow.has(workflowRun.workflow_id)) {
          runsByWorkflow.set(workflowRun.workflow_id, []);
        }
        runsByWorkflow.get(workflowRun.workflow_id).push(workflowRun);
      }

      const runs = runsByWorkflow.get(workflow.id) ?? [];
      // Pre-filter (branch, PR, conclusion, etc.)
      const candidates = runs.filter(workflowRun =>
        shouldDeleteRun(workflowRun, {
          checkPullRequestExist,
          checkBranchExistence,
          branchNames,
          allowedConclusions,
          retainDays: useDailyRetention ? 0 : retainDays, // age handled later in daily mode
          skipAgeCheck: useDailyRetention,
        }),);
      let runsToDelete = [];
      let runsToRetain = [];
      if (useDailyRetention) {
        const { runsToDelete: del, runsToRetain: ret } = filterRunsByDailyRetention(candidates, keepMinimumRuns, retainDays);
        runsToDelete = del;
        runsToRetain = ret;
        core.info(`🔄 Daily retention: Keeping up to ${keepMinimumRuns} runs/day for last ${retainDays} days`);
      } else {
        candidates.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
        runsToRetain = keepMinimumRuns > 0 ? candidates.slice(-keepMinimumRuns) : [];
        runsToDelete = keepMinimumRuns > 0 ? candidates.slice(0, candidates.length - runsToRetain.length) : candidates;
        if (runsToRetain.length > 0)
          core.info(`🔄 Retaining latest ${runsToRetain.length} day(s) of runs`);
      }
      if (runsToDelete.length > 0) {
        core.info(`🚀 Deleting ${runsToDelete.length} run(s)`);
        await deleteRuns(instanceUrl, token, runsToDelete, workflow.name, dryRun, repoOwner, repoName);
      } else {
        core.info("💬 No runs to delete");
      }
      core.endGroup();
    }
    core.info("✅ Cleanup completed successfully!");
  } catch (error) {
    core.setFailed(`❌ Action failed: ${error.message}`);
  }
}
// Start
main();
