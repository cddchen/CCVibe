/**
 * A deferred transcript can briefly expose an empty list after the Host has
 * already provided turns. Keep that frame in a loading state instead of
 * announcing that the user is waiting for their first message.
 */
export function shouldShowDeferredTranscriptLoading(
  deferredTurnCount: number,
  currentTurnCount: number,
  awaitingSince: string | undefined,
  failed: boolean,
): boolean {
  return !failed
    && awaitingSince === undefined
    && deferredTurnCount === 0
    && currentTurnCount > 0;
}
