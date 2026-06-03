import { useCallback, useEffect } from "react";
import type { MutableRefObject } from "react";
import {
  CaptureUpdateAction,
  convertToExcalidrawElements,
  viewportCoordsToSceneCoords,
} from "@excalidraw/excalidraw";
import { toast } from "sonner";
import {
  getDroppedImageFiles,
  loadDroppedImageData,
  MULTI_IMAGE_DROP_GAP,
} from "./droppedImages";
import {
  hasRenderableElements,
  haveSameElements,
  isStaleNonRenderableSnapshot,
  isSuspiciousEmptySnapshot,
} from "./shared";

type CanvasHandlerRefs = {
  excalidrawAPI: MutableRefObject<any>;
  hasHydratedInitialScene: MutableRefObject<boolean>;
  hasSceneChangesSinceLoad: MutableRefObject<boolean>;
  initialSceneElements: MutableRefObject<readonly any[]>;
  isBootstrappingScene: MutableRefObject<boolean>;
  isSyncing: MutableRefObject<boolean>;
  isUnmounting: MutableRefObject<boolean>;
  lastLocalChangeAt: MutableRefObject<number>;
  latestAppState: MutableRefObject<any>;
  latestElements: MutableRefObject<readonly any[]>;
  latestFiles: MutableRefObject<any>;
  debouncedSave: MutableRefObject<
    | ((
        drawingId: string,
        elements: readonly any[],
        appState: any,
        files?: Record<string, any>,
      ) => void)
    | null
  >;
  suspiciousBlankLoad: MutableRefObject<boolean>;
};

type UseEditorCanvasHandlersParams = {
  canEdit: boolean;
  debouncedSavePreview: (drawingId: string) => void;
  drawingId: string | undefined;
  emitFilesDeltaIfNeeded: (nextFiles: Record<string, any>) => boolean;
  isReady: boolean;
  refs: CanvasHandlerRefs;
  resolveSafeSnapshot: (candidateSnapshot?: readonly any[]) => {
    prevented: boolean;
    staleEmptySnapshot: boolean;
    staleNonRenderableSnapshot: boolean;
  };
  broadcastChanges: (
    elements: readonly any[],
    currentFiles?: Record<string, any>,
  ) => void;
};

export const useEditorCanvasHandlers = ({
  canEdit,
  debouncedSavePreview,
  drawingId,
  emitFilesDeltaIfNeeded,
  isReady,
  refs,
  resolveSafeSnapshot,
  broadcastChanges,
}: UseEditorCanvasHandlersParams) => {
  const handleCanvasChange = useCallback(
    (elements: readonly any[], appState: any, files?: Record<string, any>) => {
      if (!canEdit) return;
      if (refs.isUnmounting.current) return;
      if (refs.isSyncing.current) return;
      refs.latestAppState.current = appState;
      const currentFiles =
        files || refs.excalidrawAPI.current?.getFiles() || {};
      if (Object.keys(currentFiles).length > 0) {
        refs.latestFiles.current = currentFiles;
      }
      const allElements = refs.excalidrawAPI.current
        ? refs.excalidrawAPI.current.getSceneElementsIncludingDeleted()
        : elements;
      if (!refs.hasHydratedInitialScene.current) {
        const matchesInitialSnapshot = haveSameElements(
          allElements,
          refs.initialSceneElements.current,
        );
        const transientHydrationEmpty = isSuspiciousEmptySnapshot(
          refs.initialSceneElements.current,
          allElements,
        );
        const transientHydrationNonRenderable = isStaleNonRenderableSnapshot(
          refs.initialSceneElements.current,
          allElements,
        );
        if (transientHydrationEmpty || transientHydrationNonRenderable) return;
        refs.hasHydratedInitialScene.current = true;
        refs.isBootstrappingScene.current = false;
        if (matchesInitialSnapshot) return;
      }
      const { prevented: preventedCanvasOverwrite } =
        resolveSafeSnapshot(allElements);
      if (preventedCanvasOverwrite) return;
      const hasRenderable = hasRenderableElements(allElements);
      if (hasRenderable && refs.suspiciousBlankLoad.current) {
        refs.suspiciousBlankLoad.current = false;
      }
      if (refs.isBootstrappingScene.current && !hasRenderable) return;
      refs.latestElements.current = allElements;
      broadcastChanges(allElements, currentFiles);
    },
    [broadcastChanges, canEdit, refs, resolveSafeSnapshot],
  );

  const handleCanvasDropCapture = useCallback(
    async (event: React.DragEvent<HTMLDivElement>) => {
      if (!canEdit || !refs.excalidrawAPI.current) return;
      const allDroppedFiles = Array.from(event.dataTransfer?.files || []);
      const droppedImages = getDroppedImageFiles(event.dataTransfer);
      if (
        droppedImages.length <= 1 ||
        droppedImages.length !== allDroppedFiles.length
      ) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const appState = refs.excalidrawAPI.current.getAppState?.();
      if (!appState) return;
      try {
        const dropPoint = viewportCoordsToSceneCoords(
          { clientX: event.clientX, clientY: event.clientY },
          appState,
        );
        const loadedImages = await Promise.all(
          droppedImages.map(loadDroppedImageData),
        );
        if (loadedImages.length === 0) return;
        refs.excalidrawAPI.current.addFiles(
          loadedImages.map(({ fileId, mimeType, dataURL, created }) => ({
            id: fileId,
            mimeType,
            dataURL,
            created,
          })),
        );
        let nextY = dropPoint.y;
        const imageElements = convertToExcalidrawElements(
          loadedImages.map((image, index) => {
            const y = index === 0 ? dropPoint.y - image.height / 2 : nextY;
            nextY = y + image.height + MULTI_IMAGE_DROP_GAP;
            return {
              type: "image" as const,
              x: dropPoint.x - image.width / 2,
              y,
              width: image.width,
              height: image.height,
              fileId: image.fileId as any,
              scale: [1, 1] as [number, number],
              status: "saved" as const,
            };
          }),
        );
        refs.excalidrawAPI.current.updateScene({
          elements: [
            ...refs.excalidrawAPI.current.getSceneElementsIncludingDeleted(),
            ...imageElements,
          ],
          appState: {
            selectedElementIds: Object.fromEntries(
              imageElements.map((element: any) => [element.id, true]),
            ),
          },
          captureUpdate: CaptureUpdateAction.IMMEDIATELY,
        });
      } catch (err) {
        console.error("[Editor] Failed to import dropped images", err);
        toast.error("Failed to import dropped images");
      }
    },
    [canEdit, refs],
  );

  useEffect(() => {
    if (!drawingId || !isReady) return;
    const interval = window.setInterval(() => {
      if (refs.isUnmounting.current) return;
      if (refs.isSyncing.current) return;
      if (!refs.excalidrawAPI.current) return;
      const nextFiles = refs.excalidrawAPI.current.getFiles?.() || {};
      const didEmit = emitFilesDeltaIfNeeded(nextFiles);
      if (
        didEmit &&
        refs.latestAppState.current &&
        refs.debouncedSave.current
      ) {
        refs.hasSceneChangesSinceLoad.current = true;
        refs.lastLocalChangeAt.current = Date.now();
        refs.debouncedSave.current(
          drawingId,
          refs.latestElements.current,
          refs.latestAppState.current,
          nextFiles,
        );
        debouncedSavePreview(drawingId);
      }
    }, 1000);
    return () => window.clearInterval(interval);
  }, [debouncedSavePreview, drawingId, emitFilesDeltaIfNeeded, isReady, refs]);

  return { handleCanvasChange, handleCanvasDropCapture };
};
