# mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/ipaludhi/mend-patch-tool/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/ipaludhi/mend-patch-tool/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

`mend` is one patch tool for every AI edit format: it applies an edit a model
wrote to a tree of text files, in any of four formats, and changes every file
or none. Node 22, standard library only, no model calls, no network.

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

- Formats: `unified` (diff, often with wrong line numbers), `search-replace`
  (`<<<<<<< SEARCH` blocks), `v4a` (`*** Begin Patch`), `json` (text-editor
  tool calls, one array or JSON Lines). `--format=auto` (the default) detects
  the format; `--format=NAME` forces one.
- PATCH is a patch file, or `-` / absent for standard input.
- `--check` does everything but write; `--strict` matches lines exactly.
- Old lines are found at the first of three matching tiers — exact, trailing
  whitespace ignored, then leading and trailing whitespace ignored with
  re-indenting — so drifted whitespace and wrong line numbers still apply.
- Exit 0 prints what changed (`A`/`D`/`M`/`R` lines, then `ok: <n> files`);
  exit 1 lists every failed edit and writes nothing; exit 2 is a usage,
  no-patch, format or parse error. See `SPEC.md` for the whole contract.

## Verify

```sh
node check.ts <practice.json>   # 100 practice checks, score 1000 when all pass
```

`runner.ts` is the kit's trial runner (kept as-is): with `MAKEFUN_ENV_URL` set,
`main.ts` hands the trial over to it.

## Measured results (local, kit practice set)

- Practice set: **100/100, score 1000** — trial-0, trial-1 and trial-2 each
  100/100 (30 unified, 20 search_replace, 20 v4a, 15 json, 15 cli).
- Hand-built SPEC edge cases (70 cases: renames, `\ No newline at end of file`,
  CRLF, empty files, V4A anchors/cursor/end-of-file, JSON faults, unsafe paths,
  atomicity, `--check`, move sorting): **70/70**.
- Determinism: trial-0 repeated at 100/100; a grader-like run as user 65534
  exits 0 with the same output.

---

<sub>Entered on [make.fun](https://make.fun/?ref=e182s7fp&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
