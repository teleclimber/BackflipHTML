# Project overview

Read README.md to understand the project. The readme includes instructions on how to run tests for this project.

# Best practices

When fixing a bug create a failing test first and verify it fails. The failing test(s) should cover all variations of the bug. After fixing, verify the tests pass.

When creating a new feature always add tests as needed to verify behavior, both at the unit test level and at the integration test level.

When changing behavior of the system, always revise the docs to ensure they are still true and correct. Update them as needed.

# Code Paths

Duplicate code paths can lead to bugs. When you see that there is more than one code path that accomplishes something identical or nearly so, call it out. If your work will lead you to create an additional code path, avoid it. Consult with me about what to do. Generally the right answer will be to extract a reusable function or module beofre moving on.

# Running commands

The sandbox restricts writes to `/tmp`. The `tsx` test runner needs a writable TMPDIR for its cache. Always prefix commands with `TMPDIR=/tmp/claude-1000` when running tests or any node/tsx commands. For example:

```
TMPDIR=/tmp/claude-1000 npm test
```

# Writing Comments and Docs

Keep the comments and docs concise. Docs and code comments should talk about what is there, not what was there in the past. There is no need to provide any historical context. It is OK to explain "why" something is a certain way, but only relative to the way they currently are.
