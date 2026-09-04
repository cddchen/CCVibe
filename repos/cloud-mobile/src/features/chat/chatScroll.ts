export const CHAT_BOTTOM_THRESHOLD_PX = 72;

export function chatDistanceFromEnd(contentHeight: number, viewportHeight: number, offsetY: number): number {
  return Math.max(0, contentHeight - viewportHeight - offsetY);
}

export function isChatAtBottom(contentHeight: number, viewportHeight: number, offsetY: number): boolean {
  return chatDistanceFromEnd(contentHeight, viewportHeight, offsetY) <= CHAT_BOTTOM_THRESHOLD_PX;
}

export function shouldFollowActiveStream(active: boolean, atBottom: boolean): boolean {
  return active && atBottom;
}

export interface ChatScrollMetrics { readonly contentHeight: number; readonly offsetY: number; readonly viewportHeight: number; }
export function hasMeasuredChatViewport(metrics: ChatScrollMetrics): boolean { return metrics.viewportHeight > 0 && metrics.contentHeight > 0; }
export function atBottomFromMetrics(metrics: ChatScrollMetrics): boolean | undefined {
  return hasMeasuredChatViewport(metrics) ? isChatAtBottom(metrics.contentHeight, metrics.viewportHeight, metrics.offsetY) : undefined;
}

/** Exact offset whose viewport includes content-container bottom padding. */
export function chatBottomOffset(metrics: ChatScrollMetrics): number | undefined {
  return metrics.viewportHeight > 0
    ? Math.max(0, metrics.contentHeight - metrics.viewportHeight)
    : undefined;
}

export interface ChatBottomMeasurementContext {
  readonly activeReply: boolean;
  readonly currentlyAtBottom: boolean;
  readonly measuredAtBottom: boolean;
  readonly programmaticScrollPending: boolean;
  readonly userInteracting: boolean;
}

/**
 * Ignore stale passive scroll events while a pinned stream is growing. Only a
 * real reader gesture is allowed to release the live bottom-follow latch.
 */
export function shouldCommitChatBottomMeasurement(context: ChatBottomMeasurementContext): boolean {
  if (context.measuredAtBottom || context.userInteracting) return true;
  if (context.programmaticScrollPending) return false;
  return !(context.activeReply && context.currentlyAtBottom);
}
