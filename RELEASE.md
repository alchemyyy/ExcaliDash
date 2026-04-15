# ExcaliDash v0.4.28

Release date: 2026-03-20

Fixes #92, #89, and #90

- Removed the broken Save to... menu entry from the editor. ExcaliDash already provides its own export flow, and the
  upstream destination dialog was not supported.
- Fixed shared-drawing undo so each user only undoes their own local changes instead of rolling back collaborator
  updates.
- Fixed a drawing-specific editor state issue that could break hand-tool or middle-mouse panning in some shared
  drawings.

## Upgrading

<details>
<summary>Show upgrade steps</summary>

### Data safety checklist

- Back up backend volume (`dev.db`, secrets) before upgrading.
- Let migrations run on startup (`RUN_MIGRATIONS=true`) for normal deploys.
- Run `docker compose -f docker-compose.prod.yml logs backend --tail=200` after rollout and verify startup/migration status.

### Recommended upgrade (Docker Hub compose)

```bash
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d
```

### Pin images to this release (recommended for reproducible deploys)

Edit `docker-compose.prod.yml` and pin the release tags:

```yaml
services:
  backend:
    image: zimengxiong/excalidash-backend:v0.4.28
  frontend:
    image: zimengxiong/excalidash-frontend:v0.4.28
```

Example:

```bash
docker compose -f docker-compose.prod.yml up -d
```

</details>
