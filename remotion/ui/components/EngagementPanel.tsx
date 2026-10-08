import { useEffect, useReducer, useRef, useState } from "react";
import type { TrackDetailView } from "../../core/domain/api/views.ts";
import {
  CAPTION_STYLES,
  CAPTION_STYLE_LABELS,
  ENGAGEMENT_PLATFORMS,
  ENGAGEMENT_PLATFORM_LABELS,
  type CaptionStyle,
  type EngagementHookId,
  type EngagementPlatform,
} from "../../core/domain/content/engagementOptimizer.ts";
import { ApiRequestError, updateTrackMetadata } from "../api/client.ts";
import { copyToClipboard } from "../api/clipboard.ts";
import { ErrorBanner } from "./ErrorBanner.tsx";
import {
  CHECK_MARKS,
  engagementPlanFor,
  engagementSyncReducer,
  engagementSyncView,
  INITIAL_ENGAGEMENT_SYNC,
  nextTabIndex,
  selectionPatch,
} from "./engagementModel.ts";

/**
 * Engagement Optimizer: three hooks, three caption styles, platform CTAs and
 * a pre-export checklist for Instagram Reels, TikTok and YouTube Shorts.
 *
 * Suggestions are deterministic templates over the track's own details. The
 * chosen hook and caption style are saved with the track's metadata (a
 * normal, revision-checked metadata save) and are copy only: nothing here
 * renders, re-renders, exports or changes what any export contains.
 *
 * Saving is coordinated by engagementSyncReducer (engagementModel.ts): one
 * save per track at a time, each based on the newest confirmed revision, and
 * the choices shown are always saved ones.
 */

const asApiError = (cause: unknown): ApiRequestError =>
  cause instanceof ApiRequestError
    ? cause
    : new ApiRequestError(0, { code: "INTERNAL_ERROR", message: cause instanceof Error ? cause.message : String(cause) });

const COPY_FEEDBACK_MS = 2000;

/**
 * Never claims a copy before the clipboard confirms it. The feedback belongs
 * to the text that was copied: new text resets it, and no timer outlives the
 * button.
 */
const CopyText: React.FC<{ readonly label: string; readonly text: string }> = ({ label, text }) => {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestText = useRef(text);
  latestText.current = text;
  const clearTimer = () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  };

  useEffect(() => {
    setState("idle");
    clearTimer();
  }, [text]);
  useEffect(() => clearTimer, []);

  return (
    <button
      type="button"
      className="button button--quiet button--tiny"
      aria-label={label}
      onClick={() => {
        const copied = text;
        void copyToClipboard(copied).then((ok) => {
          // The text changed while the clipboard answered: that result is not this text's.
          if (copied !== latestText.current) return;
          clearTimer();
          setState(ok ? "copied" : "failed");
          timer.current = setTimeout(() => setState("idle"), COPY_FEEDBACK_MS);
        });
      }}
    >
      {state === "copied" ? "Copied" : state === "failed" ? "Couldn't copy — try again" : label}
    </button>
  );
};

