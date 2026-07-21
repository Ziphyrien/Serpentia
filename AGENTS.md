# AGENTS.md

- Use Tailwind v4 canonical classes; avoid `suggestCanonicalClasses` warnings.
- Deployment commands such as `wrangler deploy` may be run without asking first when needed to verify or publish requested changes.
- Do not create, amend, squash, rebase, or otherwise rewrite commits unless the user explicitly asks for commit work.
- Commit messages must use an English Conventional Commit prefix followed by a Chinese description, for example `chore: 整理提交规范`.
- Prefer keeping related small fixes in a single coherent commit; split commits only when they represent independently reviewable changes.
