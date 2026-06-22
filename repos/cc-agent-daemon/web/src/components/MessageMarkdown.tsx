import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

type Props = {
  content: string;
  className?: string;
};

function MessageMarkdownInner({ content, className = "" }: Props) {
  return (
    <div
      className={`prose prose-sm max-w-none min-w-0 overflow-hidden break-words dark:prose-invert
        prose-p:my-2 prose-li:my-0.5 prose-pre:my-3 prose-headings:tracking-tight
        prose-pre:border prose-pre:border-zinc-200 prose-pre:bg-zinc-100 dark:prose-pre:border-zinc-700 dark:prose-pre:bg-zinc-950
        prose-code:rounded prose-code:bg-zinc-100 prose-code:px-1 prose-code:py-0.5 prose-code:text-violet-700 dark:prose-code:bg-zinc-900/80 dark:prose-code:text-violet-200
        prose-a:text-violet-700 dark:prose-a:text-violet-400 prose-img:my-3 ${className}`}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer noopener">
              {children}
            </a>
          ),
          img: ({ src, alt }) => (
            <img
              src={src ?? ""}
              alt={alt ?? ""}
              loading="lazy"
              className="max-h-[420px] rounded-2xl border border-zinc-200 object-contain shadow-sm dark:border-zinc-700"
            />
          ),
          pre: ({ children }) => (
            <pre className="overflow-x-auto rounded-2xl p-3 text-xs leading-relaxed max-w-full">
              {children}
            </pre>
          ),
          table: ({ children }) => (
            <div className="my-3 overflow-x-auto rounded-xl border border-zinc-200 dark:border-zinc-700">
              <table className="my-0 min-w-full">{children}</table>
            </div>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

export const MessageMarkdown = memo(MessageMarkdownInner);
