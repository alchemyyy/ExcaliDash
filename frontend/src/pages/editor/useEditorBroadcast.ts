import { useEffect, useMemo } from "react";
import type { MutableRefObject } from "react";
import throttle from "lodash/throttle";
import { getFilesDelta } from "./shared";

type UseEditorBroadcastParams = {
  drawingId: string | undefined;
  excalidrawAPI: MutableRefObject<any>;
  lastLocalChangeAt: MutableRefObject<number>;
  lastSyncedElementOrderSig: MutableRefObject<string>;
  lastSyncedFiles: MutableRefObject<Record<string, any>>;
  latestAppState: MutableRefObject<any>;
  latestFiles: MutableRefObject<any>;
  socketMe: MutableRefObject<{ id: string }>;
  socket: MutableRefObject<any>;
  debouncedSave: (
    drawingId: string,
    elements: readonly any[],
    appState: any,
    files?: Record<string, any>,
  ) => void;
  debouncedSavePreview: (drawingId: string) => void;
  computeElementOrderSig: (elements: readonly any[]) => string;
  hasElementChanged: (element: any) => boolean;
  normalizeImageElementStatus: (
    elements?: readonly any[],
    files?: Record<string, any> | null,
  ) => readonly any[];
  recordElementVersion: (element: any) => void;
  setHasSceneChangesSinceLoad: () => void;
};

export const useEditorBroadcast = ({
  drawingId,
  excalidrawAPI,
  lastLocalChangeAt,
  lastSyncedElementOrderSig,
  lastSyncedFiles,
  latestAppState,
  latestFiles,
  socketMe,
  socket,
  debouncedSave,
  debouncedSavePreview,
  computeElementOrderSig,
  hasElementChanged,
  normalizeImageElementStatus,
  recordElementVersion,
  setHasSceneChangesSinceLoad,
}: UseEditorBroadcastParams) => {
  const broadcastChanges = useMemo(
    () =>
      throttle(
        (elements: readonly any[], currentFiles?: Record<string, any>) => {
          if (!socket.current || !drawingId) return;
          const changes: any[] = [];
          const nextFiles =
            currentFiles || excalidrawAPI.current?.getFiles() || {};
          const normalizedElements = normalizeImageElementStatus(
            elements,
            nextFiles,
          );
          const nextOrderSig = computeElementOrderSig(normalizedElements);
          const shouldSyncOrder =
            nextOrderSig !== lastSyncedElementOrderSig.current;
          if (shouldSyncOrder) {
            lastSyncedElementOrderSig.current = nextOrderSig;
          }
          normalizedElements.forEach((el) => {
            if (hasElementChanged(el)) {
              changes.push(el);
              recordElementVersion(el);
            }
          });
          const filesDelta = getFilesDelta(lastSyncedFiles.current, nextFiles);
          const shouldSyncFiles = Object.keys(filesDelta).length > 0;
          if (Object.keys(nextFiles || {}).length > 0) {
            latestFiles.current = nextFiles;
          }
          if (shouldSyncFiles) {
            lastSyncedFiles.current = nextFiles;
          }
          if (changes.length > 0 || shouldSyncFiles || shouldSyncOrder) {
            setHasSceneChangesSinceLoad();
            lastLocalChangeAt.current = Date.now();
            socket.current.emit("element-update", {
              drawingId,
              elements: changes.length > 0 ? changes : [],
              files: shouldSyncFiles ? filesDelta : undefined,
              elementOrder: shouldSyncOrder
                ? normalizedElements.map((el: any) => el?.id).filter(Boolean)
                : undefined,
              userId: socketMe.current.id,
            });
            const appState = latestAppState.current;
            if (appState) {
              debouncedSave(drawingId, normalizedElements, appState, nextFiles);
              debouncedSavePreview(drawingId);
            }
          }
        },
        100,
        { leading: true, trailing: true },
      ),
    [
      computeElementOrderSig,
      debouncedSave,
      debouncedSavePreview,
      drawingId,
      excalidrawAPI,
      hasElementChanged,
      lastLocalChangeAt,
      lastSyncedElementOrderSig,
      lastSyncedFiles,
      latestAppState,
      latestFiles,
      normalizeImageElementStatus,
      recordElementVersion,
      setHasSceneChangesSinceLoad,
      socket,
      socketMe,
    ],
  );

  useEffect(() => () => broadcastChanges.cancel(), [broadcastChanges]);

  return broadcastChanges;
};
