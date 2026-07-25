type Props = {
  message: string;
  onClose: () => void;
};

export function ErrorToast({ message, onClose }: Props) {
  return (
    <div
      role="alert"
      aria-live="assertive"
      className="fixed right-4 top-4 z-[80] w-[min(26rem,calc(100vw-2rem))] rounded-2xl border border-red-200 bg-white/95 p-4 text-red-800 shadow-2xl shadow-red-950/10 backdrop-blur dark:border-red-900/70 dark:bg-zinc-900/95 dark:text-red-200"
    >
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-red-100 text-sm font-bold text-red-600 dark:bg-red-950 dark:text-red-300">!</span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold">操作失败</div>
          <div className="mt-1 whitespace-pre-wrap break-words text-xs leading-relaxed text-red-700 dark:text-red-300">{message}</div>
        </div>
        <button
          type="button"
          aria-label="关闭错误提示"
          className="rounded-lg px-2 py-1 text-sm text-red-400 hover:bg-red-50 hover:text-red-700 dark:hover:bg-red-950/50 dark:hover:text-red-200"
          onClick={onClose}
        >
          ×
        </button>
      </div>
    </div>
  );
}
