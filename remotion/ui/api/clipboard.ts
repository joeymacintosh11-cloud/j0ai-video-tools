/**
 * The one place this app writes to the system clipboard.
 *
 * `navigator.clipboard.writeText` is itself a promise that can reject (no
 * permission, no secure context, an empty/unfocused document) — this never
 * reports success before that promise actually resolves, and never invents
 * a generic success when it did not. Callers get a plain boolean rather than
 * a thrown error because a failed copy is an ordinary, expected outcome
 * here (the user just clicks again, or copies manually), not a bug to
 * surface as an error banner.
 */
export const copyToClipboard = async (text: string): Promise<boolean> => {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
};
