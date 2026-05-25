/**
 * Storage management routes:
 *   POST   /drawings/:id/trim          – trim deleted elements and orphaned files
 *   GET    /drawings/:id/files/diff    – three-way file comparison
 *   DELETE /drawings/:id/files/orphans – delete selected orphaned files
 */
import express from "express";
import type { Server as SocketIoServer } from "socket.io";
import { PrismaClient } from "../generated/client";
import {
  isS3Enabled,
  deleteS3Object,
  listS3Objects,
  drawingS3Prefix,
} from "../s3";
import {
  VALID_STORAGE_FILE_ID,
  buildFilesDiff,
  collectReferencedFileIds,
  fileIdFromS3Key,
  type S3FileRecord,
  type S3ObjectRecord,
} from "./storage/helpers";

export type StorageRouteDeps = {
  prisma: PrismaClient;
  requireAuth: express.RequestHandler;
  asyncHandler: <T = void>(
    fn: (
      req: express.Request,
      res: express.Response,
      next: express.NextFunction
    ) => Promise<T>
  ) => express.RequestHandler;
  parseJsonField: <T>(rawValue: string | null | undefined, fallback: T) => T;
  invalidateDrawingsCache: () => void;
  io: SocketIoServer;
};

export const registerStorageRoutes = (
  app: express.Express,
  deps: StorageRouteDeps
): void => {
  const {
    prisma,
    requireAuth,
    asyncHandler,
    parseJsonField,
    invalidateDrawingsCache,
    io,
  } = deps;

  /**
   * Tell anyone joined to the drawing's collaboration room that the
   * server-side state has changed underneath them. The frontend reacts
   * by reloading the drawing — otherwise a collaborator's next save
   * would re-introduce the trimmed-away elements.
   */
  const notifyServerStateChange = (drawingId: string) => {
    io.to(`drawing_${drawingId}`).emit("drawing-server-update", { drawingId });
  };

  // ------------------------------------------------------------------
  // POST /drawings/:id/trim
  // ------------------------------------------------------------------
  app.post(
    "/drawings/:id/trim",
    requireAuth,
    asyncHandler(async (req, res) => {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: "Unauthorized" });

      const { id } = req.params;
      const { confirmName } = req.body ?? {};

      // 1. Find drawing owned by user
      const drawing = await prisma.drawing.findFirst({
        where: { id, userId },
      });
      if (!drawing) {
        return res.status(404).json({ error: "Drawing not found" });
      }

      // Confirm name must match
      if (typeof confirmName !== "string" || confirmName !== drawing.name) {
        return res
          .status(403)
          .json({ error: "confirmName does not match drawing name" });
      }

      // 2. Parse elements and files
      const elements: any[] = parseJsonField(drawing.elements, []);
      const files: Record<string, any> = parseJsonField(drawing.files, {});

      // 3. Filter elements: keep only non-deleted
      const activeElements = elements.filter((el) => !el.isDeleted);
      const elementsRemoved = elements.length - activeElements.length;

      // 4. Collect surviving fileIds
      const survivingFileIds = collectReferencedFileIds(activeElements, false);

      // 5. Filter files
      const originalFileCount = Object.keys(files).length;
      const cleanedFiles: Record<string, any> = {};
      for (const [fileId, value] of Object.entries(files)) {
        if (survivingFileIds.has(fileId)) {
          cleanedFiles[fileId] = value;
        }
      }
      const filesRemoved = originalFileCount - Object.keys(cleanedFiles).length;

      // 6. S3 cleanup
      //
      // S3File is keyed (drawingId, fileId) and S3 objects sit under a
      // per-drawing path, so this drawing's storage is independent from
      // every other drawing's — no cross-drawing reference check needed.
      // Duplicates are made by copying objects into the new drawingId
      // path (see drawings.ts /duplicate), so deleting the original
      // does not strand a sibling.
      let s3ObjectsDeleted = 0;
      let s3DeleteErrors = 0;

      if (isS3Enabled()) {
        const s3Prefix = drawingS3Prefix(userId, id);

        const s3FileRecords = await prisma.s3File.findMany({
          where: { drawingId: id },
        });
        const s3Objects = await listS3Objects(s3Prefix);

        // Union of S3File rows and physical S3 objects, minus the
        // surviving fileIds — anything left is orphan storage.
        const orphanKeys = new Set<string>();
        const orphanFileIds = new Set<string>();

        for (const record of s3FileRecords) {
          if (!survivingFileIds.has(record.fileId)) {
            orphanKeys.add(record.s3Key);
            orphanFileIds.add(record.fileId);
          }
        }

        for (const obj of s3Objects) {
          const fileId = fileIdFromS3Key(obj.key);
          if (fileId && !survivingFileIds.has(fileId)) {
            orphanKeys.add(obj.key);
          }
        }

        for (const key of orphanKeys) {
          try {
            await deleteS3Object(key);
            s3ObjectsDeleted++;
          } catch (err) {
            console.error(`[storage/trim] Failed to delete S3 object: ${key}`, err);
            s3DeleteErrors++;
          }
        }

        if (orphanFileIds.size > 0) {
          await prisma.s3File.deleteMany({
            where: { drawingId: id, fileId: { in: Array.from(orphanFileIds) } },
          });
        }
      }

      // 7. Update drawing — bump version so concurrent editors get a VERSION_CONFLICT
      // and reload, instead of having their newer version silently overwritten.
      await prisma.drawing.update({
        where: { id },
        data: {
          elements: JSON.stringify(activeElements),
          files: JSON.stringify(cleanedFiles),
          version: { increment: 1 },
        },
      });
      invalidateDrawingsCache();
      notifyServerStateChange(id);

      return res.json({
        trimmed: {
          elementsRemoved,
          filesRemoved,
          s3ObjectsDeleted,
          s3DeleteErrors,
        },
      });
    })
  );

  // ------------------------------------------------------------------
  // GET /drawings/:id/files/diff
  // ------------------------------------------------------------------
  app.get(
    "/drawings/:id/files/diff",
    requireAuth,
    asyncHandler(async (req, res) => {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: "Unauthorized" });

      const { id } = req.params;

      const drawing = await prisma.drawing.findFirst({
        where: { id, userId },
      });
      if (!drawing) {
        return res.status(404).json({ error: "Drawing not found" });
      }

      const elements: any[] = parseJsonField(drawing.elements, []);
      const files: Record<string, any> = parseJsonField(drawing.files, {});

      // Canvas refs (all elements including deleted)
      const allCanvasRefs = collectReferencedFileIds(elements, true);
      // Active canvas refs (non-deleted only)
      const activeCanvasRefs = collectReferencedFileIds(elements, false);

      // SQLite file keys
      const sqliteFileIds = new Set(Object.keys(files));

      // S3File records and actual S3 objects (drawing-scoped)
      const s3Prefix = drawingS3Prefix(userId, id);
      let s3FileRecords: S3FileRecord[] = [];
      let s3Objects: S3ObjectRecord[] = [];

      if (isS3Enabled()) {
        s3FileRecords = await prisma.s3File.findMany({
          where: { drawingId: id },
          select: { fileId: true, s3Key: true, mimeType: true },
        });
        s3Objects = await listS3Objects(s3Prefix);
      }

      const filesList = buildFilesDiff({
        allCanvasRefs,
        activeCanvasRefs,
        sqliteFileIds,
        s3FileRecords,
        s3Objects,
      });

      return res.json({
        summary: {
          totalCanvasRefs: allCanvasRefs.size,
          totalSqliteFiles: sqliteFileIds.size,
          totalS3Files: s3Objects.length,
        },
        files: filesList,
      });
    })
  );

  // ------------------------------------------------------------------
  // DELETE /drawings/:id/files/orphans
  // ------------------------------------------------------------------
  app.delete(
    "/drawings/:id/files/orphans",
    requireAuth,
    asyncHandler(async (req, res) => {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: "Unauthorized" });

      const { id } = req.params;
      const { confirmName, fileIds: rawFileIds } = req.body ?? {};

      if (!Array.isArray(rawFileIds) || rawFileIds.length === 0) {
        return res.status(400).json({ error: "fileIds must be a non-empty array" });
      }

      // Validate every entry: same regex as the rest of the codebase
      // (security.ts sanitiser, /files/:fileId route, processFilesForS3).
      // Without this, a non-string or path-traversal-shaped id would
      // explode inside the Prisma / S3 calls below.
      const invalidIds = rawFileIds.filter(
        (fid) => typeof fid !== "string" || !VALID_STORAGE_FILE_ID.test(fid),
      );
      if (invalidIds.length > 0) {
        return res.status(400).json({
          error: "fileIds contains invalid entries",
          invalidFileIds: invalidIds,
        });
      }
      const fileIds = rawFileIds as string[];

      const drawing = await prisma.drawing.findFirst({
        where: { id, userId },
      });
      if (!drawing) {
        return res.status(404).json({ error: "Drawing not found" });
      }

      if (typeof confirmName !== "string" || confirmName !== drawing.name) {
        return res
          .status(403)
          .json({ error: "confirmName does not match drawing name" });
      }

      const elements: any[] = parseJsonField(drawing.elements, []);
      const files: Record<string, any> = parseJsonField(drawing.files, {});

      // Safety: reject if any fileId is still referenced by a non-deleted element
      const activeRefs = collectReferencedFileIds(elements, false);
      const blockedIds = fileIds.filter((fid) => activeRefs.has(fid));
      if (blockedIds.length > 0) {
        return res.status(400).json({
          error: "Cannot delete files referenced by active elements",
          blockedFileIds: blockedIds,
        });
      }

      // Batched S3 + DB cleanup. S3File rows are scoped
      // (drawingId, fileId), and each drawing has its own S3 object
      // under its own prefix path — deletion here cannot strand a
      // sibling drawing. Doing N+1 sequential lookups + deletes per
      // file would tie up the request unnecessarily for large
      // selections.
      let s3ObjectsDeleted = 0;
      let s3DeleteErrors = 0;

      if (isS3Enabled()) {
        const s3Records = await prisma.s3File.findMany({
          where: { drawingId: id, fileId: { in: fileIds } },
        });

        const S3_DELETE_CONCURRENCY = 8;
        for (let i = 0; i < s3Records.length; i += S3_DELETE_CONCURRENCY) {
          const batch = s3Records.slice(i, i + S3_DELETE_CONCURRENCY);
          const results = await Promise.allSettled(
            batch.map((rec) => deleteS3Object(rec.s3Key)),
          );
          for (let j = 0; j < results.length; j++) {
            const result = results[j];
            if (result.status === "fulfilled") {
              s3ObjectsDeleted++;
            } else {
              console.error(
                `[storage/orphans] Failed to delete S3 object: ${batch[j].s3Key}`,
                result.reason,
              );
              s3DeleteErrors++;
            }
          }
        }

        await prisma.s3File.deleteMany({
          where: { drawingId: id, fileId: { in: fileIds } },
        });
      }

      // Update the drawing's files JSON regardless of S3 outcomes —
      // the JSON entry is what the editor reads, and once trimmed it
      // can't be restored from the bucket alone.
      for (const fileId of fileIds) {
        delete files[fileId];
      }
      const deletedCount = fileIds.length;
      const errorCount = s3DeleteErrors;

      // Also remove deleted elements that reference the orphaned files,
      // so the files disappear from the diff completely.
      const deletedFileIdSet = new Set(fileIds as string[]);
      const cleanedElements = elements.filter((el: any) => {
        if (
          el.isDeleted &&
          el.type === "image" &&
          typeof el.fileId === "string" &&
          deletedFileIdSet.has(el.fileId)
        ) {
          return false; // remove this deleted element
        }
        return true;
      });

      // Update drawing with cleaned files and elements. Bump version so
      // concurrent editors reload instead of silently overwriting.
      await prisma.drawing.update({
        where: { id },
        data: {
          files: JSON.stringify(files),
          elements: JSON.stringify(cleanedElements),
          version: { increment: 1 },
        },
      });
      invalidateDrawingsCache();
      notifyServerStateChange(id);

      return res.json({ deleted: deletedCount, errors: errorCount });
    })
  );
};
