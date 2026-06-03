# ExcaliDash v0.5.0-dev

Release date: 2026-06-03

This is a prerelease build intended for validation before the next stable release.

| Area | Key changes |
|------|-------------|
| **Sharing and collaboration** | Collection sharing, drawing link/person sharing, shared collection role handling, access-aware editor loading, and collaboration safety fixes. |
| **Storage and files** | S3-backed image file records, private-bucket file redirects, storage trim/diff/orphan cleanup APIs, S3 delete accounting, and safer S3 key migration for nested prefixes. |
| **Account and admin** | API keys, user preferences, profile/password cards, admin user management split, access-control settings, and login rate-limit controls. |
| **Editor reliability** | Safer snapshot persistence, image status normalization, multi-image drop import, collaboration/file delta handling, and extracted editor modules under the source line-count gate. |
| **Import/export and backups** | Improved import helpers, file processing coverage, SQLite backup scheduler, and compatibility tests. |
| **Deployment and lab tooling** | Production/lab compose updates, deployment docs, reproducible environment lab, release scripts, and source line-count checks. |

## Verification

The prerelease branch has been verified locally with:

- Frontend build
- Backend build
- Frontend unit tests
- Backend unit/integration tests
- Frontend and backend npm audit
- `git diff --check`
- Source line-count gate for handwritten TypeScript/TSX
- SQLite smoke test for the S3 composite-key migration with default and nested key prefixes

## Known prerelease notes

- S3-enabled deployments should validate private file redirects, storage trim, duplicate/copy, and orphan cleanup against their real bucket before promoting this prerelease to stable.
- Docker image publishing is manual through the release scripts in this repo. Confirm DockerHub login and a working Docker buildx builder before publishing images.
- GitHub and DockerHub publishing should happen only from a clean, committed branch.

## Upgrading

<details>
<summary>Show upgrade steps</summary>

### Data safety checklist

- Back up the backend volume (`dev.db`, secrets, uploads, and S3 bucket data) before upgrading.
- Let migrations run on startup (`RUN_MIGRATIONS=true`) for normal deploys.
- If S3 is enabled, verify that existing object keys follow the canonical layout `{prefix}/{userId}/{drawingId}/{fileId}.{ext}`.
- Run `docker compose -f docker-compose.prod.yml logs backend --tail=200` after rollout and verify startup/migration status.

### Recommended prerelease upgrade

```bash
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d
```

### Pin images to this prerelease

Edit `docker-compose.prod.yml` and pin the prerelease tags:

```yaml
services:
  backend:
    image: zimengxiong/excalidash-backend:v0.5.0-dev
  frontend:
    image: zimengxiong/excalidash-frontend:v0.5.0-dev
```

Example:

```bash
docker compose -f docker-compose.prod.yml up -d
```

</details>
