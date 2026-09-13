---
name: Replit config validation
description: How to safely update the project-level .replit file in this environment.
---

Changes to `.replit` must be written to a temporary file and applied through the platform's validation callback; direct edits are rejected.

**Why:** The environment validates project configuration before replacing it.

**How to apply:** Preserve the complete final configuration in the temporary file, then validate and replace the real `.replit`.