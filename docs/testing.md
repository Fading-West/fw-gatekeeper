# Running Gatekeeper checks

Use the official Node.js 22 distribution (the date contracts require TypeScript
stripping support) and Python 3.11. Install Node packages with `npm ci`, create a
Python virtual environment, and install `scripts/requirements-ci.txt` there.
Keep that virtual environment on PATH, or set PYTHON to its interpreter path.

Run `npm run lint`, `npm test`, `npm run typecheck`, and `npm run build`. Set
`NEXT_PUBLIC_CONVEX_URL=https://ci-only.convex.cloud` for a build without a deployment.
Tests stub requests or run Convex in memory and require no production credentials.

`npm test` discovers all Vitest suites, all `test_*.py` files in both Python
services, and all `scripts/test-*.mjs` contracts. Python files run in separate
processes to avoid collisions between the two services' `main`/`config` modules.
Add regression tests beside the module they exercise; no test-command edit is needed.

GitHub Actions runs these checks on every PR and on master. It also builds the
face-service Docker image and loads the real ONNX model, then checks production
Node dependencies for high or critical advisories. Dependabot opens weekly updates.
The workflow does not deploy services or require live credentials. Hardware camera
and liveness acceptance tests still require a Raspberry Pi pilot.
