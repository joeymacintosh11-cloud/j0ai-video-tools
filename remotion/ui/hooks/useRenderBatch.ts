import { useEffect, useRef, useState } from "react";
import type { RenderBatchView } from "../../src/domain/api/views.ts";
import { getRenderBatch, renderBatchEventsUrl } from "../api/client.ts";

/**
 * Follows a batch's aggregate over Server-Sent Events.
 *
 * The server sends the current state on connect, so this needs no initial
 * fetch and a reload mid-batch resumes from the truth. Every number comes from
 * the server's own aggregation of real job progress.
 *
 * Batch records live in the server's memory, so a restart forgets them; a batch
 * that has gone is reported rather than left on a stale bar.
 */
export type RenderBatchState = {
  readonly batch: RenderBatchView | null;
  readonly missing: boolean;
};

export const useRenderBatch = (
  batchId: string | null,
  onSettled: () => void,
): RenderBatchState => {
  const [batch, setBatch] = useState<RenderBatchView | null>(null);
  const [missing, setMissing] = useState(false);

  // Held in a ref so a changing callback does not reconnect the stream.
  const settledRef = useRef(onSettled);
  settledRef.current = onSettled;

  useEffect(() => {
    if (batchId === null) {
      setBatch(null);
      setMissing(false);
      return;
    }

    setMissing(false);

    const source = new EventSource(renderBatchEventsUrl(batchId));

    const onBatch = (event: MessageEvent<string>) => {
      setBatch(JSON.parse(event.data) as RenderBatchView);
    };

    source.addEventListener("batch", onBatch);
    source.addEventListener("finished", (event: MessageEvent<string>) => {
      setBatch(JSON.parse(event.data) as RenderBatchView);
      // Outputs now exist on disk, so the track list and detail are stale.
      settledRef.current();
    });

    // EventSource retries by itself, which is wrong for a batch that no longer
    // exists. Ask once: if it is genuinely gone, stop.
    source.addEventListener("error", () => {
      void getRenderBatch(batchId)
        .then((current) => {
          setBatch(current);
        })
        .catch(() => {
          setMissing(true);
          source.close();
        });
    });

    return () => {
      source.close();
    };
  }, [batchId]);

  return { batch, missing };
};