export const EngagementPanel: React.FC<{
  readonly track: TrackDetailView;
  readonly onChanged: () => void;
}> = ({ track, onChanged }) => {
  const [platform, setPlatform] = useState<EngagementPlatform>("instagram-reels");
  const [sync, dispatch] = useReducer(engagementSyncReducer, INITIAL_ENGAGEMENT_SYNC);
  const [failure, setFailure] = useState<{ readonly slug: string; readonly error: ApiRequestError } | null>(null);
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const requests = useRef(0);
  /** Synchronous guard: a second click can land before the disabled state renders. */
  const inFlight = useRef<string | null>(null);
  /** The track shown right now, for results that arrive later. */
  const current = useRef({ slug: track.slug, revision: track.metadataRevision });
  current.current = { slug: track.slug, revision: track.metadataRevision };

  useEffect(() => {
    dispatch({ type: "synced", slug: track.slug, revision: track.metadataRevision });
  }, [track.slug, track.metadataRevision]);

  const view = engagementSyncView(sync, track);
  const plan = engagementPlanFor(track, platform, view.engagement);
  if (plan === null) {
    return (
      <p className="muted">
        Fix the track&apos;s title, artist, key and BPM under Track info; hooks and captions are built from them.
      </p>
    );
  }

  const choose = async (change: { readonly hook?: EngagementHookId; readonly captionStyle?: CaptionStyle }) => {
    const slug = track.slug;
    if (view.locked || inFlight.current === slug) return;
    const requestId = ++requests.current;
    inFlight.current = slug;
    dispatch({ type: "started", slug, requestId });
    setFailure(null);
    try {
      const saved = await updateTrackMetadata(slug, selectionPatch(view.engagement, change), view.revision);
      dispatch({
        type: "succeeded",
        slug,
        requestId,
        baseRevision: view.revision,
        currentSlug: current.current.slug,
        currentRevision: current.current.revision,
        revision: saved.metadataRevision,
        engagement: saved.metadata?.engagement,
      });
      onChanged();
    } catch (cause) {
      const error = asApiError(cause);
      dispatch({ type: "failed", slug, requestId, conflict: error.code === "METADATA_CONFLICT" });
      if (current.current.slug === slug) setFailure({ slug, error });
      // Someone else saved first: re-read so the next attempt starts from their revision.
      if (error.code === "METADATA_CONFLICT") onChanged();
    } finally {
      if (inFlight.current === slug) inFlight.current = null;
    }
  };

  const caption = plan.captions[plan.captionStyle];
  const tabId = (id: EngagementPlatform) => `engagement-tab-${track.slug}-${id}`;
  const panelId = `engagement-panel-${track.slug}`;
  const selectTab = (index: number) => {
    setPlatform(ENGAGEMENT_PLATFORMS[index]);
    tabs.current[index]?.focus();
  };

  return (
    <div className="engagement" aria-busy={view.locked}>
      {failure !== null && failure.slug === track.slug ? (
        <ErrorBanner error={failure.error} title="Could not save the engagement choice" />
      ) : null}

      <fieldset className="engagement__group" disabled={view.locked}>
        <legend className="field__label">Hook — the first second{view.locked ? " · saving…" : ""}</legend>
        {plan.hooks.map((hook) => (
          <label key={hook.id} className="engagement__option">
            <input
              type="radio"
              name={`hook-${track.slug}`}
              checked={plan.selectedHook?.id === hook.id}
              onChange={() => void choose({ hook: hook.id })}
            />
            <span>
              <strong>{hook.text}</strong>
              <span className="muted"> · {hook.label}. {hook.rationale}</span>
            </span>
          </label>
        ))}
        <p className="field__hint">
          Use it as on-screen text in the opening second and as the caption&apos;s first line. V1 does not draw it into
          the rendered video, so choosing one never re-renders or stales an export.
        </p>
      </fieldset>

      <fieldset className="engagement__group" disabled={view.locked}>
        <legend className="field__label">Caption style</legend>
        {CAPTION_STYLES.map((style) => (
          <label key={style} className="engagement__option">
            <input
              type="radio"
              name={`caption-style-${track.slug}`}
              checked={plan.captionStyle === style}
              onChange={() => void choose({ captionStyle: style })}
            />
            <span>{CAPTION_STYLE_LABELS[style]}</span>
          </label>
        ))}
      </fieldset>

      <div className="form__actions" role="tablist" aria-label="Platform">
        {ENGAGEMENT_PLATFORMS.map((id, index) => (
          <button
            key={id}
            ref={(element) => {
              tabs.current[index] = element;
            }}
            id={tabId(id)}
            type="button"
            role="tab"
            aria-selected={platform === id}
            aria-controls={panelId}
            tabIndex={platform === id ? 0 : -1}
            className={platform === id ? "button" : "button button--quiet"}
            onClick={() => setPlatform(id)}
            onKeyDown={(event) => {
              const next = nextTabIndex(index, event.key, ENGAGEMENT_PLATFORMS.length);
              if (next === null) return;
              event.preventDefault();
              selectTab(next);
            }}
          >
            {ENGAGEMENT_PLATFORM_LABELS[id]}
          </button>
        ))}
      </div>

      <div className="engagement" role="tabpanel" id={panelId} aria-labelledby={tabId(platform)}>
        <label className="field">
          <span className="field__label">
            {ENGAGEMENT_PLATFORM_LABELS[platform]} caption · {plan.captionStyle}
            {plan.selectedHook === null ? " (previewing the first hook until you choose one)" : ""}
          </span>
          <textarea className="field__input" rows={7} readOnly value={caption.text} />
        </label>
        <div className="form__actions">
          <CopyText label="Copy caption" text={caption.text} />
        </div>

        <div>
          <span className="field__label">Calls to action for {ENGAGEMENT_PLATFORM_LABELS[platform]}</span>
          <ul className="engagement__list">
            {CAPTION_STYLES.map((style) => (
              <li key={style}>
                <span className="muted">{style}: </span>
                {plan.ctas[style]} <CopyText label="Copy" text={plan.ctas[style]} />
              </li>
            ))}
          </ul>
        </div>

        <div>
          <span className="field__label">Pre-export checklist</span>
          <ul className="engagement__list" aria-label="Pre-export checklist">
            {plan.checklist.map((item) => (
              <li key={item.id} className={`engagement__check engagement__check--${item.status}`}>
                <span aria-hidden="true">{CHECK_MARKS[item.status]}</span> <strong>{item.label}</strong>{" "}
                <span className="muted">{item.detail}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
};
