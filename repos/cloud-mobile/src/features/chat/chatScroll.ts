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
