# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/vnazt/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/vnazt/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone, single-process GitHub-compatible git forge written in TypeScript for Node 22, with zero runtime dependencies. Git smart HTTP (protocol v0 and v2: advertise, ls-refs, fetch with shallow support, receive-pack), the GitHub REST v3 surface (repositories, branches, commits, contents, labels, issues, comments, pull requests and squash merges), GraphQL v4 (queries, mutations, introspection, batched operations) and an MCP endpoint (JSON-RPC over streamable HTTP) all run over one shared in-memory store, so an object created on any surface is the same object on every other. State is deterministic: timestamps come from a logical clock seeded by `MAKEFUN_TRIAL_NOW`, never the wall clock.

## Run it

```sh
node --experimental-strip-types main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=ws8tc7yd&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
