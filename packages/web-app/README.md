# Web App (M6)

The local React/Vite client is served by the Control Plane after `pnpm build`. It provides the authenticated M6 command chat, authoritative Kanban projection, task and immutable-attempt detail, protected owner actions, adapter readiness, manual-relay warnings and text attestation, and WebSocket cursor recovery.

The client is never a source of task truth. It reloads persisted server snapshots, ignores older task versions, renders worker content as plain escaped text, and leaves unsupported Bridge-dependent readiness and artifact operations visibly unavailable.

Development: `pnpm --filter @chubz/web-app build`, `test`, `typecheck`, or `lint`.
