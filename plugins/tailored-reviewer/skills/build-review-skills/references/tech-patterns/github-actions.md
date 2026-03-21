# GitHub Actions / CI — Tech-Specific Bug Patterns

## Execution Flow

- **`set -e` not default in `run:` steps**: Shell steps use `bash --noprofile --norc -e -o pipefail` by default BUT only for single-line commands. Multi-line `run:` blocks with `shell: bash` DO have `-e`, but `shell: sh` does NOT. A failing command mid-script doesn't stop the step.
- **`if: success()` is implicit**: Steps without `if:` only run if all previous steps succeeded. `if: always()` runs regardless. `if: failure()` runs only on failure. Forgetting `if: always()` on cleanup steps = cleanup skipped on failure.
- **Expression evaluation**: `${{ github.event.pull_request.title }}` is evaluated BEFORE the step runs. If the title contains `'`, it breaks YAML. Always quote: `"${{ ... }}"`. For shell safety, use environment variables instead of inline expressions.
- **Matrix job independence**: Matrix jobs don't share state. An artifact uploaded by matrix job A is not available to matrix job B (unless using artifacts). Each matrix cell is an independent runner.
- **`needs` dependency doesn't imply failure propagation**: `job2.needs: [job1]` — if job1 is skipped (by `if:` condition), job2 also skips. Use `if: always() && needs.job1.result != 'cancelled'` to run regardless.
- **Reusable workflow input types**: Inputs to reusable workflows (`workflow_call`) are always strings. `inputs.count` looks like a number but is `"5"`. Arithmetic fails silently or works by shell coercion.

## Resource Management

- **Secrets not available in PR from fork**: `secrets.MY_SECRET` is empty for PRs from forks (security feature). Workflow steps that require secrets fail silently with empty values. Use `pull_request_target` cautiously for fork access.
- **Runner disk space**: GitHub-hosted runners have ~14GB free. Large builds (Docker, heavy npm install) can exhaust this. `df -h` before build to verify.
- **Cache size limit**: `actions/cache` has 10GB per repo limit. Old caches are evicted LRU. If cache key changes frequently, useful caches get evicted.
- **Artifact retention**: Default 90 days. Large artifacts eat storage quota. Set `retention-days` explicitly.

## Concurrency

- **`concurrency` group cancels in-progress runs**: `concurrency: { group: ${{ github.ref }}, cancel-in-progress: true }` — pushing twice quickly cancels the first run. Good for PRs, dangerous for main branch deployments (partial deploy).
- **Parallel jobs sharing state via artifacts**: Jobs run in parallel by default. Using output from one job in another requires `needs:` dependency and artifact download. Race condition if two jobs write the same artifact name.

## Security

- **`pull_request_target` runs on base branch**: Code from the PR author executes in the context of the BASE repo (with secrets access). If the workflow checks out PR code (`actions/checkout@v4` with `ref: ${{ github.event.pull_request.head.sha }}`), it runs arbitrary PR code with repo secrets.
- **Script injection via `${{ }}`**: `run: echo "${{ github.event.issue.title }}"` — if issue title contains `"; rm -rf /`, it executes. Set as env var first: `env: TITLE: ${{ github.event.issue.title }}` then `echo "$TITLE"`.
- **`GITHUB_TOKEN` default permissions**: Default is read-write for everything in the repo. Set `permissions:` at workflow level to minimize: `permissions: { contents: read }`.
- **Third-party action pinning**: `uses: some-action@main` can change underneath. Pin to SHA: `uses: some-action@abc123`. A compromised action with repo secrets access = supply chain attack.

## Platform Constraints — GitHub API Failure Modes

Scripts that call the GitHub API (via `gh` CLI or `octokit`/`fetch`) must handle these failure modes:

- **Locked issues**: POST to `/comments`, `/labels` on a locked issue → 403 Forbidden. Any function that iterates issues and writes to them must check `issue.locked` before write operations.
- **Archived repos**: all write operations → 403. Check `repo.archived` if the script may target archived repos.
- **Rate limiting**: `GITHUB_TOKEN` in Actions allows 1,000 requests/hour. N+1 query patterns (fetching events/comments per issue in a loop) can easily exceed this. Check `X-RateLimit-Remaining` header or use conditional requests.
- **Pagination boundary shift**: mutating operations (close, label) during paginated iteration can shift page boundaries, causing issues to be skipped or processed twice. Collect all targets first, then mutate.
- **404 return type mismatch**: when an issue is deleted or a repo is renamed, API returns 404. If the caller expects an array (e.g., `any[]`) but the error handler returns `{}`, downstream code crashes on `.length`, `.filter()`, `for...of`.

## Implementation Quality

- **`actions/checkout` defaults to shallow clone**: `fetch-depth: 1` by default. `git log`, `git diff`, tags-based version calculation fail. Set `fetch-depth: 0` for full history when needed.
- **`continue-on-error: true` hides failures**: Step failure is suppressed. The job appears green even when the step failed. Use sparingly and always check `steps.stepid.outcome` explicitly.
- **Status check branch protection race**: If required status checks are set on branch protection, renaming a workflow or job breaks the check. The old check name never reports, PR can't merge.
- **`env:` scope confusion**: `env:` at workflow level is global. `env:` at job level overrides for that job. `env:` at step level overrides for that step. Setting `env:` in one step does NOT affect subsequent steps (use `$GITHUB_ENV` for that).
