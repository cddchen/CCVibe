type Variant = "inline" | "bubble" | "footer";

type Props = {
  variant?: Variant;
  label?: string;
};

/** CUI-style model reply / thinking feedback */
export function ModelReplyFeedback({ variant = "inline", label = "正在回复" }: Props) {
  const dots = (
    <span className="inline-flex items-center gap-1" aria-hidden>
      <span className="model-reply-dot" style={{ animationDelay: "0ms" }} />
      <span className="model-reply-dot" style={{ animationDelay: "160ms" }} />
      <span className="model-reply-dot" style={{ animationDelay: "320ms" }} />
    </span>
  );

  if (variant === "footer") {
    return (
      <div className="flex items-center gap-2 px-1 py-1 text-xs text-zinc-500">
        {dots}
        <span className="model-reply-shimmer">{label}</span>
      </div>
    );
  }

  if (variant === "bubble") {
    return (
      <div className="flex items-center gap-3 py-1">
        <div className="relative flex h-8 w-8 items-center justify-center">
          <span className="absolute inset-0 rounded-full bg-violet-500/20 model-reply-ring" />
          <span className="relative text-violet-400">{dots}</span>
        </div>
        <span className="text-sm text-zinc-400 model-reply-shimmer">{label}</span>
      </div>
    );
  }

  return (
    <span className="inline-flex items-center gap-2 text-zinc-500 text-sm italic">
      {dots}
      <span>{label}</span>
    </span>
  );
}

export function StreamingCursor() {
  return <span className="model-reply-cursor" aria-hidden />;
}