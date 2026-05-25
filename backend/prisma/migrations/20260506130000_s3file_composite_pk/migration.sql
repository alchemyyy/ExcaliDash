-- Migrate S3File from a single-column `id` (= fileId) primary key to a
-- composite (drawingId, fileId) primary key.
--
-- Why: Excalidraw fileIds are content hashes that legitimately repeat
-- across drawings; a global PK on fileId alone meant the second upload
-- of the same image silently overwrote the first row's s3Key, and any
-- prefix-scoped cleanup deleted objects the sibling drawing still
-- needed.
--
-- We preserve existing rows by parsing the drawingId out of the
-- s3Key. Pre-existing keys all follow the layout produced by uploads
-- so far:
--   {prefix}/{userId}/{drawingId}/{fileId}.{ext}
-- (the default prefix `excalidash` has no internal slashes, so we look
-- for the third '/' in the key and take the segment that ends at it.)
-- Operators with a custom S3_KEY_PREFIX containing '/' should re-save
-- affected drawings after deploying — those rows fall through and are
-- dropped (private-bucket access falls back to 404 until re-saved,
-- public-bucket dataURLs keep working as the dataURL itself encodes
-- the URL directly).

CREATE TABLE "new_S3File" (
    "drawingId" TEXT NOT NULL,
    "fileId"    TEXT NOT NULL,
    "userId"    TEXT NOT NULL,
    "s3Key"     TEXT NOT NULL,
    "mimeType"  TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY ("drawingId", "fileId")
);

-- Extract `drawingId` = the path segment between the second and third
-- '/' in s3Key. SQLite has INSTR + SUBSTR but no native split, so we
-- chain three scans of the string:
--   p1 = INSTR(s3Key, '/')
--   tail1 = SUBSTR(s3Key, p1+1)
--   p2_local = INSTR(tail1, '/')
--   tail2 = SUBSTR(tail1, p2_local+1)
--   p3_local = INSTR(tail2, '/')
--   drawingId = SUBSTR(tail2, 1, p3_local - 1)
INSERT OR IGNORE INTO "new_S3File"
    ("drawingId", "fileId", "userId", "s3Key", "mimeType", "createdAt")
SELECT
    SUBSTR(
        SUBSTR(
            SUBSTR(s3Key, INSTR(s3Key, '/') + 1),
            INSTR(SUBSTR(s3Key, INSTR(s3Key, '/') + 1), '/') + 1
        ),
        1,
        INSTR(
            SUBSTR(
                SUBSTR(s3Key, INSTR(s3Key, '/') + 1),
                INSTR(SUBSTR(s3Key, INSTR(s3Key, '/') + 1), '/') + 1
            ),
            '/'
        ) - 1
    ) AS drawingId,
    id AS fileId,
    userId,
    s3Key,
    mimeType,
    createdAt
FROM "S3File"
-- Only attempt the parse for keys that have at least three '/' (the
-- typical default-prefix shape). Other rows are dropped.
WHERE LENGTH(s3Key) - LENGTH(REPLACE(s3Key, '/', '')) >= 3
  AND INSTR(
        SUBSTR(
            SUBSTR(s3Key, INSTR(s3Key, '/') + 1),
            INSTR(SUBSTR(s3Key, INSTR(s3Key, '/') + 1), '/') + 1
        ),
        '/'
      ) > 1;

DROP TABLE "S3File";
ALTER TABLE "new_S3File" RENAME TO "S3File";

CREATE INDEX "S3File_userId_idx" ON "S3File"("userId");
CREATE INDEX "S3File_drawingId_idx" ON "S3File"("drawingId");
