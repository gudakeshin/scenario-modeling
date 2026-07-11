"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize from "rehype-sanitize";
import type { Components } from "react-markdown";

const components: Components = {
  p: ({ children }) => <p className="mb-2 last:mb-0 leading-relaxed">{children}</p>,
  strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  ul: ({ children }) => <ul className="mb-2 last:mb-0 ml-4 list-disc space-y-1">{children}</ul>,
  ol: ({ children }) => <ol className="mb-2 last:mb-0 ml-4 list-decimal space-y-1">{children}</ol>,
  li: ({ children }) => <li className="leading-relaxed">{children}</li>,
  a: ({ children, href }) => (
    <a href={href} target="_blank" rel="noopener noreferrer" className="underline text-accent hover:text-accent-hover break-words">
      {children}
    </a>
  ),
  code: ({ children, className }) => {
    const isBlock = className?.includes("language-");
    return isBlock ? (
      <code className={`block ${className || ""}`}>{children}</code>
    ) : (
      <code className="px-1 py-0.5 rounded bg-black/10 dark:bg-white/10 text-[13px] font-mono">{children}</code>
    );
  },
  pre: ({ children }) => (
    <pre className="mb-2 last:mb-0 p-3 rounded-lg bg-black/10 dark:bg-white/10 overflow-x-auto text-[13px] font-mono">
      {children}
    </pre>
  ),
  h1: ({ children }) => <h1 className="text-base font-semibold mb-2 mt-1">{children}</h1>,
  h2: ({ children }) => <h2 className="text-[15px] font-semibold mb-2 mt-1">{children}</h2>,
  h3: ({ children }) => <h3 className="text-[15px] font-semibold mb-1 mt-1">{children}</h3>,
  blockquote: ({ children }) => (
    <blockquote className="border-l-2 border-current/30 pl-3 italic opacity-90 mb-2 last:mb-0">{children}</blockquote>
  ),
  table: ({ children }) => (
    <div className="overflow-x-auto mb-2 last:mb-0">
      <table className="text-[13px] border-collapse w-full">{children}</table>
    </div>
  ),
  th: ({ children }) => <th className="border border-current/20 px-2 py-1 text-left font-semibold">{children}</th>,
  td: ({ children }) => <td className="border border-current/20 px-2 py-1">{children}</td>,
  hr: () => <hr className="my-2 border-current/20" />,
};

export function MarkdownContent({ content, className = "" }: { content: string; className?: string }) {
  return (
    <div className={`leading-relaxed break-words ${className}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]} components={components}>
        {content}
      </ReactMarkdown>
    </div>
  );
}
