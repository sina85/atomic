import { test } from "bun:test";
import assert from "node:assert/strict";

interface ChoiceInput {
  default: string;
  options: string[];
  required: boolean;
  type: string;
}

interface Step {
  uses?: string;
  with?: { ref?: string };
}

interface PublishWorkflow {
  on: {
    workflow_dispatch: {
      inputs: {
        windows_runner: ChoiceInput;
      };
    };
  };
  jobs: {
    "windows-binary-smoke": {
      "runs-on": string;
      steps: Step[];
    };
  };
}

const workflowPath = new URL("../../.github/workflows/publish.yml", import.meta.url);
const docsPath = new URL("../../docs/ci.md", import.meta.url);

async function loadWorkflow(): Promise<PublishWorkflow> {
  const source = await Bun.file(workflowPath).text();
  return Bun.YAML.parse(source) as PublishWorkflow;
}

test("publish workflow defaults Windows smoke to Blacksmith with a manual GitHub-hosted choice", async () => {
  const workflow = await loadWorkflow();
  const input = workflow.on.workflow_dispatch.inputs.windows_runner;

  assert.deepEqual(input, {
    description: "Windows smoke runner (use github-hosted only if Blacksmith is blocked)",
    required: true,
    default: "blacksmith",
    type: "choice",
    options: ["blacksmith", "github-hosted"],
  });
  assert.equal(
    workflow.jobs["windows-binary-smoke"]["runs-on"],
    "${{ inputs.windows_runner == 'github-hosted' && 'windows-2025' || 'blacksmith-4vcpu-windows-2025' }}",
  );
});

test("Windows smoke uses a provider-neutral checkout of the requested tag", async () => {
  const workflow = await loadWorkflow();
  const checkout = workflow.jobs["windows-binary-smoke"].steps[0];

  assert.equal(checkout?.uses, "actions/checkout@v7.0.0");
  assert.equal(checkout?.with?.ref, "${{ github.event.inputs.tag || github.ref_name }}");
});

test("CI docs record exact normal and fallback dispatch inputs", async () => {
  const docs = await Bun.file(docsPath).text();

  assert.match(docs, /-f tag=0\.9\.7-alpha\.1 -f windows_runner=blacksmith/u);
  assert.match(docs, /-f tag=0\.9\.7-alpha\.1 -f windows_runner=github-hosted/u);
  assert.match(docs, /different concurrency keys.*start concurrently/u);
  assert.match(docs, /first cancel the stuck run.*wait until it is terminal/u);
  assert.doesNotMatch(docs, /runs for the same tag share a non-canceling concurrency group/u);
});
