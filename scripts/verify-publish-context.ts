export interface PublishContext {
  eventName: string | undefined;
  workflowRef: string | undefined;
  workflowSha: string | undefined;
  repository: string | undefined;
  defaultBranch: string | undefined;
  signalEvent: string | undefined;
  signalConclusion: string | undefined;
  signalPath: string | undefined;
  signalRepository: string | undefined;
}

const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const SIGNAL_PATH = ".github/workflows/publish-tag-created.yml";
const PUBLISH_PATH = ".github/workflows/publish.yml";

export function validatePublishContext(context: PublishContext): void {
  if (context.eventName !== "workflow_run") {
    throw new Error(`Privileged publisher requires workflow_run; received: ${context.eventName ?? "missing"}`);
  }
  if (!context.repository || !context.defaultBranch) {
    throw new Error("Missing repository or default branch context");
  }

  const expectedWorkflowRef = `${context.repository}/${PUBLISH_PATH}@refs/heads/${context.defaultBranch}`;
  if (context.workflowRef !== expectedWorkflowRef) {
    throw new Error(
      `Privileged publish workflow was not loaded from protected ${context.defaultBranch}: ${context.workflowRef ?? "missing"}`,
    );
  }
  if (!context.workflowSha || !SHA_PATTERN.test(context.workflowSha)) {
    throw new Error(`Invalid protected workflow SHA: ${context.workflowSha ?? "missing"}`);
  }
  if (context.signalEvent !== "create" || context.signalConclusion !== "success") {
    throw new Error("Publish signal was not a successful create run");
  }
  if (context.signalPath !== SIGNAL_PATH) {
    throw new Error(`Unexpected publish signal workflow: ${context.signalPath ?? "missing"}`);
  }
  if (context.signalRepository !== context.repository) {
    throw new Error(`Publish signal came from another repository: ${context.signalRepository ?? "missing"}`);
  }
}
export function verifyProtectedWorkflowAncestry(
  workflowSha: string | undefined,
  protectedRef: string | undefined,
  cwd: string = process.cwd(),
): void {
  if (!workflowSha || !SHA_PATTERN.test(workflowSha)) {
    throw new Error(`Invalid protected workflow SHA: ${workflowSha ?? "missing"}`);
  }
  if (!protectedRef) throw new Error("Missing protected default ref");
  const result = Bun.spawnSync(["git", "merge-base", "--is-ancestor", workflowSha, protectedRef], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(`Workflow SHA ${workflowSha} is not contained in protected default-branch history`);
  }
}

if (import.meta.main) {
  const context: PublishContext = {
    eventName: process.env.PUBLISH_EVENT,
    workflowRef: process.env.WORKFLOW_REF,
    workflowSha: process.env.WORKFLOW_SHA,
    repository: process.env.GITHUB_REPOSITORY,
    defaultBranch: process.env.DEFAULT_BRANCH,
    signalEvent: process.env.SIGNAL_EVENT,
    signalConclusion: process.env.SIGNAL_CONCLUSION,
    signalPath: process.env.SIGNAL_PATH,
    signalRepository: process.env.SIGNAL_REPOSITORY,
  };
  validatePublishContext(context);
  verifyProtectedWorkflowAncestry(context.workflowSha, process.env.PROTECTED_DEFAULT_REF);
}
