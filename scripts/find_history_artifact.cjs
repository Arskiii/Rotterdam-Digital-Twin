// Called by actions/github-script. Restrict history to this repository and branch;
// fork artifacts and expired artifacts must never seed the published observations.
module.exports = async function findHistory({ github, context, core }) {
  const branch = context.ref.replace(/^refs\/heads\//, "");
  const artifacts = await github.paginate(github.rest.actions.listArtifactsForRepo, {
    ...context.repo, name: "traffic-history-v1", per_page: 100,
  });
  const eligible = artifacts.filter((artifact) => artifact.name === "traffic-history-v1" && !artifact.expired &&
    Date.parse(artifact.expires_at) > Date.now() && artifact.workflow_run?.head_branch === branch &&
    artifact.workflow_run?.head_repository_id === context.payload.repository.id &&
    artifact.workflow_run?.id !== context.runId);
  eligible.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || b.id - a.id);
  const latest = eligible[0];
  core.setOutput("run-id", latest ? String(latest.workflow_run.id) : "");
  if (latest) core.info(`Restoring traffic history from run ${latest.workflow_run.id} on ${branch}.`);
  else core.notice("No retained history artifact for this branch; falling back to the migration cache or bundled history.");
};
