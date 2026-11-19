# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.5.0] - 2026-11-19

### Added

- issue 5 model/agent pickers, permission cards, settings and retry (Refs #5); edit and branch a message without destroying the old branch; rename and delete chats and answer question forms (#5, #16)
- accessibility and mobile polish, second slice (#8)
- upload files through the composer and type them by content (#21)
- DOCX from blocks or Markdown, embedded PDF fonts (#22)
- installable shell, offline state and generated icons; show and manage worktrees (#23)
- ship an offline Python runtime and four typed document tools; ship markitdown preinstalled in the agent image (#24)
- add per-chat working files with quotas and a boot audit (#25)
- artifact capacity guard and dry-run eviction CLI (#43)
- land agent-managed cross-session memory (slices 0-5); keep the Code frame across surface switches and plant memory in Code sessions (#49, #50)
- first-run onboarding to connect a provider (#50)
- wire one-shot model fallback into chat turns (#54); show the fallback chain, cap and today's usage in settings (#54)
- backup, status and the operations runbook (#9)
- command palette, chat search, Markdown export and usage panel (#8)
- compaction policy with a soft cap and a visible fill (#53)
- group subagent sessions under their parent (#55)
- list and extract ZIP archives with guards (#52)
- model variants, capabilities and per-browser favorites (#51)
- run dictation on-device with a pinned, cached model (#47)
- scheduled tasks and background jobs (#48)
- signed media, PDF preview and gallery (#6)
- turn policy, failure classification and usage ledger (#54)

### Changed

- issue 5 controls (#5)
- docs+test(#38): record update policy ADR and prove major pass-through (#38)
- split memory invalidator out of the memory route (#49)
- documents service, tool bridge, compose and docs
- keep routes and the fake backend under the 400-line ceiling
- move the transcript types into their own module
- split the dictation types and the transcribe step out

### Fixed

- arm the palette shortcut before first paint; arm surface chord listener before paint to stop CI flake (#8); recover model and memory state after failed reads (#8, #49, #51)
- report corruption once, skip bookkeeping dirs and validate the seed merge (#18, #49, #54)
- guard the OpenCode state disk on swap and back up the right copy; refuse an unmounted state image and warn on a pre-migration rollback (#20, #43)
- surface an invalid fallback chain and keep the Code frame across a failed refresh (#26, #50, #54)
- bound the fact store and merge the MCP seed on upgrade (#43, #49)
- bound soft-cap bookkeeping and report a full usage ledger; bound memory reads, rotate bookkeeping and keep GET side-effect free (#49, #53, #54)
- make the soft-cap compaction id unique per attempt (#53)
- correct fallback model choice, paid-turn cap and turn tracking; own fallback outcomes and retries in the server, not the SSE pump (#54)
- close browser streams on a host drop so the outage banner recovers (#54)
- enforce the spec's 20 MiB per-attachment cap (#26)
- export the extracted event route
- give the BFF a writable chat-files subtree
- give the local STT stack its own port
- keep a new chat when an older session list lands late
- keep a subject's issue ref instead of repeating it
- link a schedule to its chat by title
- pin the memory cap to the new 8 MiB default (#49)
- send a host-valid id, one fill, live labels (#53)
- wire fallback knobs and correct the memory budget (#54, #43)

### Documentation

- close the remaining review follow-ups (#28, #43)
- add cross-session memory architecture (#49)
- add install and run instructions for local and compose (#18)
- compare existing agent-memory solutions
- count the files and images the release actually has (#18)
- document the browser path as the state, server as an escape hatch (#10)
- document the memory store cap for operators (#49)
- document the model selector and the fallback policy
- give the tasks and voice documents their own numbers
- how the agent can keep approved memories
- move the subagent note out of the owner-owned architecture page
- name the accepted queued-send delta race (#54)
- name the chat-only surfaces in the parity contract (#50)
- state the 2.5.0 limits instead of the M1 placeholder list (#5)
- the 2.5.0 changelog (#18)

## [2.2.0] - 2026-11-18

### Added

- wire the inbox and bound the fan-out (#28)

### Changed

- split the bundle by route and gate the budget (#26)
- migrate gates to v0.8.0 auto-baseline semantics (#45)

### Fixed

- close the six open findings from the first UI review; give the idle microphone a surface and close the last UI finding (#27)

## [2.1.0] - 2026-11-18

### Added

- guard the host with a watchdog, dind GC and an artifact warning; install the host guards with --with-guards (#36, #43)
- close the boot-gate hole and bound release retention (#43)

### Changed

- raise the test floor to the merged 1065 (#36, #37, #43)
- give the artifact contract one owner (#43)

### Fixed

- show the expired artifact state and the tunnel-down state honestly (#37, #43)
- bind the session key to the credential so a password change revokes; reject a parent segment or control character in --stack-dir (#43)

### Documentation

- write down the OpenCode upgrade policy and rollback path (#38)

## [2.0.0] - 2026-11-18

### Added

- implement the M1 walking skeleton and the M2 rendering core (#3, #4)
- serve the Code surface behind a ticket exchange; mint Code tickets and report the host status; add the Chat | Code surface switch and the /code page (#11)
- record speech into the composer (#12)
- store documents behind signed URLs on their own origin; list artifacts and open one in a sandboxed frame; carry Artifacts in the app-bar menu; write path from the model to the artifact store; bridge the sandboxed runtime back to the viewer; inline the bridge and name the reset control; land bridge results in an editable draft (#13, #33)
- proxy multi-source search on the BFF; add the grouped search page (#14)
- list MCP servers and skills, and switch a server on and off; show the workspace's MCP servers and skills at /apps (#15)
- run against a remote OpenCode host (#16)
- state a dead OpenCode host instead of failing the page; ship images, a guarded stack and a reversible swap (#20)
- migrate the UI catalogue to Lingui (#30)
- reach the surface switch through an app-bar overflow menu (#33)
- adopt bugfix and minor client releases, pin the major (#34)
- sign in with username and password (#39)
- ship the stack to the VPS behind the host Caddy (#40)

### Changed

- rename the project to OpenChat (#1)
- extend UI-review coverage and parallelize the slow suites (#3, #4, #27)
- cover the Code surface against a stub host; pin the draft clear and the loaded frame (#11)
- keep the BFF env under the length gate; raise the test floor to the merged 740; raise the test floor to 742; record the chat-pattern study and repair the merged lockfile; raise the test floor to 896 (#13, #17, #20, #33)
- cover the surface in a browser and capture it; pin the race guard and raise the ratchet floor (#15)
- drop the reviewer subagent; add version, changelog and image release machinery; drop the remaining role definitions; OpenChat 2.0.0; regenerate the 2.0.0 changelog and raise the test floor (#19, #44)
- toggle the tool card without user-event timing (#29)
- settle the outage banner on the wide bar (#33)
- compare a hostile version by major (#34)
- pin that a wrong username still pays the bcrypt round (#39)
- give the rollback cases room under a loaded workspace; do not build the toolbox image without the dind profile (#40, #44)
- give the bridge caps one owner (#41)
- cap the build cache and ship the artifact tool without dev deps (#44)
- add ratchet gates, GitHub Actions and the UI screenshot harness
- raise the test floor to 960

### Fixed

- address review findings on the analysis scaffold; apply the second re-review findings; align the artifact network prose and the Code host headers (#1)
- close the second review round (#3, #4, #26)
- refuse foreign writes at the Code host gate; tell the truth about the frame and the mobile bar (#11)
- close the review findings on the viewer and the stack; make the bridge notes true and pin the paths they describe (#13, #20)
- pin the client encoding, clear a stale notice, move the toggle; make the action guards load-bearing and the docs true (#15)
- make the 2.0 bump and publish set self-consistent; install the ratchet binary before the release gates run (#19)
- normalise reserved paths, police trust proxy, verify downloads (#20)
- key the throttles on the hop the proxy appended (#31)
- close the review gaps the Code surface carried (#32)
- close the review findings on the remote driver; keep the Code origin's event stream uncompressed too (#40, #41)
- stop an anonymous burst from burning the BFF, and harden the cookie (#42)

### Documentation

- record first desktop and mobile observation pass; record breakpoints and the composer add menu; cut settings down to a self-hosted single-user product; align the integration map with the published client types; verify the OpenCode 2.3 facts and record the V2 scope; correct deliverable status and observation numbering; point to the v1.0 and v2.0 milestones (#1)
- document the Code surface variables in .env.example (#11)
- design the interactive app runtime (#13)
- count the five images the workflow publishes (#19)
- decide the styling layer and record the gate successor (#20)
