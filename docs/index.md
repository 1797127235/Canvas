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

- [Capability Map](../CAPABILITY-MAP.md): local multi-user scope, account key, upstream discovery, workspace/media/generation/history boundaries.
- [Identity Spec](../SPEC-identity.md): approved requirements, contracts and local acceptance evidence.
- [Identity Plan](../tasks/plan.md): approved technical plan, staged access policy and outstanding production decisions.
- [Identity Tasks](../tasks/todo.md): previous identity acceptance and current multi-user implementation tracker; new changes need acceptance and do not inherit earlier test results.
- [Catalog Spec](../SPEC-catalog.md): account upstream model discovery, four generation protocols, account history, and local development contracts.

## Development and Data

- [Local Development](/docs/development/local-development)
- [Canvas Data Structure](/docs/development/canvas-data-structure)

## Support and Security

- [Report a Vulnerability](/docs/support/security)

## Project Progress

- [Changelog](/docs/progress/changelog)
- [Pending Tests](/docs/progress/pending-test)
- [TODO](/docs/progress/todo)

## Notes

- Default local development uses the account server: workspace/history in PostgreSQL, media on server disk or optional MinIO; new behavior awaits acceptance.
- The account API key is encrypted on the server and used for upstream generation. Old browser-only storage and direct requests remain only in explicit development bypass mode.
