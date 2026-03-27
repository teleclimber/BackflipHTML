# Project overview

Read README.md to understand the project. The readme includes instructions on how to run tests for this project.

# Best practices

When fixing a bug create a failing test first and verify it fails. The failing test(s) should cover all variations of the bug. After fixing, verify the tests pass.

When creating a new feature always add tests as needed to verify behavior, both at the unit test level and at the integration test level.

When changing behavior of the system, always revise the docs to ensure they are still true and correct. Update them as needed.

# Running commands

The sandbox restricts writes to `/tmp`. The `tsx` test runner needs a writable TMPDIR for its cache. Always prefix commands with `TMPDIR=/tmp/claude-1000` when running tests or any node/tsx commands. For example:

```
TMPDIR=/tmp/claude-1000 npm test
```