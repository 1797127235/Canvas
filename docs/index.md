# Infinite Canvas Documentation Index

## Overview

- [Quick Start](/docs/overview/quick-start)
- [Features](/docs/overview/features)
- [Docker Deployment](/docs/overview/docker)
- [Third-party Prompt Sources](/docs/overview/third-party-prompt-repositories)

## Canvas Guide

- [Canvas Node Guide](/docs/canvas/canvas-node-manual)
- [Canvas Shortcuts](/docs/canvas/canvas-shortcuts)

## Multi-user Specifications

- [Capability Map](../CAPABILITY-MAP.md): approved module boundaries and dependency order; only identity has a local implementation.
- [Identity Spec](../SPEC-identity.md): approved requirements, contracts and local acceptance evidence.
- [Identity Plan](../tasks/plan.md): approved technical plan, staged access policy and outstanding production decisions.
- [Identity Tasks](../tasks/todo.md): local backend 54/54 and frontend 14/14 tests, both typechecks and isolated browser primary flows pass; user sign-off and production parameters remain pending. Unisolated local business features are available only under the development bypass.
- [Catalog Spec](../SPEC-catalog.md): draft server-controlled model catalog and adapter contracts; plan/tasks appended to the existing multi-user tracker, awaiting review and not implemented.

## Development and Data

- [Local Development](/docs/development/local-development)
- [Canvas Data Structure](/docs/development/canvas-data-structure)
- [How the Local Codex Connection Works](/docs/development/local-codex-canvas)

## Support and Security

- [Report a Vulnerability](/docs/support/security)

## Project Progress

- [Changelog](/docs/progress/changelog)
- [Pending Tests](/docs/progress/pending-test)
- [TODO](/docs/progress/todo)

## Notes

- Canvas projects and My Assets are stored in the browser. There is no cross-device sync.
- The AI API key is stored in the browser, which sends requests directly to OpenAI-compatible endpoints.
