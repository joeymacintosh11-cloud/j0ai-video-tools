import { useRef, useState } from "react";
import type { TrackAssetKind } from "../../core/domain/api/views.ts";
import { ApiRequestError, uploadTrackAsset } from "../api/client.ts";
import { ErrorBanner } from "./ErrorBanner.tsx";

const ACCEPT: Record<TrackAssetKind, string> = {
  cover: ".png,image/png",
  beat: ".wav,audio/wav",
};

const DESCRIPTION: Record<TrackAssetKind, string> = {
  cover: "PNG cover art — drop it here or click to choose",
  beat: "WAV audio — drop it here or click to choose",
};

const asApiError = (cause: unknown): ApiRequestError =>
  cause instanceof ApiRequestError
    ? cause
    : new ApiRequestError(0, {
        code: "INTERNAL_ERROR",
        message: cause instanceof Error ? cause.message : String(cause),
      });

/**
 * Uploads one of a track's two files.
 *
 * Nothing is inspected client-side: the server checks the content type, the
 * format signature and the size limit, and refuses to write anything it does
 * not recognise. So this only has to hand over the file and report the answer.
 */
export const AssetDropZone: React.FC<{
  readonly slug: string;
  readonly kind: TrackAssetKind;
  readonly present: boolean;
  readonly onUploaded: () => void;
}> = ({ slug, kind, present, onUploaded }) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<ApiRequestError | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const upload = async (file: File) => {
    setUploading(true);
    setError(null);
    setNote(null);

    try {
      const result = await uploadTrackAsset(slug, kind, file);

      setNote(
        `${result.replaced ? "Replaced" : "Saved"} ${result.path} (${(
          result.bytes /
          (1024 * 1024)
        ).toFixed(1)} MB)`,
      );
      onUploaded();
    } catch (cause) {
      setError(asApiError(cause));
    } finally {
      setUploading(false);
    }
  };

  const onFiles = (files: FileList | null) => {
    const file = files?.[0];

    if (file) {
      void upload(file);
    }
  };

  return (
    <div className="dropzone-wrap">
      <button
        type="button"
        className={`dropzone${dragging ? " dropzone--active" : ""}${
          uploading ? " dropzone--busy" : ""
        }`}
        disabled={uploading}
        onClick={() => inputRef.current?.click()}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          onFiles(event.dataTransfer.files);
        }}
      >
        <span className="dropzone__kind">
          {kind === "cover" ? "Cover" : "Audio"}
          {present ? <span className="dropzone__have"> · present</span> : null}
        </span>
        <span className="dropzone__hint">
          {uploading
            ? "Uploading…"
            : present
              ? `Replace — ${DESCRIPTION[kind]}`
              : DESCRIPTION[kind]}
        </span>
      </button>

      <input
        ref={inputRef}
        className="dropzone__input"
        type="file"
        accept={ACCEPT[kind]}
        onChange={(event) => {
          onFiles(event.target.files);
          // Allow re-picking the same file after a failure.
          event.target.value = "";
        }}
      />

      {note ? <p className="dropzone__note">{note}</p> : null}
      {error ? <ErrorBanner error={error} title="Upload failed" /> : null}
    </div>
  );
};
