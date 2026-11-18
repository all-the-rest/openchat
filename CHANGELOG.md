# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
